import type { JupyterCell, JupyterCellOutput, JupyterCodeCell, JupyterNotebook } from './types.js'
import { RemoteJupyterError } from './errors.js'

function toSourceString(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source
}

function cloneCell<T>(cell: T): T {
  return structuredClone(cell)
}

export function createEmptyNotebook(kernelName = 'python3'): JupyterNotebook {
  return {
    cells: [],
    metadata: {
      kernelspec: {
        name: kernelName,
        display_name: kernelName,
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

export function createCell(
  cellType: JupyterCell['cell_type'],
  source: string,
  metadata: Record<string, unknown> = {},
): JupyterCell {
  if (cellType === 'code') {
    return {
      cell_type: 'code',
      metadata,
      source,
      execution_count: null,
      outputs: [],
    }
  }

  return {
    cell_type: cellType,
    metadata,
    source,
  }
}

function assertCellIndex(notebook: JupyterNotebook, index: number): void {
  if (index < 0 || index >= notebook.cells.length) {
    throw new RemoteJupyterError('not_found', `Cell index ${index} is out of range`)
  }
}

export function insertCell(
  notebook: JupyterNotebook,
  index: number,
  cell: JupyterCell,
): JupyterNotebook {
  const next = structuredClone(notebook)
  const boundedIndex = Math.max(0, Math.min(index, next.cells.length))
  next.cells.splice(boundedIndex, 0, cloneCell(cell))
  return next
}

export function updateCell(
  notebook: JupyterNotebook,
  index: number,
  patch: {
    source?: string
    metadata?: Record<string, unknown>
    cell_type?: JupyterCell['cell_type']
  },
): JupyterNotebook {
  assertCellIndex(notebook, index)
  const next = structuredClone(notebook)
  const current = next.cells[index]!
  const nextType = patch.cell_type ?? current.cell_type
  const nextSource = patch.source ?? toSourceString(current.source)
  const nextMetadata = patch.metadata ?? current.metadata
  const rebuilt = createCell(nextType, nextSource, nextMetadata)

  if (nextType === 'code' && current.cell_type === 'code') {
    ;(rebuilt as JupyterCodeCell).execution_count = current.execution_count
    ;(rebuilt as JupyterCodeCell).outputs = structuredClone(current.outputs)
  }

  next.cells[index] = rebuilt
  return next
}

export function deleteCell(notebook: JupyterNotebook, index: number): JupyterNotebook {
  assertCellIndex(notebook, index)
  const next = structuredClone(notebook)
  next.cells.splice(index, 1)
  return next
}

export function moveCell(
  notebook: JupyterNotebook,
  fromIndex: number,
  toIndex: number,
): JupyterNotebook {
  assertCellIndex(notebook, fromIndex)
  const next = structuredClone(notebook)
  const [cell] = next.cells.splice(fromIndex, 1)
  const boundedIndex = Math.max(0, Math.min(toIndex, next.cells.length))
  if (!cell) {
    throw new RemoteJupyterError('not_found', `Cell index ${fromIndex} is out of range`)
  }
  next.cells.splice(boundedIndex, 0, cell)
  return next
}

export function applyExecutionToCell(
  notebook: JupyterNotebook,
  index: number,
  execution: {
    outputs: JupyterCellOutput[]
    execution_count: number | null
  },
): JupyterNotebook {
  assertCellIndex(notebook, index)
  const next = structuredClone(notebook)
  const cell = next.cells[index]

  if (!cell || cell.cell_type !== 'code') {
    throw new RemoteJupyterError('invalid_request', `Cell ${index} is not a code cell`)
  }

  cell.outputs = structuredClone(execution.outputs)
  cell.execution_count = execution.execution_count
  return next
}

export function summarizeCellOutput(output: JupyterCellOutput): string {
  switch (output.output_type) {
    case 'stream':
      return `${output.name}: ${truncate(toSourceString(output.text))}`
    case 'display_data':
    case 'execute_result':
      return `${output.output_type}: ${Object.keys(output.data).join(', ')}`
    case 'error':
      return `error: ${output.ename}: ${truncate(output.evalue)}`
  }
}

function truncate(value: string, length = 120): string {
  return value.length > length ? `${value.slice(0, length - 1)}...` : value
}

export function listCells(notebook: JupyterNotebook) {
  return notebook.cells.map((cell, index) => ({
    index,
    cell_type: cell.cell_type,
    source: toSourceString(cell.source),
    execution_count: cell.cell_type === 'code' ? cell.execution_count : null,
    outputs_summary:
      cell.cell_type === 'code' ? cell.outputs.map((output) => summarizeCellOutput(output)) : [],
  }))
}

export function getNotebookKernelName(notebook: JupyterNotebook): string {
  const kernelName = notebook.metadata?.kernelspec?.name
  return typeof kernelName === 'string' && kernelName.length > 0 ? kernelName : 'python3'
}

export function getCellSource(cell: JupyterCell): string {
  return toSourceString(cell.source)
}
