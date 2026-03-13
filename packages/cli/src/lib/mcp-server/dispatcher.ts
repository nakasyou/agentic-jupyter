import {
  actionDefinitions,
  applyExecutionToCell,
  assertPythonKernel,
  cliActionMap,
  createCell,
  createEmptyNotebook,
  createRunCommandCode,
  deleteCell,
  getCellSource,
  listCells,
  moveCell,
  RemoteJupyterError,
  toRemoteJupyterError,
  type ConnectRemoteJupyterInput,
  type ConnectVscodeHostInput,
} from '../core/index.js'
import { ConnectionRegistry as RemoteConnectionRegistry } from '../backend-jupyter/index.js'
import { VscodeHostConnectionRegistry } from '../backend-vscode-client/index.js'
import type { BackendKind } from '../core/index.js'
import { dirname } from 'node:path'
import { z } from 'zod/v4'

type ActionName = (typeof actionDefinitions)[number]['name']

export class UnifiedConnectionRegistry {
  readonly remote = new RemoteConnectionRegistry()
  readonly vscode = new VscodeHostConnectionRegistry()
  private readonly backends = new Map<string, BackendKind>()

  async connectRemote(input: ConnectRemoteJupyterInput) {
    const result = await this.remote.connect(input)
    this.backends.set(result.connection_id, 'remote-jupyter')
    return result
  }

  async connectVscode(input: ConnectVscodeHostInput) {
    const result = await this.vscode.connect(input)
    this.backends.set(result.connection_id, 'vscode-host')
    return result
  }

  getBackend(connectionId: string): BackendKind {
    const backend = this.backends.get(connectionId)
    if (!backend) {
      throw new RemoteJupyterError('not_found', `Unknown connection_id: ${connectionId}`)
    }
    return backend
  }

  async disconnect(connectionId: string) {
    const backend = this.getBackend(connectionId)
    this.backends.delete(connectionId)
    return backend === 'remote-jupyter'
      ? await this.remote.disconnect(connectionId)
      : await this.vscode.disconnect(connectionId)
  }

  async getStatus(connectionId: string) {
    const backend = this.getBackend(connectionId)
    return backend === 'remote-jupyter'
      ? await this.remote.getStatus(connectionId)
      : await this.vscode.getStatus(connectionId)
  }
}

function optionalPathForVscode(path?: string): string {
  return path && path.length > 0 ? path : '@active'
}

function requiredPath(path: string | undefined): string {
  if (!path) {
    throw new RemoteJupyterError('invalid_request', 'This backend requires a notebook path')
  }
  return path
}

export async function executeAction(
  registry: UnifiedConnectionRegistry,
  actionName: ActionName,
  input: unknown,
): Promise<unknown> {
  const definition = actionDefinitions.find((action) => action.name === actionName)
  if (!definition) {
    throw new RemoteJupyterError('invalid_request', `Unknown action ${actionName}`)
  }
  const parsed = definition.inputSchema.parse(input) as Record<string, unknown>

  switch (actionName) {
    case 'connect_remote_jupyter':
      return await registry.connectRemote(parsed as ConnectRemoteJupyterInput)
    case 'connect_vscode_host':
      return await registry.connectVscode(parsed as unknown as ConnectVscodeHostInput)
    case 'disconnect_remote_jupyter':
      return await registry.disconnect(String(parsed.connection_id))
    case 'get_connection_status':
      return await registry.getStatus(String(parsed.connection_id))
    default:
      return await executeNotebookAction(registry, actionName, parsed)
  }
}

