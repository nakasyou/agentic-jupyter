import WebSocket from 'ws'
import { RemoteJupyterError } from '../core/index.js'
import type {
  CachedSession,
  ExecutionResult,
  JupyterApiInfo,
  JupyterCellOutput,
  JupyterContentModel,
  JupyterNotebook,
  JupyterNotebookContentModel,
  JupyterSessionModel,
} from '../core/index.js'

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function encodeJupyterPath(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function joinApiPath(pathname: string, path?: string): string {
  if (!path || path.length === 0) {
    return pathname
  }
  return `${pathname}/${encodeJupyterPath(path)}`
}

async function normalizeMessageData(data: unknown): Promise<string> {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof Buffer) {
    return data.toString('utf8')
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  return String(data)
}

export class JupyterClient {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token?: string,
    private readonly onAuthFailure?: () => void,
  ) {
    this.baseUrl = ensureTrailingSlash(baseUrl)
  }

  private headers(contentType = false): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }

    if (contentType) {
      headers['Content-Type'] = 'application/json'
    }

    if (this.token) {
      headers.Authorization = `token ${this.token}`
    }

    return headers
  }

  private url(
    pathname: string,
    search?: Record<string, string | number | boolean | undefined>,
  ): URL {
    const url = new URL(pathname, this.baseUrl)
    for (const [key, value] of Object.entries(search ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
    return url
  }

  async request<T>(
    method: string,
    pathname: string,
    options: {
      body?: unknown
      search?: Record<string, string | number | boolean | undefined>
    } = {},
  ): Promise<T> {
    const response = await fetch(this.url(pathname, options.search), {
      method,
      headers: this.headers(options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (response.status === 401 || response.status === 403) {
      this.onAuthFailure?.()
      throw new RemoteJupyterError('auth_failed', 'Jupyter authentication failed')
    }

    if (response.status === 404) {
      throw new RemoteJupyterError('not_found', `Jupyter resource not found: ${pathname}`)
    }

    if (!response.ok) {
      throw new RemoteJupyterError(
        'remote_io_failed',
        `Jupyter request failed: ${method} ${pathname} (${response.status})`,
        await safeReadJson(response),
      )
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  async getApiInfo(): Promise<JupyterApiInfo> {
    return await this.request('GET', 'api')
  }

  async listContents(path = ''): Promise<JupyterContentModel> {
    return await this.request('GET', joinApiPath('api/contents', path), {
      search: {
        content: 1,
      },
    })
  }

  async getContent(
    path: string,
    options: {
      content?: boolean
      format?: 'text' | 'base64' | 'json'
    } = {},
  ): Promise<JupyterContentModel> {
    return await this.request('GET', joinApiPath('api/contents', path), {
      search: {
        content: (options.content ?? true) ? 1 : 0,
        format: options.format,
      },
    })
  }

  async saveContent(path: string, model: Record<string, unknown>): Promise<JupyterContentModel> {
    return await this.request('PUT', joinApiPath('api/contents', path), {
      body: model,
    })
  }

  async ensureDirectory(path: string): Promise<void> {
    if (path === '' || path === '.' || path === '/') {
      return
    }

    const segments = path.split('/').filter((segment) => segment.length > 0 && segment !== '.')
    let current = ''

    for (const segment of segments) {
      current = current.length > 0 ? `${current}/${segment}` : segment
      try {
        const existing = await this.getContent(current, { content: false })
        if (existing.type !== 'directory') {
          throw new RemoteJupyterError(
            'remote_io_failed',
            `Path exists and is not a directory: ${current}`,
          )
        }
      } catch (error) {
        if (!(error instanceof RemoteJupyterError) || error.code !== 'not_found') {
          throw error
        }

        await this.saveContent(current, {
          path: current,
          type: 'directory',
        })
      }
    }
  }

  async getNotebook(path: string): Promise<JupyterNotebookContentModel> {
    const model = await this.getContent(path, {
      content: true,
    })

    if (model.type !== 'notebook' || !model.content) {
      throw new RemoteJupyterError('remote_io_failed', `Content is not a notebook: ${path}`)
    }

    return model
  }

  async saveNotebook(
    path: string,
    notebook: JupyterNotebook,
  ): Promise<JupyterNotebookContentModel> {
    const model = await this.saveContent(path, {
      path,
      type: 'notebook',
      content: notebook,
    })

    if (model.type !== 'notebook') {
      throw new RemoteJupyterError('remote_io_failed', `Saved content is not a notebook: ${path}`)
    }

    return model as JupyterNotebookContentModel
  }

  async listSessions(): Promise<JupyterSessionModel[]> {
    return await this.request('GET', 'api/sessions')
  }

  async ensureSession(path: string, kernelName: string): Promise<CachedSession> {
    const existingSessions = await this.listSessions()
    const existing = existingSessions.find((session) => session.path === path)

    if (existing) {
      return {
        sessionId: existing.id,
        kernelId: existing.kernel.id,
        kernelName: existing.kernel.name,
        path: existing.path,
      }
    }

    const created = await this.request<JupyterSessionModel>('POST', 'api/sessions', {
      body: {
        path,
        name: path.split('/').at(-1) ?? path,
        type: 'notebook',
        kernel: {
          name: kernelName,
        },
      },
    })

    return {
      sessionId: created.id,
      kernelId: created.kernel.id,
      kernelName: created.kernel.name,
      path: created.path,
    }
  }

  async executeCode(
    session: CachedSession,
    code: string,
    timeoutSec: number,
    onStream?: (stream: 'stdout' | 'stderr', text: string) => void,
  ): Promise<ExecutionResult> {
    const wsUrl = this.url(`api/kernels/${encodeURIComponent(session.kernelId)}/channels`)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'

    return await new Promise<ExecutionResult>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const executeSessionId = crypto.randomUUID()
      let executeReplyReceived = false
      let idleReceived = false
      let settled = false
      let executionCount: number | null = null
      const outputs: JupyterCellOutput[] = []
      const richOutputs: ExecutionResult['rich_outputs'] = []
      let stdout = ''
      let stderr = ''
      let status: 'ok' | 'error' = 'ok'
      let lastError: ExecutionResult['error']
      const timeout = setTimeout(() => {
        settled = true
        socket.close()
        reject(
          new RemoteJupyterError(
            'execution_timeout',
            `Jupyter execution timed out after ${timeoutSec} seconds`,
          ),
        )
      }, timeoutSec * 1000)

      const socket = new WebSocket(wsUrl.toString(), {
        headers: this.token ? { Authorization: `token ${this.token}` } : undefined,
      })

      const finish = () => {
        if (!executeReplyReceived || !idleReceived || settled) {
          return
        }

        settled = true
        clearTimeout(timeout)
        socket.close()
        resolve({
          status,
          stdout,
          stderr,
          rich_outputs: richOutputs,
          outputs,
          execution_count: executionCount,
          error: lastError,
        })
      }

      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            header: {
              msg_id: requestId,
              username: 'remote-jupyter-mcp',
              session: executeSessionId,
              msg_type: 'execute_request',
              version: '5.3',
            },
            parent_header: {},
            metadata: {},
            channel: 'shell',
            content: {
              code,
              silent: false,
              store_history: true,
              user_expressions: {},
              allow_stdin: false,
              stop_on_error: true,
            },
          }),
        )
      })

      socket.on('message', async (data) => {
        try {
          const payload = JSON.parse(await normalizeMessageData(data))
          if (payload.parent_header?.msg_id !== requestId) {
            return
          }
          const msgType = payload.header?.msg_type ?? payload.msg_type

          switch (msgType) {
            case 'stream': {
              const text = String(payload.content?.text ?? '')
              const name = payload.content?.name === 'stderr' ? 'stderr' : 'stdout'
              outputs.push({
                output_type: 'stream',
                name,
                text,
              })

              if (name === 'stderr') {
                stderr += text
              } else {
                stdout += text
              }
              onStream?.(name, text)
              break
            }
            case 'display_data':
            case 'execute_result': {
              const output = {
                output_type: msgType,
                data: payload.content?.data ?? {},
                metadata: payload.content?.metadata ?? {},
                execution_count:
                  msgType === 'execute_result'
                    ? (payload.content?.execution_count ?? null)
                    : undefined,
              } as const
              outputs.push(output)
              richOutputs.push(output)
              break
            }
            case 'error': {
              status = 'error'
              lastError = {
                ename: String(payload.content?.ename ?? 'Error'),
                evalue: String(payload.content?.evalue ?? ''),
                traceback: Array.isArray(payload.content?.traceback)
                  ? payload.content.traceback.map((entry: unknown) => String(entry))
                  : [],
              }
              outputs.push({
                output_type: 'error',
                ...lastError,
              })
              stderr += `${lastError.traceback.join('\n')}\n`
              break
            }
            case 'clear_output': {
              outputs.length = 0
              richOutputs.length = 0
              stdout = ''
              stderr = ''
              break
            }
            case 'execute_reply': {
              executeReplyReceived = true
              executionCount =
                typeof payload.content?.execution_count === 'number'
                  ? payload.content.execution_count
                  : null
              if (payload.content?.status === 'error') {
                status = 'error'
              }
              break
            }
            case 'status': {
              if (payload.content?.execution_state === 'idle') {
                idleReceived = true
              }
              break
            }
            default:
              break
          }

          finish()
        } catch (error) {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            socket.close()
            reject(error)
          }
        }
      })

      socket.once('error', () => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new RemoteJupyterError('kernel_dead', 'Jupyter websocket execution failed'))
        }
      })

      socket.once('close', () => {
        if (!settled && !(executeReplyReceived && idleReceived)) {
          settled = true
          clearTimeout(timeout)
          reject(
            new RemoteJupyterError(
              'kernel_dead',
              'Jupyter websocket closed before execution completed',
            ),
          )
        }
      })
    })
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    try {
      return await response.text()
    } catch {
      return null
    }
  }
}
