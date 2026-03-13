import type { JupyterCell, JupyterCellOutput, JupyterNotebook } from './types.js';
export declare function createEmptyNotebook(kernelName?: string): JupyterNotebook;
export declare function createCell(cellType: JupyterCell['cell_type'], source: string, metadata?: Record<string, unknown>): JupyterCell;
export declare function insertCell(notebook: JupyterNotebook, index: number, cell: JupyterCell): JupyterNotebook;
export declare function updateCell(notebook: JupyterNotebook, index: number, patch: {
    source?: string;
    metadata?: Record<string, unknown>;
    cell_type?: JupyterCell['cell_type'];
}): JupyterNotebook;
export declare function deleteCell(notebook: JupyterNotebook, index: number): JupyterNotebook;
export declare function moveCell(notebook: JupyterNotebook, fromIndex: number, toIndex: number): JupyterNotebook;
export declare function applyExecutionToCell(notebook: JupyterNotebook, index: number, execution: {
    outputs: JupyterCellOutput[];
    execution_count: number | null;
}): JupyterNotebook;
export declare function summarizeCellOutput(output: JupyterCellOutput): string;
export declare function listCells(notebook: JupyterNotebook): {
    index: number;
    cell_type: "code" | "markdown" | "raw";
    source: string;
    execution_count: number | null;
    outputs_summary: string[];
}[];
export declare function getNotebookKernelName(notebook: JupyterNotebook): string;
export declare function getCellSource(cell: JupyterCell): string;
