import type { ExecutionResult } from './types.js';
export type ExecutionStreamCommand = 'execute_code' | 'run_cell' | 'run_cells' | 'run_command';
export type ExecutionStreamEventType = 'run_start' | 'cell_start' | 'cell_skipped' | 'stdout' | 'stderr' | 'cell_complete' | 'run_complete' | 'exec_complete' | 'command_complete';
export interface ExecutionStreamEventBase {
    event: ExecutionStreamEventType;
    command: ExecutionStreamCommand;
    request_id: string;
    path?: string;
    timestamp: string;
    sequence: number;
    cell_index?: number;
    start_index?: number;
    end_index?: number;
    reason?: string;
    status?: ExecutionResult['status'];
    execution_count?: number | null;
    error?: ExecutionResult['error'];
    saved?: boolean;
    exit_code?: number;
    line?: string;
    newline?: boolean;
}
export type ExecutionStreamEvent = ExecutionStreamEventBase;
export declare class ExecutionLineSplitter {
    private readonly onLine;
    private buffer;
    constructor(onLine: (line: string, newline: boolean) => void);
    push(text: string): void;
    flush(): void;
}
export declare function createExecutionEventFactory(command: ExecutionStreamCommand, requestId: string, path?: string): (event: Partial<ExecutionStreamEvent> & Pick<ExecutionStreamEvent, 'event'>) => ExecutionStreamEvent;