async function executeNotebookAction(
  registry: UnifiedConnectionRegistry,
  actionName: ActionName,
  input: Record<string, unknown>,
): Promise<unknown> {
  const connectionId = String(input.connection_id)
  const backend = registry.getBackend(connectionId)

  if (backend === 'vscode-host') {
    const params = { ...input, path: optionalPathForVscode(input.path as string | undefined) }
    return await registry.vscode.request(connectionId, actionName, params)
  }

  const path = input.path as string | undefined
  switch (actionName) {
    case 'list_jupyter_contents': {
      const connection = registry.remote.get(connectionId)
      return await connection.jupyterClient.listContents(String(input.path ?? ''))
    }
    case 'read_jupyter_file': {
      const connection = registry.remote.get(connectionId)
      return await connection.jupyterClient.getContent(requiredPath(path), {
        content: true,
        format: ((input.format as 'text' | 'base64' | null) ?? undefined) || undefined,
      })
    }
    case 'write_jupyter_file':
      return await registry.remote.writeJupyterFile(
        connectionId,
        requiredPath(path),
        String(input.content),
        input.format as 'text' | 'base64',
        Boolean(input.create_dirs),
      )
    case 'create_notebook': {
      await registry.remote.ensureJupyterDirectory(connectionId, dirname(requiredPath(path)))
      const connection = registry.remote.get(connectionId)
      const notebook = createEmptyNotebook(String(input.kernel_name))
      return await connection.jupyterClient.saveNotebook(requiredPath(path), notebook)
    }
    case 'get_notebook': {
      const connection = registry.remote.get(connectionId)
      return await connection.jupyterClient.getNotebook(requiredPath(path))
    }
    case 'list_cells': {
      const connection = registry.remote.get(connectionId)
      const notebook = await connection.jupyterClient.getNotebook(requiredPath(path))
      return {
        path: requiredPath(path),
        cells: listCells(notebook.content!),
      }
    }
    case 'insert_cell': {
      const connection = registry.remote.get(connectionId)
      const notebook = await connection.jupyterClient.getNotebook(requiredPath(path))
      const updated = (await import('../core/index.js')).insertCell(
        notebook.content!,
        Number(input.index),
        createCell(input.cell_type as 'code' | 'markdown' | 'raw', String(input.source), (input
          .metadata ?? {}) as Record<string, unknown>),
      )
      return await connection.jupyterClient.saveNotebook(requiredPath(path), updated)
    }
    case 'update_cell': {
      const connection = registry.remote.get(connectionId)
      const notebook = await connection.jupyterClient.getNotebook(requiredPath(path))
      const { updateCell } = await import('../core/index.js')
      const updated = updateCell(notebook.content!, Number(input.index), {
        source: input.source as string | undefined,
        metadata: input.metadata as Record<string, unknown> | undefined,
        cell_type: input.cell_type as 'code' | 'markdown' | 'raw' | undefined,
      })
      return await connection.jupyterClient.saveNotebook(requiredPath(path), updated)
    }
    case 'delete_cell': {
      const connection = registry.remote.get(connectionId)
      const notebook = await connection.jupyterClient.getNotebook(requiredPath(path))
      const updated = deleteCell(notebook.content!, Number(input.index))
      return await connection.jupyterClient.saveNotebook(requiredPath(path), updated)
    }
    case 'move_cell': {
      const connection = registry.remote.get(connectionId)
      const notebook = await connection.jupyterClient.getNotebook(requiredPath(path))
      const updated = moveCell(notebook.content!, Number(input.from_index), Number(input.to_index))
      return await connection.jupyterClient.saveNotebook(requiredPath(path), updated)
    }
    case 'execute_code':
      return await registry.remote.executeCode(
        connectionId,
        requiredPath(path),
        String(input.code),
        Number(input.timeout_sec),
      )
    case 'run_cell': {
      const connection = registry.remote.get(connectionId)
      const notebook = await connection.jupyterClient.getNotebook(requiredPath(path))
      const cell = notebook.content!.cells[Number(input.index)]
      if (!cell) {
        throw new RemoteJupyterError('not_found', `Cell index ${input.index} is out of range`)
      }
      if (cell.cell_type !== 'code') {
        throw new RemoteJupyterError('invalid_request', `Cell ${input.index} is not a code cell`)
      }

      const execution = await registry.remote.executeCode(
        connectionId,
        requiredPath(path),
        getCellSource(cell),
        Number(input.timeout_sec),
      )
      const updatedNotebook = applyExecutionToCell(notebook.content!, Number(input.index), execution)
      const saved = input.save
        ? await connection.jupyterClient.saveNotebook(requiredPath(path), updatedNotebook)
        : null
      return {
        path: requiredPath(path),
        index: Number(input.index),
        result: execution,
        cell: updatedNotebook.cells[Number(input.index)],
        saved,
      }
    }
    case 'run_cells': {
      const connection = registry.remote.get(connectionId)
      const notebookModel = await connection.jupyterClient.getNotebook(requiredPath(path))
      let notebook = notebookModel.content!
      const startIndex = Number(input.start_index ?? 0)
      const finalIndex = Math.min(
        Number(input.end_index ?? notebook.cells.length - 1),
        notebook.cells.length - 1,
      )
      const results: Array<Record<string, unknown>> = []

      for (let index = startIndex; index <= finalIndex; index += 1) {
        const cell = notebook.cells[index]
        if (!cell) {
          break
        }
        if (cell.cell_type !== 'code') {
          results.push({
            index,
            status: 'skipped',
            reason: `Cell ${index} is not a code cell`,
          })
          continue
        }

        const execution = await registry.remote.executeCode(
          connectionId,
          requiredPath(path),
          getCellSource(cell),
          Number(input.timeout_sec),
        )
        notebook = applyExecutionToCell(notebook, index, execution)
        results.push({
          index,
          status: execution.status,
          result: execution,
        })

        if (execution.status === 'error' && Boolean(input.stop_on_error)) {
          break
        }
      }

      const saved = input.save
        ? await connection.jupyterClient.saveNotebook(requiredPath(path), notebook)
        : null

      return {
        path: requiredPath(path),
        start_index: startIndex,
        end_index: finalIndex,
        results,
        saved,
      }
    }
    case 'run_command': {
      const session = await registry.remote.ensureNotebookSession(connectionId, requiredPath(path))
      assertPythonKernel(session.kernelName)
      const result = await registry.remote.executeCode(
        connectionId,
        requiredPath(path),
        createRunCommandCode(
          String(input.command),
          input.cwd as string | undefined,
          input.env as Record<string, string> | undefined,
        ),
        Number(input.timeout_sec),
      )
      const marker = '__REMOTE_JUPYTER_MCP_RUN_COMMAND__'
      const payloadLine = result.stdout.split('\n').find((line) => line.startsWith(marker))
      if (!payloadLine) {
        throw new RemoteJupyterError(
          'remote_io_failed',
          'run_command did not return a parseable payload',
          result,
        )
      }
      return JSON.parse(payloadLine.slice(marker.length))
    }
    case 'upload_file':
      return await registry.remote.uploadFile(
        connectionId,
        String(input.local_path),
        String(input.remote_path),
        Boolean(input.create_dirs),
      )
    case 'download_file':
      return await registry.remote.downloadFile(
        connectionId,
        String(input.remote_path),
        String(input.local_path),
        Boolean(input.overwrite),
      )
    default:
      throw new RemoteJupyterError('invalid_request', `Unsupported action ${actionName}`)
  }
}

export function createJsonError(error: unknown) {
  const normalized = toRemoteJupyterError(error)
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details ?? null,
    },
  }
}

export function getCliAction(name: string) {
  return cliActionMap.get(name)
}

export function getActionSchema(name: string) {
  return actionDefinitions.find((action) => action.name === name)?.inputSchema as
    | z.ZodObject<any>
    | undefined
}
