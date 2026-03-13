import { readFile } from 'node:fs/promises'
import {
  applyExecutionToCell,
  actionDefinitions,
  assertPythonKernel,
  cliActionMap,
  createExecutionEventFactory,
  createRunCommandCode,
  ExecutionLineSplitter,
  RemoteJupyterError,
  toRemoteJupyterError,
  type ExecutionResult,
  type ExecutionStreamCommand,
  type ExecutionStreamEvent,
  type JupyterNotebook,
  type ConnectRemoteJupyterInput,
  type ConnectVscodeHostInput,
  getCellSource,
} from './lib/core/index.js'
import { formatHuman } from './cli-format.js'
import {
  deleteProfile,
  getProfile,
  getProfilesPath,
  listProfiles,
  setProfile,
  type CliProfile,
} from './cli-profiles.js'
import { UnifiedConnectionRegistry, executeAction } from './lib/mcp-server/index.js'

type OptionType = 'string' | 'number' | 'boolean' | 'json'
type BackendOption = 'remote-jupyter' | 'vscode-host'

interface OptionSpec {
  type: OptionType
}

interface ParsedArgs {
  positionals: string[]
  options: Record<string, unknown>
}

type ResolvedConnectionConfig =
  | (ConnectRemoteJupyterInput & {
      backend: 'remote-jupyter'
      default_notebook_path?: string
    })
  | (ConnectVscodeHostInput & {
      backend: 'vscode-host'
      default_notebook_path?: string
    })

type StreamingCommandName = 'execute-code' | 'run-cell' | 'run-cells' | 'run-command'

