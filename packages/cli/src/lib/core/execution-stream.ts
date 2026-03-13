import type { ExecutionResult } from './types.js'

export type ExecutionStreamCommand = 'execute_code' | 'run_cell' | 'run_cells' | 'run_command'
export type ExecutionStreamEventType =
  | 'run_start'
  | 'cell_start'
  | 'cell_skipped'
  | 'stdout'
  | 'stderr'
  | 'cell_complete'
  | 'run_complete'
  | 'exec_complete'
  | 'command_complete'

export interface ExecutionStreamEventBase {
  event: ExecutionStreamEventType
  command: ExecutionStreamCommand
  request_id: string
  path?: string
  timestamp: string
  sequence: number
  cell_index?: number
  start_index?: number
  end_index?: number
  reason?: string
  status?: ExecutionResult['status']
  execution_count?: number | null
  error?: ExecutionResult['error']
  saved?: boolean
  exit_code?: number
  line?: string
  newline?: boolean
}
export type ExecutionStreamEvent = ExecutionStreamEventBase

export class ExecutionLineSplitter {
  private buffer = ''

  constructor(private readonly onLine: (line: string, newline: boolean) => void) {}

  push(text: string): void {
    if (!text) {
      return
    }

    this.buffer += text

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const line = this.buffer.slice(0, newlineIndex + 1)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      this.onLine(line, true)
    }
  }

  flush(): void {
    if (!this.buffer) {
      return
    }
    this.onLine(this.buffer, false)
    this.buffer = ''
  }
}

export function createExecutionEventFactory(
  command: ExecutionStreamCommand,
  requestId: string,
  path?: string,
): (event: Partial<ExecutionStreamEvent> & Pick<ExecutionStreamEvent, 'event'>) => ExecutionStreamEvent {
  let sequence = 0

  return (event) => ({
    command,
    request_id: requestId,
    path,
    timestamp: new Date().toISOString(),
    sequence: sequence++,
    ...event,
  }) as ExecutionStreamEvent
}
