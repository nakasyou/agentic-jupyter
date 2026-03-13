import type {
  ConnectVscodeHostInput,
  ExecutionStreamEvent,
  VscodeHostCapabilities,
} from '../core/index.js'
import { RemoteJupyterError } from '../core/index.js'
import { VscodeHostClient } from './client.js'

interface VscodeHostConnection {
  id: string
  client: VscodeHostClient
}

export class VscodeHostConnectionRegistry {
  private readonly connections = new Map<string, VscodeHostConnection>()

  async connect(input: ConnectVscodeHostInput) {
    const id = crypto.randomUUID()
    const client = new VscodeHostClient(input, () => {
      this.connections.delete(id)
    })
    const handshake = await client.connect()
    this.connections.set(id, { id, client })
    return {
      connection_id: id,
      backend: 'vscode-host' as const,
      host: input.host ?? '127.0.0.1',
      port: input.port,
      capabilities: handshake.capabilities,
    }
  }

  get(connectionId: string): VscodeHostConnection {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new RemoteJupyterError('not_found', `Unknown connection_id: ${connectionId}`)
    }
    return connection
  }

  async disconnect(connectionId: string) {
    const connection = this.get(connectionId)
    this.connections.delete(connectionId)
    await connection.client.disconnect()
    return {
      connection_id: connectionId,
      backend: 'vscode-host' as const,
      disconnected: true,
    }
  }

  async getStatus(connectionId: string) {
    const connection = this.get(connectionId)
    const status = (await connection.client.request('get_connection_status', {})) as {
      capabilities?: VscodeHostCapabilities
    }
    return {
      connection_id: connectionId,
      backend: 'vscode-host' as const,
      host: connection.client.host,
      port: connection.client.port,
      capabilities: status.capabilities,
    }
  }

  async request(connectionId: string, method: string, params: Record<string, unknown>) {
    const connection = this.get(connectionId)
    return await connection.client.request(method, params)
  }

  async requestStream(
    connectionId: string,
    method: string,
    params: Record<string, unknown>,
    onEvent: (event: ExecutionStreamEvent) => void,
  ) {
    const connection = this.get(connectionId)
    return await connection.client.requestStream(method, params, onEvent)
  }
}