export interface CliIO {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

export interface RunCliOptions {
  io?: CliIO
}

const connectionOptionSpecs: Record<string, OptionSpec> = {
  profile: { type: 'string' },
  backend: { type: 'string' },
  'jupyter-base-url': { type: 'string' },
  'jupyter-host': { type: 'string' },
  'jupyter-port': { type: 'number' },
  'jupyter-protocol': { type: 'string' },
  'jupyter-token': { type: 'string' },
  'jupyter-base-path': { type: 'string' },
  'vscode-host': { type: 'string' },
  'vscode-port': { type: 'number' },
  'vscode-token': { type: 'string' },
  'vscode-secure': { type: 'boolean' },
}

const commonOptionSpecs: Record<string, OptionSpec> = {
  json: { type: 'boolean' },
  ...connectionOptionSpecs,
}

const actionOptionSpecs: Record<string, Record<string, OptionSpec>> = {
  'connect-remote-jupyter': {},
  'connect-vscode-host': {},
  'disconnect-remote-jupyter': {},
  'get-connection-status': {},
  'list-jupyter-contents': {
    path: { type: 'string' },
  },
  'read-jupyter-file': {
    path: { type: 'string' },
    format: { type: 'string' },
  },
  'write-jupyter-file': {
    path: { type: 'string' },
    content: { type: 'string' },
    'content-file': { type: 'string' },
    format: { type: 'string' },
    'create-dirs': { type: 'boolean' },
  },
  'create-notebook': {
    path: { type: 'string' },
    'kernel-name': { type: 'string' },
  },
  'get-notebook': {
    path: { type: 'string' },
  },
  'list-cells': {
    path: { type: 'string' },
  },
  'insert-cell': {
    path: { type: 'string' },
    index: { type: 'number' },
    'cell-type': { type: 'string' },
    source: { type: 'string' },
    'source-file': { type: 'string' },
    'metadata-json': { type: 'json' },
  },
  'update-cell': {
    path: { type: 'string' },
    index: { type: 'number' },
    source: { type: 'string' },
    'source-file': { type: 'string' },
    'metadata-json': { type: 'json' },
    'cell-type': { type: 'string' },
  },
  'delete-cell': {
    path: { type: 'string' },
    index: { type: 'number' },
  },
  'move-cell': {
    path: { type: 'string' },
    'from-index': { type: 'number' },
    'to-index': { type: 'number' },
  },
  'execute-code': {
    path: { type: 'string' },
    code: { type: 'string' },
    'code-file': { type: 'string' },
    'timeout-sec': { type: 'number' },
    stream: { type: 'boolean' },
  },
  'run-cell': {
    path: { type: 'string' },
    index: { type: 'number' },
    'timeout-sec': { type: 'number' },
    save: { type: 'boolean' },
    stream: { type: 'boolean' },
  },
  'run-cells': {
    path: { type: 'string' },
    'start-index': { type: 'number' },
    'end-index': { type: 'number' },
    'timeout-sec': { type: 'number' },
    'stop-on-error': { type: 'boolean' },
    save: { type: 'boolean' },
    stream: { type: 'boolean' },
  },
  'run-command': {
    path: { type: 'string' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    'env-json': { type: 'json' },
    'timeout-sec': { type: 'number' },
    stream: { type: 'boolean' },
  },
  'upload-file': {
    'local-path': { type: 'string' },
    'remote-path': { type: 'string' },
    'create-dirs': { type: 'boolean' },
  },
  'download-file': {
    'remote-path': { type: 'string' },
    'local-path': { type: 'string' },
    overwrite: { type: 'boolean' },
  },
}

const profileSetOptionSpecs: Record<string, OptionSpec> = {
  ...connectionOptionSpecs,
  'default-notebook-path': { type: 'string' },
  json: { type: 'boolean' },
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? defaultIO
  const [command = 'serve', ...rest] = argv

  try {
    switch (command) {
      case 'serve': {
        const { startServer } = await import('./lib/mcp-server/index.js')
        await startServer()
        return 0
      }
      case 'help':
      case '--help':
      case '-h':
        io.stdout(renderHelp())
        return 0
      case 'version':
      case '--version':
      case '-v': {
        const pkg = await import('../package.json', {
          with: { type: 'json' },
        })
        io.stdout(String(pkg.default.version ?? '0.0.0'))
        return 0
      }
      case 'profile':
        return await runProfileCommand(rest, io)
      default:
        if (cliActionMap.has(command)) {
          return await runActionCommand(command, rest, io)
        }
        io.stderr(`Unknown command: ${command}\n\n${renderHelp()}`)
        return 1
    }
  } catch (error) {
    const normalized = toRemoteJupyterError(error)
    io.stderr(
      [
        `error_code: ${normalized.code}`,
        `message: ${normalized.message}`,
        normalized.details ? `details: ${JSON.stringify(normalized.details, null, 2)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return 1
  }
}

async function runProfileCommand(argv: string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = argv

  switch (subcommand) {
    case 'set': {
      const parsed = parseArgs(rest, profileSetOptionSpecs)
      const name = parsed.positionals[0]
      if (!name) {
        throw new Error('profile set requires a profile name')
      }
      const existing = await getProfile(name)
      const backend = resolveBackend(parsed.options, existing)
      const profile = cleanUndefined({
        ...existing,
        backend,
        jupyter_base_url:
          getStringOption(parsed.options, 'jupyter-base-url') ?? existing?.jupyter_base_url,
        jupyter_host: getStringOption(parsed.options, 'jupyter-host') ?? existing?.jupyter_host,
        jupyter_port: getNumberOption(parsed.options, 'jupyter-port') ?? existing?.jupyter_port,
        jupyter_protocol:
          (getStringOption(parsed.options, 'jupyter-protocol') as 'http' | 'https' | undefined) ??
          existing?.jupyter_protocol,
        jupyter_token: getStringOption(parsed.options, 'jupyter-token') ?? existing?.jupyter_token,
        jupyter_base_path:
          getStringOption(parsed.options, 'jupyter-base-path') ?? existing?.jupyter_base_path,
        vscode_host: getStringOption(parsed.options, 'vscode-host') ?? existing?.vscode_host,
        vscode_port: getNumberOption(parsed.options, 'vscode-port') ?? existing?.vscode_port,
        vscode_token: getStringOption(parsed.options, 'vscode-token') ?? existing?.vscode_token,
        vscode_secure:
          getExplicitBooleanOption(parsed.options, 'vscode-secure') ?? existing?.vscode_secure,
        default_notebook_path:
          getStringOption(parsed.options, 'default-notebook-path') ?? existing?.default_notebook_path,
      }) as CliProfile

      validateProfile(profile)
      const saved = await setProfile(name, profile)
      writeOutput(io, 'profile set', { profile: name, ...saved }, getBooleanOption(parsed.options, 'json'))
      return 0
    }
    case 'get': {
      const parsed = parseArgs(rest, { json: { type: 'boolean' } })
      const name = parsed.positionals[0]
      if (!name) {
        throw new Error('profile get requires a profile name')
      }
      const profile = await getProfile(name)
      if (!profile) {
        throw new Error(`profile not found: ${name}`)
      }
      writeOutput(io, 'profile get', { profile: name, ...profile }, getBooleanOption(parsed.options, 'json'))
      return 0
    }
    case 'list': {
      const parsed = parseArgs(rest, { json: { type: 'boolean' } })
      const profiles = await listProfiles()
      writeOutput(io, 'profile list', profiles, getBooleanOption(parsed.options, 'json'))
      return 0
    }
    case 'delete': {
      const parsed = parseArgs(rest, { json: { type: 'boolean' } })
      const name = parsed.positionals[0]
      if (!name) {
        throw new Error('profile delete requires a profile name')
      }
      const deleted = await deleteProfile(name)
      writeOutput(io, 'profile delete', { profile: name, deleted }, getBooleanOption(parsed.options, 'json'))
      return 0
    }
    default:
      io.stderr(
        `Unknown profile subcommand: ${subcommand ?? '(missing)'}\nAvailable: set, get, list, delete`,
      )
      return 1
  }
}

async function runActionCommand(commandName: string, argv: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(argv, {
    ...commonOptionSpecs,
    ...(actionOptionSpecs[commandName] ?? {}),
  })
  const json = getBooleanOption(parsed.options, 'json')
  const registry = new UnifiedConnectionRegistry()

  if (commandName === 'connect-remote-jupyter' || commandName === 'connect-vscode-host') {
    const connectInput = await resolveConnectionConfig(parsed.options)
    const actionName =
      connectInput.backend === 'remote-jupyter' ? 'connect_remote_jupyter' : 'connect_vscode_host'
    const result = await executeAction(registry, actionName, connectInput)
    writeOutput(io, commandName, result, json)
    return 0
  }

  const connectInput = await resolveConnectionConfig(parsed.options)
  const connectAction =
    connectInput.backend === 'remote-jupyter' ? 'connect_remote_jupyter' : 'connect_vscode_host'
  const connected = (await executeAction(registry, connectAction, connectInput)) as Record<string, string>
  const connectionId = requiredString(connected.connection_id, 'connection-id')

  try {
    if (commandName === 'get-connection-status') {
      const result = await executeAction(registry, 'get_connection_status', {
        connection_id: connectionId,
      })
      writeOutput(io, commandName, result, json)
      return 0
    }

    if (commandName === 'disconnect-remote-jupyter') {
      const result = await executeAction(registry, 'disconnect_remote_jupyter', {
        connection_id: connectionId,
      })
      writeOutput(io, commandName, result, json)
      return 0
    }

    if (isStreamingCommand(commandName) && getBooleanOption(parsed.options, 'stream')) {
      return await runStreamingCommand(
        commandName,
        io,
        json,
        registry,
        connectionId,
        parsed.options,
        connectInput,
      )
    }

    const result = await executeAction(
      registry,
      toActionName(commandName),
      await buildEphemeralActionInput(commandName, parsed.options, connectionId, connectInput),
    )
    writeOutput(io, commandName, result, json)
    return 0
  } finally {
    try {
      await executeAction(registry, 'disconnect_remote_jupyter', {
        connection_id: connectionId,
      })
    } catch {}
  }
}

async function runStreamingCommand(
  commandName: StreamingCommandName,
  io: CliIO,
  json: boolean,
  registry: UnifiedConnectionRegistry,
  connectionId: string,
  options: Record<string, unknown>,
  connectInput: ResolvedConnectionConfig,
): Promise<number> {
  const actionName = toActionName(commandName) as ExecutionStreamCommand
  const streamWriter = createStreamWriter(io, json)
  const input = await buildEphemeralActionInput(commandName, options, connectionId, connectInput)

  if (connectInput.backend === 'vscode-host') {
    const result = await registry.vscode.requestStream(
      connectionId,
      actionName,
      {
        ...input,
        stream: true,
      },
      (event) => streamWriter.write(event),
    )
    if (!json) {
      streamWriter.writeCompletion(commandName, result)
    }
    return 0
  }

  const result = await runRemoteStreamingCommand(
    commandName,
    streamWriter,
    registry,
    connectionId,
    input,
  )
  if (!json) {
    streamWriter.writeCompletion(commandName, result)
  }
  return 0
}

interface StreamWriter {
  write: (event: ExecutionStreamEvent) => void
  writeCompletion: (commandName: StreamingCommandName, result: unknown) => void
}

function createStreamWriter(io: CliIO, json: boolean): StreamWriter {
  return {
    write(event) {
      if (json) {
        io.stdout(JSON.stringify(event))
        return
      }

      switch (event.event) {
        case 'stdout':
          io.stdout(event.line ?? '')
          return
        case 'stderr':
          io.stderr(event.line ?? '')
          return
        case 'run_start':
          io.stdout(
            `[run-cells] start path=${event.path ?? '-'} range=${String((event as { start_index?: unknown }).start_index ?? 0)}..${String((event as { end_index?: unknown }).end_index ?? '-')}`,
          )
          return
        case 'cell_start':
          io.stdout(`[${event.command}] cell ${event.cell_index} start`)
          return
        case 'cell_skipped':
          io.stdout(`[${event.command}] cell ${event.cell_index} skipped: ${event.reason}`)
          return
        case 'cell_complete':
          io.stdout(
            `[${event.command}] cell ${event.cell_index} complete status=${event.status} execution_count=${event.execution_count ?? '-'}`,
          )
          return
        case 'exec_complete':
          io.stdout(
            `[execute-code] complete status=${event.status} execution_count=${event.execution_count ?? '-'}`,
          )
          return
        case 'command_complete':
          io.stdout(`[run-command] complete exit_code=${event.exit_code}`)
          return
        case 'run_complete':
          io.stdout(
            `[run-cells] complete path=${event.path ?? '-'} range=${event.start_index}..${event.end_index}`,
          )
          return
        default:
          return
      }
    },
    writeCompletion(commandName, result) {
      if (json) {
        return
      }
      switch (commandName) {
        case 'execute-code': {
          const execution = result as ExecutionResult
          io.stdout(
            `summary status=${execution.status} execution_count=${execution.execution_count ?? '-'} stderr_lines=${countLines(execution.stderr)}`,
          )
          return
        }
        case 'run-cell': {
          const data = result as { index: number; result: ExecutionResult; path?: string }
          io.stdout(
            `summary path=${data.path ?? '-'} cell=${data.index} status=${data.result.status} execution_count=${data.result.execution_count ?? '-'}`,
          )
          return
        }
        case 'run-cells': {
          const data = result as {
            path?: string
            start_index: number
            end_index: number
            results?: unknown[]
          }
          io.stdout(
            `summary path=${data.path ?? '-'} range=${data.start_index}..${data.end_index} results=${Array.isArray(data.results) ? data.results.length : 0}`,
          )
          return
        }
        case 'run-command': {
          const data = result as { exit_code: number }
          io.stdout(`summary exit_code=${data.exit_code}`)
          return
        }
      }
    },
  }
}

function createStreamEventEmitter(
  writer: StreamWriter,
  command: ExecutionStreamCommand,
  requestId: string,
  path?: string,
) {
  const buildEvent = createExecutionEventFactory(command, requestId, path)
  return (event: Partial<ExecutionStreamEvent> & Pick<ExecutionStreamEvent, 'event'>) => {
    writer.write(buildEvent(event))
  }
}

function createLineEventEmitters(
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
    emit,
    onStream: (stream: 'stdout' | 'stderr', text: string) => {
      if (stream === 'stderr') {
        stderrSplitter.push(text)
        return
      }
      stdoutSplitter.push(text)
    },
    flush: () => {
      stdoutSplitter.flush()
      stderrSplitter.flush()
    },
  }
}

async function runRemoteStreamingCommand(
  commandName: StreamingCommandName,
  writer: StreamWriter,
  registry: UnifiedConnectionRegistry,
  connectionId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (commandName) {
    case 'execute-code':
      return await streamRemoteExecuteCode(writer, registry, connectionId, input)
    case 'run-cell':
      return await streamRemoteRunCell(writer, registry, connectionId, input)
    case 'run-cells':
      return await streamRemoteRunCells(writer, registry, connectionId, input)
    case 'run-command':
      return await streamRemoteRunCommand(writer, registry, connectionId, input)
  }
}

async function streamRemoteExecuteCode(
  writer: StreamWriter,
  registry: UnifiedConnectionRegistry,
  connectionId: string,
  input: Record<string, unknown>,
): Promise<ExecutionResult> {
  const path = requiredString(input.path as string | undefined, 'path')
  const requestId = crypto.randomUUID()
  const emit = createStreamEventEmitter(writer, 'execute_code', requestId, path)
  const stream = createLineEventEmitters(emit)
  const execution = await registry.remote.executeCode(
    connectionId,
    path,
    String(input.code),
    Number(input.timeout_sec),
    stream.onStream,
  )
  stream.flush()
  emit({
    event: 'exec_complete',
    status: execution.status,
    execution_count: execution.execution_count,
    error: execution.error,
  })
  return execution
}

async function streamRemoteRunCell(
  writer: StreamWriter,
  registry: UnifiedConnectionRegistry,
  connectionId: string,
  input: Record<string, unknown>,
) {
  const path = requiredString(input.path as string | undefined, 'path')
  const index = Number(input.index)
  const timeoutSec = Number(input.timeout_sec)
  const save = Boolean(input.save)
  const requestId = crypto.randomUUID()
  const emit = createStreamEventEmitter(writer, 'run_cell', requestId, path)
  const connection = registry.remote.get(connectionId)
  const notebookModel = await connection.jupyterClient.getNotebook(path)
  const notebook = notebookModel.content!
  const cell = notebook.cells[index]
  if (!cell) {
    throw new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)
  }
  if (cell.cell_type !== 'code') {
    throw new RemoteJupyterError('invalid_request', `Cell ${index} is not a code cell`)
  }

  emit({
    event: 'cell_start',
    cell_index: index,
  })
  const stream = createLineEventEmitters(emit, index)
  const execution = await registry.remote.executeCode(
    connectionId,
    path,
    getCellSource(cell),
    timeoutSec,
    stream.onStream,
  )
  stream.flush()
  const updatedNotebook = applyExecutionToCell(notebook, index, execution)
  const saved = save ? await connection.jupyterClient.saveNotebook(path, updatedNotebook) : null
  emit({
    event: 'cell_complete',
    cell_index: index,
    status: execution.status,
    execution_count: execution.execution_count,
    error: execution.error,
    saved: Boolean(saved),
  })
  return {
    path,
    index,
    result: execution,
    cell: updatedNotebook.cells[index],
    saved,
  }
}

async function streamRemoteRunCells(
  writer: StreamWriter,
  registry: UnifiedConnectionRegistry,
  connectionId: string,
  input: Record<string, unknown>,
) {
  const path = requiredString(input.path as string | undefined, 'path')
  const startIndex = Number(input.start_index ?? 0)
  const timeoutSec = Number(input.timeout_sec)
  const stopOnError = Boolean(input.stop_on_error)
  const save = Boolean(input.save)
  const requestId = crypto.randomUUID()
  const emit = createStreamEventEmitter(writer, 'run_cells', requestId, path)
  const connection = registry.remote.get(connectionId)
  const notebookModel = await connection.jupyterClient.getNotebook(path)
  let notebook: JupyterNotebook = notebookModel.content!
  const finalIndex = Math.min(
    Number(input.end_index ?? notebook.cells.length - 1),
    notebook.cells.length - 1,
  )
  const results: Array<Record<string, unknown>> = []

  emit({
    event: 'run_start',
    start_index: startIndex,
    end_index: finalIndex,
  })

  for (let index = startIndex; index <= finalIndex; index += 1) {
    const cell = notebook.cells[index]
    if (!cell) {
      break
    }
    if (cell.cell_type !== 'code') {
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
    const stream = createLineEventEmitters(emit, index)
    const execution = await registry.remote.executeCode(
      connectionId,
      path,
      getCellSource(cell),
      timeoutSec,
      stream.onStream,
    )
    stream.flush()
    notebook = applyExecutionToCell(notebook, index, execution)
    results.push({
      index,
      status: execution.status,
      result: execution,
    })
    emit({
      event: 'cell_complete',
      cell_index: index,
      status: execution.status,
      execution_count: execution.execution_count,
      error: execution.error,
      saved: save,
    })

    if (execution.status === 'error' && stopOnError) {
      break
    }
  }

  const saved = save ? await connection.jupyterClient.saveNotebook(path, notebook) : null
  emit({
    event: 'run_complete',
    start_index: startIndex,
    end_index: finalIndex,
    saved: Boolean(saved),
  })
  return {
    path,
    start_index: startIndex,
    end_index: finalIndex,
    results,
    saved,
  }
}

async function streamRemoteRunCommand(
  writer: StreamWriter,
  registry: UnifiedConnectionRegistry,
  connectionId: string,
  input: Record<string, unknown>,
) {
  const path = requiredString(input.path as string | undefined, 'path')
  const timeoutSec = Number(input.timeout_sec)
  const requestId = crypto.randomUUID()
  const marker = '__REMOTE_JUPYTER_MCP_RUN_COMMAND__'
  const session = await registry.remote.ensureNotebookSession(connectionId, path)
  assertPythonKernel(session.kernelName)
  const emit = createStreamEventEmitter(writer, 'run_command', requestId, path)
  const stream = createLineEventEmitters(emit, undefined, {
    stdout: (line) => !line.startsWith(marker),
  })
  const execution = await registry.remote.executeCode(
    connectionId,
    path,
    createRunCommandCode(
      String(input.command),
      input.cwd as string | undefined,
      input.env as Record<string, string> | undefined,
    ),
    timeoutSec,
    stream.onStream,
  )
  stream.flush()
  const payloadLine = execution.stdout.split('\n').find((line) => line.startsWith(marker))
  if (!payloadLine) {
    throw new RemoteJupyterError(
      'remote_io_failed',
      'run_command did not return a parseable payload',
      execution,
    )
  }
  const parsed = JSON.parse(payloadLine.slice(marker.length)) as { exit_code: number }
  emit({
    event: 'command_complete',
    exit_code: parsed.exit_code,
  })
  return parsed
}

function countLines(text: string): number {
  if (!text) {
    return 0
  }
  return text.split('\n').filter((line) => line.length > 0).length
}

function isStreamingCommand(commandName: string): commandName is StreamingCommandName {
  return (
    commandName === 'execute-code' ||
    commandName === 'run-cell' ||
    commandName === 'run-cells' ||
    commandName === 'run-command'
  )
}

function toActionName(commandName: string) {
  const action = cliActionMap.get(commandName)
  if (!action) {
    throw new Error(`Unknown action: ${commandName}`)
  }
  return action.name as (typeof actionDefinitions)[number]['name']
}

async function resolveConnectionConfig(options: Record<string, unknown>): Promise<ResolvedConnectionConfig> {
  const profileName = getStringOption(options, 'profile')
  const profile = profileName ? await getProfile(profileName) : null
  const backend = resolveBackend(options, profile)

  if (backend === 'vscode-host') {
    const resolved = cleanUndefined({
      backend,
      host: getStringOption(options, 'vscode-host') ?? profile?.vscode_host ?? '127.0.0.1',
      port: getNumberOption(options, 'vscode-port') ?? profile?.vscode_port,
      token: getStringOption(options, 'vscode-token') ?? profile?.vscode_token,
      secure:
        getExplicitBooleanOption(options, 'vscode-secure') ?? profile?.vscode_secure ?? false,
      default_notebook_path: profile?.default_notebook_path,
    }) as ConnectVscodeHostInput & {
      backend: 'vscode-host'
      default_notebook_path?: string
    }

    if (!resolved.port || !resolved.token) {
      throw new Error(
        'VS Code host settings require --vscode-port and --vscode-token, or a profile with those fields',
      )
    }

    return resolved
  }

    const resolved = cleanUndefined({
      backend,
      jupyter_base_url: getStringOption(options, 'jupyter-base-url') ?? profile?.jupyter_base_url,
      jupyter_host: getStringOption(options, 'jupyter-host') ?? profile?.jupyter_host,
    jupyter_port: getNumberOption(options, 'jupyter-port') ?? profile?.jupyter_port,
    jupyter_protocol:
      (getStringOption(options, 'jupyter-protocol') as 'http' | 'https' | undefined) ??
      profile?.jupyter_protocol,
      jupyter_token: getStringOption(options, 'jupyter-token') ?? profile?.jupyter_token,
      jupyter_base_path: getStringOption(options, 'jupyter-base-path') ?? profile?.jupyter_base_path,
      default_notebook_path: profile?.default_notebook_path,
    }) as ConnectRemoteJupyterInput & {
      backend: 'remote-jupyter'
      default_notebook_path?: string
    }

  if (!resolved.jupyter_base_url && !resolved.jupyter_port && !resolved.jupyter_host) {
    throw new Error(
      'Connection settings require --jupyter-base-url, or --jupyter-host/--jupyter-port, or a profile with those fields',
    )
  }

  return resolved
}

async function buildEphemeralActionInput(
  commandName: string,
  options: Record<string, unknown>,
  connectionId: string,
  connectInput: ResolvedConnectionConfig,
): Promise<Record<string, unknown>> {
  const path = getStringOption(options, 'path') ?? connectInput.default_notebook_path
  const metadataJson = getJsonOption(options, 'metadata-json')
  const envJson = getJsonOption(options, 'env-json')

  switch (commandName) {
    case 'list-jupyter-contents':
      return { connection_id: connectionId, path: getStringOption(options, 'path') ?? '' }
    case 'read-jupyter-file':
      return { connection_id: connectionId, path: requiredString(path, 'path'), format: getNullableStringOption(options, 'format') }
    case 'write-jupyter-file':
      return {
        connection_id: connectionId,
        path: requiredString(path, 'path'),
        content: await resolveInlineOrFileOption(options, 'content', 'content-file'),
        format: getStringOption(options, 'format') ?? 'text',
        create_dirs: getBooleanOption(options, 'create-dirs', true),
      }
    case 'create-notebook':
      return {
        connection_id: connectionId,
        path: requiredString(path, 'path'),
        kernel_name: getStringOption(options, 'kernel-name') ?? 'python3',
      }
    case 'get-notebook':
    case 'list-cells':
      return cleanUndefined({ connection_id: connectionId, path })
    case 'insert-cell':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        index: requiredNumberOption(options, 'index'),
        cell_type: requiredStringOption(options, 'cell-type'),
        source: await resolveInlineOrFileOption(options, 'source', 'source-file'),
        metadata: (metadataJson as Record<string, unknown> | undefined) ?? {},
      })
    case 'update-cell':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        index: requiredNumberOption(options, 'index'),
        source: await resolveInlineOrFileOption(options, 'source', 'source-file', false),
        metadata: metadataJson as Record<string, unknown> | undefined,
        cell_type: getStringOption(options, 'cell-type'),
      })
    case 'delete-cell':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        index: requiredNumberOption(options, 'index'),
      })
    case 'move-cell':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        from_index: requiredNumberOption(options, 'from-index'),
        to_index: requiredNumberOption(options, 'to-index'),
      })
    case 'execute-code':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        code: await resolveInlineOrFileOption(options, 'code', 'code-file'),
        timeout_sec: getNumberOption(options, 'timeout-sec') ?? 120,
      })
    case 'run-cell':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        index: requiredNumberOption(options, 'index'),
        timeout_sec: getNumberOption(options, 'timeout-sec') ?? 120,
        save: getBooleanOption(options, 'save', true),
      })
    case 'run-cells':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        start_index: getNumberOption(options, 'start-index') ?? 0,
        end_index: getNumberOption(options, 'end-index'),
        timeout_sec: getNumberOption(options, 'timeout-sec') ?? 120,
        stop_on_error: getBooleanOption(options, 'stop-on-error', true),
        save: getBooleanOption(options, 'save', true),
      })
    case 'run-command':
      return cleanUndefined({
        connection_id: connectionId,
        path,
        command: requiredStringOption(options, 'command'),
        cwd: getStringOption(options, 'cwd'),
        env: envJson as Record<string, string> | undefined,
        timeout_sec: getNumberOption(options, 'timeout-sec') ?? 120,
      })
    case 'upload-file':
      return {
        connection_id: connectionId,
        local_path: requiredStringOption(options, 'local-path'),
        remote_path: requiredStringOption(options, 'remote-path'),
        create_dirs: getBooleanOption(options, 'create-dirs', true),
      }
    case 'download-file':
      return {
        connection_id: connectionId,
        remote_path: requiredStringOption(options, 'remote-path'),
        local_path: requiredStringOption(options, 'local-path'),
        overwrite: getBooleanOption(options, 'overwrite', false),
      }
    default:
      throw new Error(`Unsupported action for CLI: ${commandName}`)
  }
}

function validateProfile(profile: CliProfile): void {
  if (profile.backend === 'vscode-host') {
    if (!profile.vscode_port || !profile.vscode_token) {
      throw new Error('vscode-host profile requires --vscode-port and --vscode-token')
    }
    return
  }

  if (!profile.jupyter_base_url && !profile.jupyter_port && !profile.jupyter_host) {
    throw new Error(
      'remote-jupyter profile requires --jupyter-base-url, or at least --jupyter-host/--jupyter-port',
    )
  }
}

function resolveBackend(options: Record<string, unknown>, profile: CliProfile | null): BackendOption {
  const explicit = getStringOption(options, 'backend') as BackendOption | undefined
  if (explicit) {
    return explicit
  }
  if (
    getStringOption(options, 'vscode-host') ||
    getNumberOption(options, 'vscode-port') ||
    getStringOption(options, 'vscode-token')
  ) {
    return 'vscode-host'
  }
  return profile?.backend ?? 'remote-jupyter'
}

export function parseArgs(argv: string[], specs: Record<string, OptionSpec>): ParsedArgs {
  const positionals: string[] = []
  const options: Record<string, unknown> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const [rawKeyValue, inlineValue] = token.slice(2).split('=', 2)
    const rawKey = rawKeyValue ?? ''
    const spec = specs[rawKey]
    if (!spec) {
      throw new Error(`Unknown option: --${rawKey}`)
    }

    const valueToken =
      inlineValue !== undefined
        ? inlineValue
        : index + 1 < argv.length && !(argv[index + 1] ?? '').startsWith('--')
          ? argv[++index]
          : undefined

    options[rawKey] = coerceOptionValue(spec.type, valueToken)
  }

  return {
    positionals,
    options,
  }
}

function coerceOptionValue(type: OptionType, rawValue?: string): unknown {
  switch (type) {
    case 'boolean':
      if (rawValue === undefined) {
        return true
      }
      if (rawValue === 'true') {
        return true
      }
      if (rawValue === 'false') {
        return false
      }
      throw new Error(`Invalid boolean value: ${rawValue}`)
    case 'number':
      if (rawValue === undefined) {
        throw new Error('Missing numeric option value')
      }
      return Number(rawValue)
    case 'json':
      if (rawValue === undefined) {
        throw new Error('Missing JSON option value')
      }
      return JSON.parse(rawValue)
    case 'string':
      if (rawValue === undefined) {
        throw new Error('Missing string option value')
      }
      return rawValue
  }
}

function writeOutput(io: CliIO, commandName: string, result: unknown, json: boolean): void {
  io.stdout(json ? JSON.stringify(result, null, 2) : formatHuman(commandName, result))
}

function defaultPrinter(stream: NodeJS.WriteStream) {
  return (text: string) => {
    stream.write(text.endsWith('\n') ? text : `${text}\n`)
  }
}

const defaultIO: CliIO = {
  stdout: defaultPrinter(process.stdout),
  stderr: defaultPrinter(process.stderr),
}

function renderHelp(): string {
  const actionLines = actionDefinitions
    .map((action) => `  ${action.cliName}`)
    .join('\n')

  return `agentic-jupyter

Usage:
  agentic-jupyter serve
  agentic-jupyter help
  agentic-jupyter version
  agentic-jupyter profile <set|get|list|delete> ...
  agentic-jupyter <command> [--profile NAME] [--json] [flags]

Commands:
${actionLines}

Profile file:
  ${getProfilesPath()}
`
}

function cleanUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T
}

function requiredString(path: string | undefined, key: string): string {
  if (!path) {
    throw new Error(`Missing required option: --${key}`)
  }
  return path
}

function requiredStringOption(options: Record<string, unknown>, key: string): string {
  const value = getStringOption(options, key)
  if (!value) {
    throw new Error(`Missing required option: --${key}`)
  }
  return value
}

function getStringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key]
  return typeof value === 'string' ? value : undefined
}

function getNullableStringOption(options: Record<string, unknown>, key: string): string | null {
  const value = getStringOption(options, key)
  return value ?? null
}

function requiredNumberOption(options: Record<string, unknown>, key: string): number {
  const value = getNumberOption(options, key)
  if (value === undefined || Number.isNaN(value)) {
    throw new Error(`Missing required option: --${key}`)
  }
  return value
}

function getNumberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key]
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined
}

function getBooleanOption(options: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = options[key]
  return typeof value === 'boolean' ? value : fallback
}

function getExplicitBooleanOption(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key]
  return typeof value === 'boolean' ? value : undefined
}

function getJsonOption(options: Record<string, unknown>, key: string): unknown {
  return options[key]
}

async function resolveInlineOrFileOption(
  options: Record<string, unknown>,
  inlineKey: string,
  fileKey: string,
  required = true,
): Promise<string | undefined> {
  const inlineValue = getStringOption(options, inlineKey)
  const fileValue = getStringOption(options, fileKey)

  if (inlineValue !== undefined && fileValue !== undefined) {
    throw new Error(`Use either --${inlineKey} or --${fileKey}, not both`)
  }

  if (inlineValue !== undefined) {
    return inlineValue
  }

  if (fileValue !== undefined) {
    return await readFile(fileValue, 'utf8')
  }

  if (required) {
    throw new Error(`Missing required option: --${inlineKey} or --${fileKey}`)
  }

  return undefined
}
