import WebSocket from 'ws'
import {
  HOST_STREAM_EVENT_METHOD,
  rpcNotificationSchema,
  RemoteJupyterError,
  rpcErrorSchema,
  rpcRequestSchema,
  rpcSuccessSchema,
  type ConnectVscodeHostInput,
  type ExecutionStreamEvent,
  type HostHandshakeResult,
} from '../core/index.js'

const RPC_PATH = '/rpc'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type StreamHandler = (event: ExecutionStreamEvent) => void

export class VscodeHostClient {
  private socket?: WebSocket
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streamHandlers = new Map<string, StreamHandler>()
  private openPromise?: Promise<void>

  constructor(
    private readonly input: ConnectVscodeHostInput,
    private readonly onClose?: () => void,
  ) {}

  get host(): string {
    return this.input.host ?? '127.0.0.1'
  }

  get port(): number {
    return this.input.port
  }

  async connect(): Promise<HostHandshakeResult> {
    await this.ensureOpen()
    return (await this.request('host.handshake', {})) as HostHandshakeResult
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return
    }
    const socket = this.socket
    this.socket = undefined
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.close()
    })
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return await this.requestInternal(method, params)
  }

  async requestStream(
    method: string,
    params: Record<string, unknown>,
    onEvent: StreamHandler,
  ): Promise<unknown> {
    return await this.requestInternal(method, params, onEvent)
  }

  private async requestInternal(
    method: string,
    params?: unknown,
    onEvent?: StreamHandler,
  ): Promise<unknown> {
    await this.ensureOpen()
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new RemoteJupyterError('connection_failed', 'VS Code host socket is not open')
    }

    const id = crypto.randomUUID()
    const payload = rpcRequestSchema.parse({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })

    return await new Promise<unknown>((resolve, reject) => {
      if (onEvent) {
        this.streamHandlers.set(id, onEvent)
      }
      this.pending.set(id, { resolve, reject })
      socket.send(JSON.stringify(payload), (error) => {
        if (error) {
          this.pending.delete(id)
          this.streamHandlers.delete(id)
          reject(new RemoteJupyterError('remote_io_failed', error.message, { cause: error }))
        }
      })
    })
  }

  private async ensureOpen(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return
    }
    if (this.openPromise) {
      return await this.openPromise
    }

    this.openPromise = new Promise<void>((resolve, reject) => {
      const protocol = this.input.secure ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${this.host}:${this.port}${RPC_PATH}`, {
        headers: {
          Authorization: `Bearer ${this.input.token}`,
        },
      })

      const cleanup = () => {
        socket.removeAllListeners('open')
        socket.removeAllListeners('error')
      }

      socket.once('open', () => {
        cleanup()
        this.socket = socket
        socket.on('message', (data) => this.onMessage(data))
        socket.on('close', () => this.onSocketClose())
        socket.on('error', (error) => this.rejectAll(error))
        resolve()
      })

      socket.once('error', (error) => {
        cleanup()
        reject(new RemoteJupyterError('connection_failed', error.message, { cause: error }))
      })
    }).finally(() => {
      this.openPromise = undefined
    })

    return await this.openPromise
  }

  private onMessage(data: WebSocket.RawData): void {
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
    } catch (error) {
      this.rejectAll(error)
      return
    }

    const success = rpcSuccessSchema.safeParse(payload)
    if (success.success) {
      const pending = this.pending.get(String(success.data.id))
      if (!pending) {
        return
      }
      this.pending.delete(String(success.data.id))
      this.streamHandlers.delete(String(success.data.id))
      pending.resolve(success.data.result)
      return
    }

    const failure = rpcErrorSchema.safeParse(payload)
    if (failure.success) {
      const pending = this.pending.get(String(failure.data.id))
      if (!pending) {
        return
      }
      this.pending.delete(String(failure.data.id))
      this.streamHandlers.delete(String(failure.data.id))
      pending.reject(
        new RemoteJupyterError('remote_io_failed', failure.data.error.message, failure.data.error.data),
      )
      return
    }

    const notification = rpcNotificationSchema.safeParse(payload)
    if (notification.success && notification.data.method === HOST_STREAM_EVENT_METHOD) {
      const params = notification.data.params
      if (!params || typeof params !== 'object') {
        return
      }
      const requestId = (params as { request_id?: unknown }).request_id
      if (typeof requestId !== 'string') {
        return
      }
      const handler = this.streamHandlers.get(requestId)
      if (!handler) {
        return
      }
      handler(params as ExecutionStreamEvent)
      return
    }

    this.rejectAll(new RemoteJupyterError('invalid_request', 'Invalid JSON-RPC payload', payload))
  }

  private onSocketClose(): void {
    this.socket = undefined
    this.rejectAll(new RemoteJupyterError('connection_failed', 'VS Code host connection closed'))
    this.onClose?.()
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      this.streamHandlers.delete(id)
      pending.reject(error)
    }
  }
}
