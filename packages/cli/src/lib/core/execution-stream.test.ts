import { describe, expect, test } from 'bun:test'
import { ExecutionLineSplitter } from './execution-stream.js'

describe('ExecutionLineSplitter', () => {
  test('joins chunked input into full lines', () => {
    const lines: Array<{ line: string; newline: boolean }> = []
    const splitter = new ExecutionLineSplitter((line, newline) => {
      lines.push({ line, newline })
    })

    splitter.push('hello')
    splitter.push(' world\nnext')
    splitter.push(' line\n')

    expect(lines).toEqual([
      { line: 'hello world\n', newline: true },
      { line: 'next line\n', newline: true },
    ])
  })

  test('flushes a trailing partial line without newline', () => {
    const lines: Array<{ line: string; newline: boolean }> = []
    const splitter = new ExecutionLineSplitter((line, newline) => {
      lines.push({ line, newline })
    })

    splitter.push('partial')
    splitter.flush()

    expect(lines).toEqual([{ line: 'partial', newline: false }])
  })
})
