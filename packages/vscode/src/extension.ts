import * as http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import * as vscode from 'vscode'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Jupyter, Kernel } from '@vscode/jupyter-extension'
import {
  createExecutionEventFactory,
  createEmptyNotebook,
  ExecutionLineSplitter,
  HOST_STREAM_EVENT_METHOD,
  createRunCommandCode,
  listCells,
  RemoteJupyterError,
  toRemoteJupyterError,
  type ExecutionStreamCommand,
  type ExecutionStreamEvent,
  type ExecutionResult,
  type JupyterCell,
  type JupyterCellOutput,
  type JupyterContentModel,
  type JupyterNotebook,
  type JupyterNotebookContentModel,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type VsCodeHostCapabilities,
  type VsCodeHostInfo,
} from 'agentic-jupyter/core'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface HostConnectionInfo {
  host: string
  port: number
  token: string
}

interface KernelExecutionCapture {
  result: ExecutionResult
  notebookOutputs: vscode.NotebookCellOutput[]
  executionCount: number | null
}

const HOST = '127.0.0.1'
const RPC_PATH = '/rpc'
const STDOUT_MIME = vscode.NotebookCellOutputItem.stdout('').mime
const STDERR_MIME = vscode.NotebookCellOutputItem.stderr('').mime
const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error('')).mime
const textDecoder = new TextDecoder()

