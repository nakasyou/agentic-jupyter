import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RemoteJupyterError, getNotebookKernelName } from '../core/index.js'
import type {
  CachedSession,
  ConnectRemoteJupyterInput,
  JupyterApiInfo,
} from '../core/index.js'
import { JupyterClient } from './jupyter-client.js'

export interface ConnectionRecord {
  id: string
  baseUrl: string
  jupyterToken?: string
  jupyterBasePath: string
  jupyterClient: JupyterClient
  sessions: Map<string, CachedSession>
  serverInfo: JupyterApiInfo
}

function normalizeBasePath(value?: string): string {
  if (!value || value === '/') {
    return '/'
  }
  const next = value.startsWith('/') ? value : `/${value}`
  return next.endsWith('/') ? next : `${next}/`
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function buildBaseUrl(input: ConnectRemoteJupyterInput): string {
  if (input.jupyter_base_url) {
    return ensureTrailingSlash(input.jupyter_base_url)
  }

  const protocol = input.jupyter_protocol ?? 'http'
  const host = input.jupyter_host ?? '127.0.0.1'
  const port = input.jupyter_port ?? 8888
  const basePath = normalizeBasePath(input.jupyter_base_path)
  return `${protocol}://${host}:${port}${basePath}`
}

async function ensureLocalDirectory(path: string): Promise<void> {
  if (!path || path === '.' || path === '/') {
    return
  }
  await mkdir(path, { recursive: true })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionRecord>()

  async connect(input: ConnectRemoteJupyterInput) {
    const connectionId = crypto.randomUUID()
    const sessions = new Map<string, CachedSession>()
    const baseUrl = buildBaseUrl(input)
    const jupyterBasePath = normalizeBasePath(input.jupyter_base_path)
    const client = new JupyterClient(baseUrl, input.jupyter_token, () => {
      sessions.clear()
    })
    const serverInfo = await waitForJupyter(client)

    const record: ConnectionRecord = {
      id: connectionId,
      baseUrl,
      jupyterToken: input.jupyter_token,
      jupyterBasePath,
      jupyterClient: client,
      sessions,
      serverInfo,
    }

    this.connections.set(connectionId, record)
    return {
      connection_id: connectionId,
      backend: 'remote-jupyter' as const,
      base_url: baseUrl,
      server_info: serverInfo,
    }
  }

  get(connectionId: string): ConnectionRecord {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new RemoteJupyterError('not_found', `Unknown connection_id: ${connectionId}`)
    }
    return connection
  }

  async disconnect(connectionId: string) {
    const connection = this.get(connectionId)
    this.connections.delete(connectionId)
    connection.sessions.clear()
    return {
      connection_id: connectionId,
      backend: 'remote-jupyter' as const,
      disconnected: true,
    }
  }

  async getStatus(connectionId: string) {
    const connection = this.get(connectionId)
    let jupyter_status: 'ok' | 'error' = 'ok'
    let jupyter_error: string | null = null
    try {
      await connection.jupyterClient.getApiInfo()
    } catch (error) {
      jupyter_status = 'error'
      jupyter_error = error instanceof Error ? error.message : String(error)
    }

    return {
      connection_id: connectionId,
      backend: 'remote-jupyter' as const,
      base_url: connection.baseUrl,
      jupyter_status,
      jupyter_error,
      cached_sessions: [...connection.sessions.values()],
    }
  }

  async ensureNotebookSession(connectionId: string, path: string): Promise<CachedSession> {
    const connection = this.get(connectionId)
    const cached = connection.sessions.get(path)
    if (cached) {
      return cached
    }

    const notebookModel = await connection.jupyterClient.getNotebook(path)
    const kernelName = getNotebookKernelName(notebookModel.content!)
    const session = await connection.jupyterClient.ensureSession(path, kernelName)
    connection.sessions.set(path, session)
    return session
  }

  async executeCode(
    connectionId: string,
    path: string,
    code: string,
    timeoutSec: number,
    onStream?: (stream: 'stdout' | 'stderr', text: string) => void,
  ) {
    const connection = this.get(connectionId)
    const session = await this.ensureNotebookSession(connectionId, path)
    return await connection.jupyterClient.executeCode(session, code, timeoutSec, onStream)
  }

  async ensureJupyterDirectory(connectionId: string, path: string): Promise<void> {
    const connection = this.get(connectionId)
    await connection.jupyterClient.ensureDirectory(path)
  }

  async writeJupyterFile(
    connectionId: string,
    path: string,
    content: string,
    format: 'text' | 'base64',
    createDirs: boolean,
  ) {
    const connection = this.get(connectionId)
    if (createDirs) {
      await connection.jupyterClient.ensureDirectory(dirname(path))
    }
    return await connection.jupyterClient.saveContent(path, {
      path,
      type: 'file',
      format,
      content,
    })
  }

  async uploadFile(
    connectionId: string,
    localPath: string,
    remotePath: string,
    createDirs: boolean,
  ) {
    const connection = this.get(connectionId)
    if (createDirs) {
      await connection.jupyterClient.ensureDirectory(dirname(remotePath))
    }
    const content = await readFile(localPath)
    await connection.jupyterClient.saveContent(remotePath, {
      path: remotePath,
      type: 'file',
      format: 'base64',
      content: content.toString('base64'),
    })
    return {
      local_path: localPath,
      remote_path: remotePath,
      uploaded: true,
    }
  }

  async downloadFile(
    connectionId: string,
    remotePath: string,
    localPath: string,
    overwrite: boolean,
  ) {
    if (!overwrite && (await fileExists(localPath))) {
      throw new RemoteJupyterError('invalid_request', `Local file already exists: ${localPath}`)
    }

    const connection = this.get(connectionId)
    const model = await connection.jupyterClient.getContent(remotePath, {
      content: true,
      format: 'base64',
    })
    if (model.type !== 'file' || typeof model.content !== 'string') {
      throw new RemoteJupyterError('remote_io_failed', `Content is not a file: ${remotePath}`)
    }

    await ensureLocalDirectory(dirname(localPath))
    await writeFile(localPath, Buffer.from(model.content, 'base64'))
    return {
      remote_path: remotePath,
      local_path: localPath,
      downloaded: true,
    }
  }
}

async function waitForJupyter(client: JupyterClient): Promise<JupyterApiInfo> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await client.getApiInfo()
    } catch (error) {
      if (error instanceof RemoteJupyterError && error.code === 'auth_failed') {
        throw error
      }
      await delay(250)
    }
  }

  throw new RemoteJupyterError('remote_io_failed', 'Timed out waiting for Jupyter')
}
