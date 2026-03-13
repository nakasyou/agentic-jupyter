import { describe, expect, test } from 'bun:test'
import {
  applyExecutionToCell,
  createCell,
  createEmptyNotebook,
  deleteCell,
  insertCell,
  listCells,
  moveCell,
  updateCell,
} from './index.js'

describe('notebook helpers', () => {
  test('insert, update, move and delete cells', () => {
    let notebook = createEmptyNotebook()
    notebook = insertCell(notebook, 0, createCell('code', "print('a')"))
    notebook = insertCell(notebook, 1, createCell('markdown', '# heading'))
    notebook = updateCell(notebook, 0, { source: "print('b')" })
    notebook = moveCell(notebook, 1, 0)

    expect(notebook.cells[0]?.cell_type).toBe('markdown')
    expect(notebook.cells[1]?.cell_type).toBe('code')
    expect(notebook.cells[1]?.source).toBe("print('b')")

    notebook = deleteCell(notebook, 0)
    expect(notebook.cells).toHaveLength(1)
    expect(notebook.cells[0]?.cell_type).toBe('code')
  })

  test('apply execution stores outputs and summaries', () => {
    let notebook = createEmptyNotebook()
    notebook = insertCell(notebook, 0, createCell('code', "print('hello')"))
    notebook = applyExecutionToCell(notebook, 0, {
      execution_count: 3,
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: 'hello\n',
        },
      ],
    })

    const summary = listCells(notebook)
    expect(summary[0]?.execution_count).toBe(3)
    expect(summary[0]?.outputs_summary).toEqual(['stdout: hello\n'])
  })
})