class AgenticJupyterHost implements vscode.Disposable {
  private server?: http.Server
  private wsServer?: WebSocketServer
  private connection?: HostConnectionInfo
  private readonly output = vscode.window.createOutputChannel('Agentic Jupyter Host')
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10)

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.command = 'agenticJupyter.copyConnectionInfo'
    this.statusBar.text = 'AJ Host: stopped'
    this.statusBar.tooltip = 'Agentic Jupyter host is stopped'
    this.statusBar.show()
  }

  dispose(): void {
    void this.stop()
    this.output.dispose()
    this.statusBar.dispose()
  }

  async activate(): Promise<void> {
    this.context.subscriptions.push(
      this.output,
      this.statusBar,
      vscode.commands.registerCommand('agenticJupyter.startHost', async () => {
        await this.start()
      }),
      vscode.commands.registerCommand('agenticJupyter.stopHost', async () => {
        await this.stop()
      }),
      vscode.commands.registerCommand('agenticJupyter.copyConnectionInfo', async () => {
        await this.copyConnectionInfo()
      }),
      this,
    )

    const config = this.getConfiguration()
    if (config.enableAutoStart) {
      await this.start()
    }
  }

  private getConfiguration() {
    const configuration = vscode.workspace.getConfiguration('agenticJupyter')
    return {
      enableAutoStart: configuration.get<boolean>('host.enableAutoStart', false),
      port: configuration.get<number>('host.port', 8765),
      logLevel: configuration.get<LogLevel>('host.logLevel', 'info'),
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = {
      debug: 10,
      info: 20,
      warn: 30,
      error: 40,
    }
    return order[level] >= order[this.getConfiguration().logLevel]
  }

  private log(level: LogLevel, message: string, details?: unknown): void {
    if (!this.shouldLog(level)) {
      return
    }
    this.output.appendLine(`[${level}] ${message}`)
    if (details !== undefined) {
      this.output.appendLine(JSON.stringify(details, null, 2))
    }
  }

  async start(): Promise<HostConnectionInfo> {
    if (this.connection) {
      return this.connection
    }

    const preferredPort = this.getConfiguration().port
    const token = crypto.randomUUID()
    const { server, wsServer, port } = await this.createServer(preferredPort, token)
    this.server = server
    this.wsServer = wsServer
    this.connection = {
      host: HOST,
      port,
      token,
    }
    this.updateStatusBar()
    this.log('info', 'VS Code host started', this.connection)
    this.output.show(true)
    return this.connection
  }

  async stop(): Promise<void> {
    this.connection = undefined
    this.updateStatusBar()
    const wsServer = this.wsServer
    const server = this.server
    this.wsServer = undefined
    this.server = undefined

    await Promise.all([
      wsServer
        ? new Promise<void>((resolve) => {
            wsServer.close(() => resolve())
          })
        : Promise.resolve(),
      server
        ? new Promise<void>((resolve) => {
            server.close(() => resolve())
          })
        : Promise.resolve(),
    ])

    this.log('info', 'VS Code host stopped')
  }

  async copyConnectionInfo(): Promise<void> {
    const connection = await this.start()
    const payload = JSON.stringify(connection, null, 2)
    await vscode.env.clipboard.writeText(payload)
    vscode.window.showInformationMessage('Agentic Jupyter host connection info copied to clipboard')
  }

  private updateStatusBar(): void {
    if (this.connection) {
      this.statusBar.text = `AJ Host: ${this.connection.host}:${this.connection.port}`
      this.statusBar.tooltip = 'Copy Agentic Jupyter host connection info'
      return
    }
    this.statusBar.text = 'AJ Host: stopped'
    this.statusBar.tooltip = 'Agentic Jupyter host is stopped'
  }

  private async createServer(preferredPort: number, token: string) {
    const listen = async (port: number) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        res.writeHead(404)
        res.end()
      })

      const wsServer = new WebSocketServer({ noServer: true })
      wsServer.on('connection', (socket) => {
        socket.on('message', (data) => {
          void this.handleRpcMessage(socket, data.toString('utf8'))
        })
      })

      server.on('upgrade', (request, socket, head) => {
        if (request.url !== RPC_PATH) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        if (request.headers.authorization !== `Bearer ${token}`) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wsServer.handleUpgrade(request, socket, head, (websocket) => {
          wsServer.emit('connection', websocket, request)
        })
      })

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, HOST, () => {
          server.off('error', reject)
          resolve()
        })
      })

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new RemoteJupyterError('remote_io_failed', 'Failed to determine VS Code host port')
      }

      return {
        server,
        wsServer,
        port: address.port,
      }
    }

    try {
      return await listen(preferredPort)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
        throw error
      }
      this.log('warn', `Port ${preferredPort} is in use, falling back to an ephemeral port`)
      return await listen(0)
    }
  }

  private async handleRpcMessage(socket: WebSocket, raw: string): Promise<void> {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(raw) as JsonRpcRequest
    } catch (error) {
      this.sendError(socket, 'unknown', 'invalid_request', 'Invalid JSON payload', {
        raw,
        cause: error,
      })
      return
    }

    try {
      const result = await this.dispatch(
        socket,
        String(request.id),
        request.method,
        (request.params ?? {}) as Record<string, unknown>,
      )
      this.sendResult(socket, request.id, result)
    } catch (error) {
      const normalized = toRemoteJupyterError(error)
      this.sendError(socket, request.id, normalized.code, normalized.message, normalized.details)
    }
  }

  private sendResult(socket: WebSocket, id: string | number, result: unknown): void {
    const payload: JsonRpcSuccess = {
      jsonrpc: '2.0',
      id,
      result,
    }
    socket.send(JSON.stringify(payload))
  }

  private sendError(
    socket: WebSocket,
    id: string | number,
    code: string,
    message: string,
    details?: unknown,
  ): void {
    const payload: JsonRpcFailure = {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message,
        data: {
          code,
          details,
        },
      },
    }
    socket.send(JSON.stringify(payload))
  }

  private sendNotification(socket: WebSocket, method: string, params: unknown): void {
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
      }),
    )
  }

  private async dispatch(
    socket: WebSocket,
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'host.handshake':
      case 'get_host_info':
        return await this.getHostInfo()
      case 'get_connection_status':
        return {
          capabilities: await this.getCapabilities(),
        }
      case 'list_jupyter_contents':
        return await this.listJupyterContents(String(params.path ?? ''))
      case 'read_jupyter_file':
        return await this.readJupyterFile(
          String(params.path),
          (params.format as 'text' | 'base64' | null | undefined) ?? null,
        )
      case 'write_jupyter_file':
        return await this.writeJupyterFile(
          String(params.path),
          String(params.content),
          (params.format as 'text' | 'base64' | undefined) ?? 'text',
          Boolean(params.create_dirs ?? true),
        )
      case 'create_notebook':
        return await this.createNotebook(String(params.path), String(params.kernel_name ?? 'python3'))
      case 'get_notebook':
        return await this.getNotebook(params.path as string | undefined)
      case 'list_cells':
        return await this.listNotebookCells(params.path as string | undefined)
      case 'insert_cell':
        return await this.insertCell(
          params.path as string | undefined,
          Number(params.index),
          String(params.cell_type) as JupyterCell['cell_type'],
          String(params.source),
          (params.metadata as Record<string, unknown> | undefined) ?? {},
        )
      case 'update_cell':
        return await this.updateCell(
          params.path as string | undefined,
          Number(params.index),
          {
            source: params.source as string | undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            cell_type: params.cell_type as JupyterCell['cell_type'] | undefined,
          },
        )
      case 'delete_cell':
        return await this.deleteCell(params.path as string | undefined, Number(params.index))
      case 'move_cell':
        return await this.moveCell(
          params.path as string | undefined,
          Number(params.from_index),
          Number(params.to_index),
        )
      case 'execute_code':
        return Boolean(params.stream)
          ? await this.streamExecuteCode(
              socket,
              requestId,
              params.path as string | undefined,
              String(params.code),
              Number(params.timeout_sec ?? 120),
            )
          : (
              await this.executeCodeAsTemporaryCell(
                params.path as string | undefined,
                String(params.code),
                Number(params.timeout_sec ?? 120),
              )
            ).result
      case 'run_cell':
        return Boolean(params.stream)
          ? await this.streamRunCell(
              socket,
              requestId,
              params.path as string | undefined,
              Number(params.index),
              Number(params.timeout_sec ?? 120),
              Boolean(params.save ?? true),
            )
          : await this.runCell(
              params.path as string | undefined,
              Number(params.index),
              Number(params.timeout_sec ?? 120),
              Boolean(params.save ?? true),
            )
      case 'run_cells':
        return Boolean(params.stream)
          ? await this.streamRunCells(
              socket,
              requestId,
              params.path as string | undefined,
              Number(params.start_index ?? 0),
              (params.end_index as number | undefined) ?? undefined,
              Number(params.timeout_sec ?? 120),
              Boolean(params.stop_on_error ?? true),
              Boolean(params.save ?? true),
            )
          : await this.runCells(
              params.path as string | undefined,
              Number(params.start_index ?? 0),
              (params.end_index as number | undefined) ?? undefined,
              Number(params.timeout_sec ?? 120),
              Boolean(params.stop_on_error ?? true),
              Boolean(params.save ?? true),
            )
      case 'run_command':
        return Boolean(params.stream)
          ? await this.streamRunCommand(
              socket,
              requestId,
              params.path as string | undefined,
              String(params.command),
              (params.cwd as string | undefined) ?? undefined,
              (params.env as Record<string, string> | undefined) ?? undefined,
              Number(params.timeout_sec ?? 120),
            )
          : await this.runCommand(
              params.path as string | undefined,
              String(params.command),
              (params.cwd as string | undefined) ?? undefined,
              (params.env as Record<string, string> | undefined) ?? undefined,
              Number(params.timeout_sec ?? 120),
            )
      case 'upload_file':
        return await this.uploadFile(
          String(params.local_path),
          String(params.remote_path),
          Boolean(params.create_dirs ?? true),
        )
      case 'download_file':
        return await this.downloadFile(
          String(params.remote_path),
          String(params.local_path),
          Boolean(params.overwrite ?? false),
        )
      default:
        throw new RemoteJupyterError('invalid_request', `Unknown RPC method: ${method}`)
    }
  }

  private async getHostInfo(): Promise<VsCodeHostInfo> {
    if (!this.connection) {
      throw new RemoteJupyterError('remote_io_failed', 'Host is not started')
    }
    return {
      host: this.connection.host,
      port: this.connection.port,
      extension_id: this.context.extension.id,
      extension_version: String(this.context.extension.packageJSON.version ?? '0.0.0'),
      capabilities: await this.getCapabilities(),
    }
  }

  private async getCapabilities(): Promise<VsCodeHostCapabilities> {
    const notebook = this.getActiveNotebook()
    const api = await this.getJupyterApi(false)
    if (!api || !notebook) {
      return {
        jupyter_extension_available: Boolean(api),
        kernel_selected: false,
        can_execute_code: false,
        can_run_command: false,
      }
    }

    const kernel = await api.kernels.getKernel(notebook.uri)
    return {
      jupyter_extension_available: true,
      kernel_selected: Boolean(kernel),
      can_execute_code: Boolean(kernel),
      can_run_command: Boolean(kernel && /python/i.test(kernel.language ?? '')),
    }
  }

  private getActiveNotebook(): vscode.NotebookDocument | undefined {
    return vscode.window.activeNotebookEditor?.notebook
  }

  private async getJupyterApi(required: boolean): Promise<Jupyter | undefined> {
    const extension = vscode.extensions.getExtension<Jupyter>('ms-toolsai.jupyter')
    if (!extension) {
      if (required) {
        throw new RemoteJupyterError('invalid_request', 'The VS Code Jupyter extension is not installed')
      }
      return undefined
    }
    if (!extension.isActive) {
      await extension.activate()
    }
    return extension.exports
  }

  private async getKernel(notebook: vscode.NotebookDocument): Promise<Kernel> {
    const api = await this.getJupyterApi(true)
    if (!api) {
      throw new RemoteJupyterError('invalid_request', 'The VS Code Jupyter extension is not installed')
    }
    const kernel = await api.kernels.getKernel(notebook.uri)
    if (!kernel) {
      throw new RemoteJupyterError(
        'invalid_request',
        `No active kernel selected for ${this.displayPath(notebook.uri)}`,
      )
    }
    return kernel
  }

  private resolveNotebook(path?: string): vscode.NotebookDocument {
    if (!path || path === '@active') {
      const active = this.getActiveNotebook()
      if (!active) {
        throw new RemoteJupyterError('not_found', 'No active notebook editor')
      }
      return active
    }

    const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
      this.uriMatches(candidate.uri, path),
    )
    if (!notebook) {
      throw new RemoteJupyterError('not_found', `Notebook is not open in VS Code: ${path}`)
    }
    return notebook
  }

  private resolveFileUri(path: string): vscode.Uri {
    if (path.startsWith('file://')) {
      return vscode.Uri.parse(path)
    }
    if (isAbsolute(path)) {
      return vscode.Uri.file(path)
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    if (!workspaceFolder) {
      throw new RemoteJupyterError(
        'invalid_request',
        `Relative path requires an open workspace folder: ${path}`,
      )
    }
    return vscode.Uri.joinPath(workspaceFolder.uri, path)
  }

  private uriMatches(uri: vscode.Uri, rawPath: string): boolean {
    if (uri.toString() === rawPath) {
      return true
    }
    if (uri.scheme === 'file' && uri.fsPath === rawPath) {
      return true
    }
    return vscode.workspace.asRelativePath(uri, false) === rawPath
  }

  private displayPath(uri: vscode.Uri): string {
    if (uri.scheme === 'file') {
      return vscode.workspace.asRelativePath(uri, false) || uri.fsPath
    }
    return uri.toString()
  }

  private async listJupyterContents(path: string): Promise<JupyterContentModel> {
    if (!path) {
      const content =
        vscode.workspace.workspaceFolders?.map((folder) => ({
          name: folder.name,
          path: this.displayPath(folder.uri),
          type: 'directory' as const,
        })) ?? []
      return {
        name: '',
        path: '',
        type: 'directory',
        format: 'json',
        content,
      }
    }

    const uri = this.resolveFileUri(path)
    const entries = await vscode.workspace.fs.readDirectory(uri)
    return {
      name: uri.path.split('/').at(-1) ?? '',
      path: this.displayPath(uri),
      type: 'directory',
      format: 'json',
      content: entries.map(([name, type]) => ({
        name,
        path: this.displayPath(vscode.Uri.joinPath(uri, name)),
        type: this.fileTypeToContentType(type),
      })),
    }
  }

  private fileTypeToContentType(type: vscode.FileType): 'directory' | 'file' | 'notebook' {
    if (type & vscode.FileType.Directory) {
      return 'directory'
    }
    return 'file'
  }

  private async readJupyterFile(path: string, format: 'text' | 'base64' | null) {
    const uri = this.resolveFileUri(path)
    const content = await vscode.workspace.fs.readFile(uri)
    return {
      name: uri.path.split('/').at(-1) ?? '',
      path: this.displayPath(uri),
      type: 'file' as const,
      format: format ?? 'text',
      content:
        format === 'base64'
          ? Buffer.from(content).toString('base64')
          : Buffer.from(content).toString('utf8'),
    }
  }

  private async writeJupyterFile(
    path: string,
    content: string,
    format: 'text' | 'base64',
    createDirs: boolean,
  ) {
    const uri = this.resolveFileUri(path)
    if (createDirs && uri.scheme === 'file') {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(uri.fsPath)))
    }
    const data = format === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
    await vscode.workspace.fs.writeFile(uri, data)
    return {
      name: uri.path.split('/').at(-1) ?? '',
      path: this.displayPath(uri),
      type: 'file' as const,
      format,
      content:
        format === 'base64'
          ? Buffer.from(data).toString('base64')
          : Buffer.from(data).toString('utf8'),
    }
  }

  private async createNotebook(path: string, kernelName: string) {
    const uri = this.resolveFileUri(path)
    if (uri.scheme === 'file') {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(uri.fsPath)))
    }
    const notebook = createEmptyNotebook(kernelName)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(notebook, null, 2), 'utf8'))
    const document = await vscode.workspace.openNotebookDocument(uri)
    await vscode.window.showNotebookDocument(document, { preserveFocus: true, preview: false })
    return this.notebookDocumentToModel(document)
  }

  private async getNotebook(path?: string): Promise<JupyterNotebookContentModel> {
    return this.notebookDocumentToModel(this.resolveNotebook(path))
  }

  private async listNotebookCells(path?: string) {
    const notebook = this.resolveNotebook(path)
    return {
      path: this.displayPath(notebook.uri),
      cells: listCells(this.notebookDocumentToJupyterNotebook(notebook)),
    }
  }

  private async insertCell(
    path: string | undefined,
    index: number,
    cellType: JupyterCell['cell_type'],
    source: string,
    metadata: Record<string, unknown>,
  ) {
    const notebook = this.resolveNotebook(path)
    const cell = this.createCellData(cellType, source, metadata)
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [cell])])
    await this.applyNotebookEdit(notebook, edit, true)
    return this.notebookDocumentToModel(notebook)
  }

  private async updateCell(
    path: string | undefined,
    index: number,
    patch: {
      source?: string
      metadata?: Record<string, unknown>
      cell_type?: JupyterCell['cell_type']
    },
  ) {
    const notebook = this.resolveNotebook(path)
    const cell = notebook.cellAt(index)
    if (!cell) {
      throw new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)
    }
    const nextType = patch.cell_type ?? this.toCellType(cell.kind)
    const nextSource = patch.source ?? cell.document.getText()
    const nextMetadata = patch.metadata ?? (cell.metadata as Record<string, unknown>)
    const replacement = this.createCellData(
      nextType,
      nextSource,
      nextMetadata,
      cell.document.languageId,
      cell.outputs,
      cell.executionSummary?.executionOrder ?? null,
    )
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [
      vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [replacement]),
    ])
    await this.applyNotebookEdit(notebook, edit, true)
    return this.notebookDocumentToModel(notebook)
  }

  private async deleteCell(path: string | undefined, index: number) {
    const notebook = this.resolveNotebook(path)
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(index, index + 1))])
    await this.applyNotebookEdit(notebook, edit, true)
    return this.notebookDocumentToModel(notebook)
  }

  private async moveCell(path: string | undefined, fromIndex: number, toIndex: number) {
    const notebook = this.resolveNotebook(path)
    const cells = notebook.getCells().map((cell) => this.cloneNotebookCellData(cell))
    const [cell] = cells.splice(fromIndex, 1)
    if (!cell) {
      throw new RemoteJupyterError('not_found', `Cell index ${fromIndex} is out of range`)
    }
    const boundedIndex = Math.max(0, Math.min(toIndex, cells.length))
    cells.splice(boundedIndex, 0, cell)
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [
      vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, notebook.cellCount), cells),
    ])
    await this.applyNotebookEdit(notebook, edit, true)
    return this.notebookDocumentToModel(notebook)
  }

  private async executeKernelCodeForNotebook(
    path: string | undefined,
    code: string,
    timeoutSec: number,
  ): Promise<KernelExecutionCapture> {
    const notebook = this.resolveNotebook(path)
    const kernel = await this.getKernel(notebook)
    return await this.executeKernelCode(kernel, code, timeoutSec)
  }

  private async executeKernelCode(
    kernel: Kernel,
    code: string,
    timeoutSec: number,
  ): Promise<KernelExecutionCapture> {
    const tokenSource = new vscode.CancellationTokenSource()
    const timeout = setTimeout(() => tokenSource.cancel(), timeoutSec * 1000)
    const outputs: vscode.NotebookCellOutput[] = []

    try {
      for await (const output of kernel.executeCode(code, tokenSource.token)) {
        outputs.push(output)
      }
    } catch (error) {
      if (tokenSource.token.isCancellationRequested) {
        throw new RemoteJupyterError(
          'execution_timeout',
          `Jupyter execution timed out after ${timeoutSec} seconds`,
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      tokenSource.dispose()
    }

    const result = this.outputsToExecutionResult(outputs)
    return {
      result,
      notebookOutputs: outputs,
      executionCount: result.execution_count,
    }
  }

  private createStreamEmitter(
    socket: WebSocket,
    requestId: string,
    command: ExecutionStreamCommand,
    path?: string,
  ) {
    const buildEvent = createExecutionEventFactory(command, requestId, path)
    return (event: Partial<ExecutionStreamEvent> & Pick<ExecutionStreamEvent, 'event'>) => {
      this.sendNotification(socket, HOST_STREAM_EVENT_METHOD, buildEvent(event))
    }
  }

  private createStreamLineEmitters(
    emit: (event: Partial<ExecutionStreamEvent> & Pick<ExecutionStreamEvent, 'event'>) => void,
    cellIndex?: number,
    filters?: {
      stdout?: (line: string, newline: boolean) => boolean
      stderr?: (line: string, newline: boolean) => boolean
    },
  ) {
    const stdoutSplitter = new ExecutionLineSplitter((line, newline) => {
      if (filters?.stdout && !filters.stdout(line, newline)) {
        return
      }
      emit({
        event: 'stdout',
        cell_index: cellIndex,
        line,
        newline,
      })
    })
    const stderrSplitter = new ExecutionLineSplitter((line, newline) => {
      if (filters?.stderr && !filters.stderr(line, newline)) {
        return
      }
      emit({
        event: 'stderr',
        cell_index: cellIndex,
        line,
        newline,
      })
    })
    return {
      onDelta: (delta: { stdout?: string; stderr?: string }) => {
        if (delta.stdout) {
          stdoutSplitter.push(delta.stdout)
        }
        if (delta.stderr) {
          stderrSplitter.push(delta.stderr)
        }
      },
      flush: () => {
        stdoutSplitter.flush()
        stderrSplitter.flush()
      },
    }
  }

  private isApiAccessRevoked(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'vscode.jupyter.apiAccessRevoked' ||
        /apiAccessRevoked/i.test(error.name) ||
        /Access to Jupyter Kernel has been revoked/i.test(error.message))
    )
  }

  private async showNotebookEditor(notebook: vscode.NotebookDocument): Promise<vscode.NotebookEditor> {
    const visible = vscode.window.visibleNotebookEditors.find(
      (editor) => editor.notebook.uri.toString() === notebook.uri.toString(),
    )
    if (visible) {
      await vscode.window.showNotebookDocument(visible.notebook, {
        viewColumn: visible.viewColumn,
        preserveFocus: false,
        preview: false,
        selections: visible.selections,
      })
      return vscode.window.activeNotebookEditor ?? visible
    }

    return await vscode.window.showNotebookDocument(notebook, {
      preserveFocus: false,
      preview: false,
    })
  }

  private async waitForCellExecutionByCommand(
    notebook: vscode.NotebookDocument,
    index: number,
    timeoutSec: number,
    onOutputsDelta?: (delta: { stdout?: string; stderr?: string }) => void,
  ): Promise<KernelExecutionCapture> {
    const existingCell = notebook.cellAt(index)
    if (!existingCell) {
      throw new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)
    }

    let lastStdout = this.outputsToExecutionResult([...existingCell.outputs]).stdout
    let lastStderr = this.outputsToExecutionResult([...existingCell.outputs]).stderr
    let lastExecutionOrder = existingCell.executionSummary?.executionOrder ?? null
    let lastOutputCount = existingCell.outputs.length

    return await new Promise<KernelExecutionCapture>((resolve, reject) => {
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let pollTimer: ReturnType<typeof setInterval> | undefined

      const finish = (callback: () => void) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutTimer)
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        if (pollTimer) {
          clearInterval(pollTimer)
        }
        disposable.dispose()
        callback()
      }

      const complete = () => {
        const cell = notebook.cellAt(index)
        if (!cell) {
          finish(() => reject(new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)))
          return
        }
        const result = this.outputsToExecutionResult([...cell.outputs])
        finish(() =>
          resolve({
            result,
            notebookOutputs: [...cell.outputs],
            executionCount: cell.executionSummary?.executionOrder ?? result.execution_count ?? null,
          }),
        )
      }

      const observeCell = () => {
        const cell = notebook.cellAt(index)
        if (!cell) {
          return false
        }
        const current = this.outputsToExecutionResult([...cell.outputs])
        let changed = false

        if (current.stdout !== lastStdout) {
          if (current.stdout.startsWith(lastStdout)) {
            const delta = current.stdout.slice(lastStdout.length)
            if (delta) {
              onOutputsDelta?.({ stdout: delta })
            }
          }
          lastStdout = current.stdout
          changed = true
        }

        if (current.stderr !== lastStderr) {
          if (current.stderr.startsWith(lastStderr)) {
            const delta = current.stderr.slice(lastStderr.length)
            if (delta) {
              onOutputsDelta?.({ stderr: delta })
            }
          }
          lastStderr = current.stderr
          changed = true
        }

        const executionOrder = cell.executionSummary?.executionOrder ?? null
        if (executionOrder !== lastExecutionOrder) {
          lastExecutionOrder = executionOrder
          changed = true
        }

        if (cell.outputs.length !== lastOutputCount) {
          lastOutputCount = cell.outputs.length
          changed = true
        }

        return changed
      }

      const scheduleCompletion = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        idleTimer = setTimeout(() => complete(), 400)
      }

      const disposable = vscode.workspace.onDidChangeNotebookDocument((event) => {
        if (event.notebook.uri.toString() !== notebook.uri.toString()) {
          return
        }
        if (observeCell()) {
          scheduleCompletion()
          return
        }
        for (const change of event.cellChanges) {
          if (change.cell.index !== index) {
            continue
          }
          if (change.outputs !== undefined || change.executionSummary !== undefined) {
            scheduleCompletion()
            return
          }
        }
      })

      pollTimer = setInterval(() => {
        if (!observeCell()) {
          return
        }
        scheduleCompletion()
      }, 100)

      const timeoutTimer = setTimeout(() => {
        finish(() =>
          reject(
            new RemoteJupyterError(
              'execution_timeout',
              `Jupyter execution timed out after ${timeoutSec} seconds`,
            ),
          ),
        )
      }, timeoutSec * 1000)
    })
  }

  private async executeCellByCommand(
    notebook: vscode.NotebookDocument,
    index: number,
    timeoutSec: number,
    onOutputsDelta?: (delta: { stdout?: string; stderr?: string }) => void,
  ): Promise<KernelExecutionCapture> {
    const editor = await this.showNotebookEditor(notebook)
    const range = new vscode.NotebookRange(index, index + 1)
    editor.selection = range
    editor.selections = [range]
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter)
    await vscode.commands.executeCommand('notebook.cell.execute')
    return await this.waitForCellExecutionByCommand(notebook, index, timeoutSec, onOutputsDelta)
  }

  private async executeCodeAsTemporaryCell(
    path: string | undefined,
    code: string,
    timeoutSec: number,
    onOutputsDelta?: (delta: { stdout?: string; stderr?: string }) => void,
  ): Promise<KernelExecutionCapture> {
    const notebook = this.resolveNotebook(path)
    const insertIndex = notebook.cellCount
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [
      vscode.NotebookEdit.insertCells(insertIndex, [
        this.createCellData('code', code, {
          agenticJupyterTemporary: true,
        }),
      ]),
    ])
    await this.applyNotebookEdit(notebook, edit, false)

    try {
      return await this.executeCellByCommand(notebook, insertIndex, timeoutSec, onOutputsDelta)
    } finally {
      const cleanupEdit = new vscode.WorkspaceEdit()
      cleanupEdit.set(notebook.uri, [
        vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(insertIndex, insertIndex + 1)),
      ])
      try {
        await this.applyNotebookEdit(notebook, cleanupEdit, false)
      } catch (error) {
        this.log('warn', 'Failed to remove temporary execution cell', error)
      }
    }
  }

  private outputsToExecutionResult(outputs: vscode.NotebookCellOutput[]): ExecutionResult {
    const normalizedOutputs = outputs.flatMap((output) => this.normalizeNotebookOutput(output))
    const stdout = normalizedOutputs
      .filter((output): output is Extract<JupyterCellOutput, { output_type: 'stream' }> => output.output_type === 'stream' && output.name === 'stdout')
      .map((output) => this.sourceText(output.text))
      .join('')
    const stderr = normalizedOutputs
      .filter((output): output is Extract<JupyterCellOutput, { output_type: 'stream' }> => output.output_type === 'stream' && output.name === 'stderr')
      .map((output) => this.sourceText(output.text))
      .join('')
    const richOutputs = normalizedOutputs.filter(
      (output): output is ExecutionResult['rich_outputs'][number] =>
        output.output_type === 'display_data' || output.output_type === 'execute_result',
    )
    const error = normalizedOutputs.find(
      (output): output is Extract<JupyterCellOutput, { output_type: 'error' }> => output.output_type === 'error',
    )

    return {
      status: error ? 'error' : 'ok',
      stdout,
      stderr,
      rich_outputs: richOutputs,
      outputs: normalizedOutputs,
      execution_count: richOutputs.find((output) => output.execution_count !== undefined)?.execution_count ?? null,
      error: error
        ? {
            ename: error.ename,
            evalue: error.evalue,
            traceback: error.traceback,
          }
        : undefined,
    }
  }

  private normalizeNotebookOutput(output: vscode.NotebookCellOutput): JupyterCellOutput[] {
    const normalized: JupyterCellOutput[] = []
    for (const item of output.items) {
      if (item.mime === STDOUT_MIME) {
        normalized.push({
          output_type: 'stream',
          name: 'stdout',
          text: textDecoder.decode(item.data),
        })
        continue
      }
      if (item.mime === STDERR_MIME) {
        normalized.push({
          output_type: 'stream',
          name: 'stderr',
          text: textDecoder.decode(item.data),
        })
        continue
      }
      if (item.mime === ERROR_MIME) {
        const payload = JSON.parse(textDecoder.decode(item.data)) as Error & {
          name?: string
          message?: string
          stack?: string
        }
        normalized.push({
          output_type: 'error',
          ename: payload.name ?? 'Error',
          evalue: payload.message ?? 'Unknown error',
          traceback: payload.stack ? payload.stack.split('\n') : [],
        })
        continue
      }

      normalized.push({
        output_type: 'display_data',
        data: {
          [item.mime]: this.decodeOutputItem(item),
        },
        metadata: output.metadata ?? {},
      })
    }
    return normalized
  }

  private decodeOutputItem(item: vscode.NotebookCellOutputItem): unknown {
    const mime = item.mime.toLowerCase()
    const text = textDecoder.decode(item.data)
    if (mime.includes('json')) {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return text
  }

  private async runCell(path: string | undefined, index: number, timeoutSec: number, save: boolean) {
    const notebook = this.resolveNotebook(path)
    const cell = notebook.cellAt(index)
    if (!cell) {
      throw new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)
    }
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      throw new RemoteJupyterError('invalid_request', `Cell ${index} is not a code cell`)
    }

    const execution = await this.executeCellByCommand(notebook, index, timeoutSec)
    await this.replaceCellExecution(
      notebook,
      index,
      cell,
      execution.notebookOutputs,
      execution.executionCount,
      save,
    )
    const refreshed = notebook.cellAt(index)
    return {
      path: this.displayPath(notebook.uri),
      index,
      result: execution.result,
      cell: refreshed ? this.notebookCellToJupyterCell(refreshed) : null,
      saved: save,
    }
  }

  private async runCells(
    path: string | undefined,
    startIndex: number,
    endIndex: number | undefined,
    timeoutSec: number,
    stopOnError: boolean,
    save: boolean,
  ) {
    const notebook = this.resolveNotebook(path)
    const finalIndex = Math.min(endIndex ?? notebook.cellCount - 1, notebook.cellCount - 1)
    const results: Array<Record<string, unknown>> = []

    for (let index = startIndex; index <= finalIndex; index += 1) {
      const cell = notebook.cellAt(index)
      if (!cell) {
        break
      }
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        results.push({
          index,
          status: 'skipped',
          reason: `Cell ${index} is not a code cell`,
        })
        continue
      }

      const execution = await this.executeCellByCommand(notebook, index, timeoutSec)
      await this.replaceCellExecution(
        notebook,
        index,
        cell,
        execution.notebookOutputs,
        execution.executionCount,
        save,
      )
      results.push({
        index,
        status: execution.result.status,
        result: execution.result,
      })
      if (execution.result.status === 'error' && stopOnError) {
        break
      }
    }

    return {
      path: this.displayPath(notebook.uri),
      start_index: startIndex,
      end_index: finalIndex,
      results,
      saved: save,
    }
  }

  private async streamExecuteCode(
    socket: WebSocket,
    requestId: string,
    path: string | undefined,
    code: string,
    timeoutSec: number,
  ): Promise<ExecutionResult> {
    const notebook = this.resolveNotebook(path)
    const emit = this.createStreamEmitter(
      socket,
      requestId,
      'execute_code',
      this.displayPath(notebook.uri),
    )
    const stream = this.createStreamLineEmitters(emit)
    const execution = await this.executeCodeAsTemporaryCell(path, code, timeoutSec, stream.onDelta)
    stream.flush()
    emit({
      event: 'exec_complete',
      status: execution.result.status,
      execution_count: execution.result.execution_count,
      error: execution.result.error,
    })
    return execution.result
  }

  private async streamRunCell(
    socket: WebSocket,
    requestId: string,
    path: string | undefined,
    index: number,
    timeoutSec: number,
    save: boolean,
  ) {
    const notebook = this.resolveNotebook(path)
    const cell = notebook.cellAt(index)
    if (!cell) {
      throw new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)
    }
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      throw new RemoteJupyterError('invalid_request', `Cell ${index} is not a code cell`)
    }

    const emit = this.createStreamEmitter(socket, requestId, 'run_cell', this.displayPath(notebook.uri))
    emit({
      event: 'cell_start',
      cell_index: index,
    })
    const stream = this.createStreamLineEmitters(emit, index)
    const execution = await this.executeCellByCommand(notebook, index, timeoutSec, stream.onDelta)
    stream.flush()
    await this.replaceCellExecution(
      notebook,
      index,
      cell,
      execution.notebookOutputs,
      execution.executionCount,
      save,
    )
    const refreshed = notebook.cellAt(index)
    emit({
      event: 'cell_complete',
      cell_index: index,
      status: execution.result.status,
      execution_count: execution.result.execution_count,
      error: execution.result.error,
      saved: save,
    })
    return {
      path: this.displayPath(notebook.uri),
      index,
      result: execution.result,
      cell: refreshed ? this.notebookCellToJupyterCell(refreshed) : null,
      saved: save,
    }
  }

  private async streamRunCells(
    socket: WebSocket,
    requestId: string,
    path: string | undefined,
    startIndex: number,
    endIndex: number | undefined,
    timeoutSec: number,
    stopOnError: boolean,
    save: boolean,
  ) {
    const notebook = this.resolveNotebook(path)
    const displayPath = this.displayPath(notebook.uri)
    const finalIndex = Math.min(endIndex ?? notebook.cellCount - 1, notebook.cellCount - 1)
    const emit = this.createStreamEmitter(socket, requestId, 'run_cells', displayPath)
    const results: Array<Record<string, unknown>> = []

    emit({
      event: 'run_start',
      start_index: startIndex,
      end_index: finalIndex,
    })

    for (let index = startIndex; index <= finalIndex; index += 1) {
      const cell = notebook.cellAt(index)
      if (!cell) {
        break
      }
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        const reason = `Cell ${index} is not a code cell`
        results.push({
          index,
          status: 'skipped',
          reason,
        })
        emit({
          event: 'cell_skipped',
          cell_index: index,
          reason,
        })
        continue
      }

      emit({
        event: 'cell_start',
        cell_index: index,
      })
      const stream = this.createStreamLineEmitters(emit, index)
      const execution = await this.executeCellByCommand(notebook, index, timeoutSec, stream.onDelta)
      stream.flush()
      await this.replaceCellExecution(
        notebook,
        index,
        cell,
        execution.notebookOutputs,
        execution.executionCount,
        save,
      )
      results.push({
        index,
        status: execution.result.status,
        result: execution.result,
      })
      emit({
        event: 'cell_complete',
        cell_index: index,
        status: execution.result.status,
        execution_count: execution.result.execution_count,
        error: execution.result.error,
        saved: save,
      })
      if (execution.result.status === 'error' && stopOnError) {
        break
      }
    }

    emit({
      event: 'run_complete',
      start_index: startIndex,
      end_index: finalIndex,
      saved: save,
    })

    return {
      path: displayPath,
      start_index: startIndex,
      end_index: finalIndex,
      results,
      saved: save,
    }
  }

  private async replaceCellExecution(
    notebook: vscode.NotebookDocument,
    index: number,
    cell: vscode.NotebookCell,
    outputs: vscode.NotebookCellOutput[],
    executionCount: number | null,
    save: boolean,
  ) {
    const replacement = this.createCellData(
      this.toCellType(cell.kind),
      cell.document.getText(),
      cell.metadata as Record<string, unknown>,
      cell.document.languageId,
      outputs,
      executionCount,
    )
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [
      vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [replacement]),
    ])
    await this.applyNotebookEdit(notebook, edit, save)
  }

  private async runCommand(
    path: string | undefined,
    command: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutSec: number,
  ) {
    const notebook = this.resolveNotebook(path)
    const kernelLanguage =
      ((notebook.metadata?.kernelspec as { language?: string } | undefined)?.language ??
        notebook
          .getCells()
          .find((cell) => cell.kind === vscode.NotebookCellKind.Code)
          ?.document.languageId ??
        'unknown')
    if (!/python/i.test(kernelLanguage)) {
      throw new RemoteJupyterError(
        'unsupported_kernel',
        `run_command requires a Python kernel, got ${kernelLanguage}`,
      )
    }
    const execution = await this.executeCodeAsTemporaryCell(
      path,
      createRunCommandCode(command, cwd, env),
      timeoutSec,
    )
    const marker = '__REMOTE_JUPYTER_MCP_RUN_COMMAND__'
    const payloadLine = execution.result.stdout
      .split('\n')
      .find((line: string) => line.startsWith(marker))
    if (!payloadLine) {
      throw new RemoteJupyterError(
        'remote_io_failed',
        'run_command did not return a parseable payload',
        execution.result,
      )
    }
    return JSON.parse(payloadLine.slice(marker.length))
  }

  private async streamRunCommand(
    socket: WebSocket,
    requestId: string,
    path: string | undefined,
    command: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    timeoutSec: number,
  ) {
    const notebook = this.resolveNotebook(path)
    const kernelLanguage =
      ((notebook.metadata?.kernelspec as { language?: string } | undefined)?.language ??
        notebook
          .getCells()
          .find((cell) => cell.kind === vscode.NotebookCellKind.Code)
          ?.document.languageId ??
        'unknown')
    if (!/python/i.test(kernelLanguage)) {
      throw new RemoteJupyterError(
        'unsupported_kernel',
        `run_command requires a Python kernel, got ${kernelLanguage}`,
      )
    }

    const marker = '__REMOTE_JUPYTER_MCP_RUN_COMMAND__'
    const emit = this.createStreamEmitter(socket, requestId, 'run_command', this.displayPath(notebook.uri))
    const stream = this.createStreamLineEmitters(emit, undefined, {
      stdout: (line) => !line.startsWith(marker),
    })
    const execution = await this.executeCodeAsTemporaryCell(
      path,
      createRunCommandCode(command, cwd, env),
      timeoutSec,
      stream.onDelta,
    )
    stream.flush()
    const payloadLine = execution.result.stdout
      .split('\n')
      .find((line: string) => line.startsWith(marker))
    if (!payloadLine) {
      throw new RemoteJupyterError(
        'remote_io_failed',
        'run_command did not return a parseable payload',
        execution.result,
      )
    }
    const parsed = JSON.parse(payloadLine.slice(marker.length)) as { exit_code: number }
    emit({
      event: 'command_complete',
      exit_code: parsed.exit_code,
    })
    return parsed
  }

  private async uploadFile(localPath: string, remotePath: string, createDirs: boolean) {
    const destination = this.resolveFileUri(remotePath)
    if (createDirs && destination.scheme === 'file') {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(destination.fsPath)))
    }
    const content = await readFile(localPath)
    await vscode.workspace.fs.writeFile(destination, content)
    return {
      local_path: localPath,
      remote_path: this.displayPath(destination),
      uploaded: true,
    }
  }

  private async downloadFile(remotePath: string, localPath: string, overwrite: boolean) {
    const source = this.resolveFileUri(remotePath)
    if (!overwrite) {
      try {
        await readFile(localPath)
        throw new RemoteJupyterError('invalid_request', `Local file already exists: ${localPath}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw error
        }
      }
    }
    await mkdir(dirname(localPath), { recursive: true })
    const content = await vscode.workspace.fs.readFile(source)
    await writeFile(localPath, Buffer.from(content))
    return {
      remote_path: this.displayPath(source),
      local_path: localPath,
      downloaded: true,
    }
  }

  private async applyNotebookEdit(
    notebook: vscode.NotebookDocument,
    edit: vscode.WorkspaceEdit,
    save: boolean,
  ) {
    const applied = await vscode.workspace.applyEdit(edit)
    if (!applied) {
      throw new RemoteJupyterError('remote_io_failed', 'Failed to apply notebook edit')
    }
    if (save) {
      await notebook.save()
    }
  }

  private notebookDocumentToModel(notebook: vscode.NotebookDocument): JupyterNotebookContentModel {
    return {
      name: notebook.uri.path.split('/').at(-1) ?? this.displayPath(notebook.uri),
      path: this.displayPath(notebook.uri),
      type: 'notebook',
      format: 'json',
      content: this.notebookDocumentToJupyterNotebook(notebook),
    }
  }

  private notebookDocumentToJupyterNotebook(notebook: vscode.NotebookDocument): JupyterNotebook {
    return {
      cells: notebook.getCells().map((cell) => this.notebookCellToJupyterCell(cell)),
      metadata: (notebook.metadata as JupyterNotebook['metadata']) ?? {},
      nbformat: 4,
      nbformat_minor: 5,
    }
  }

  private notebookCellToJupyterCell(cell: vscode.NotebookCell): JupyterCell {
    const source = cell.document.getText()
    const metadata = (cell.metadata as Record<string, unknown>) ?? {}
    if (cell.kind === vscode.NotebookCellKind.Code) {
      return {
        cell_type: 'code',
        metadata,
        source,
        execution_count: cell.executionSummary?.executionOrder ?? null,
        outputs: cell.outputs.flatMap((output) => this.normalizeNotebookOutput(output)),
      }
    }
    return {
      cell_type: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'raw',
      metadata,
      source,
    }
  }

  private createCellData(
    cellType: JupyterCell['cell_type'],
    source: string,
    metadata: Record<string, unknown>,
    languageId?: string,
    outputs?: readonly vscode.NotebookCellOutput[],
    executionCount?: number | null,
  ): vscode.NotebookCellData {
    const data = new vscode.NotebookCellData(
      cellType === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
      source,
      languageId ??
        (cellType === 'markdown' ? 'markdown' : cellType === 'raw' ? 'plaintext' : 'python'),
    )
    data.metadata = metadata
    if (cellType === 'code') {
      data.outputs = outputs ? [...outputs] : []
      data.executionSummary = {
        executionOrder: executionCount ?? undefined,
        success: executionCount !== null,
      }
    }
    return data
  }

  private cloneNotebookCellData(cell: vscode.NotebookCell): vscode.NotebookCellData {
    return this.createCellData(
      this.toCellType(cell.kind),
      cell.document.getText(),
      (cell.metadata as Record<string, unknown>) ?? {},
      cell.document.languageId,
      cell.outputs,
      cell.executionSummary?.executionOrder ?? null,
    )
  }

  private toCellType(kind: vscode.NotebookCellKind): JupyterCell['cell_type'] {
    return kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code'
  }

  private sourceText(value: string | string[]): string {
    return Array.isArray(value) ? value.join('') : value
  }
}

let host: AgenticJupyterHost | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  host = new AgenticJupyterHost(context)
  await host.activate()
}

export async function deactivate(): Promise<void> {
  await host?.stop()
  host?.dispose()
  host = undefined
}
