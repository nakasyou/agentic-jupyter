function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-'
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value, null, 2)
}

function section(title: string, body: string): string {
  return `${title}\n${body}`.trim()
}

function renderKeyValue(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join('\n')
}

export function formatHuman(commandName: string, result: unknown): string {
  if (!result || typeof result !== 'object') {
    return formatValue(result)
  }

  const data = result as Record<string, unknown>

  if (commandName === 'list-jupyter-contents' && Array.isArray(data.content)) {
    return data.content
      .map((entry) => {
        const item = entry as Record<string, unknown>
        return `${item.type ?? 'unknown'}\t${item.path ?? item.name ?? ''}`
      })
      .join('\n')
  }

  if (commandName === 'list-cells' && Array.isArray(data.cells)) {
    return data.cells
      .map((cell) => {
        const item = cell as Record<string, unknown>
        const outputs = Array.isArray(item.outputs_summary) ? item.outputs_summary.join(' | ') : ''
        return `[${item.index}] ${item.cell_type} exec=${item.execution_count ?? '-'} ${outputs}`.trim()
      })
      .join('\n')
  }

  if (commandName === 'execute-code' || commandName === 'run-command') {
    const parts: string[] = []
    if ('status' in data) {
      parts.push(`status: ${formatValue(data.status)}`)
    }
    if ('exit_code' in data) {
      parts.push(`exit_code: ${formatValue(data.exit_code)}`)
    }
    if ('stdout' in data) {
      parts.push(section('stdout:', String(data.stdout ?? '')))
    }
    if ('stderr' in data && String(data.stderr ?? '').length > 0) {
      parts.push(section('stderr:', String(data.stderr ?? '')))
    }
    if ('execution_count' in data) {
      parts.push(`execution_count: ${formatValue(data.execution_count)}`)
    }
    return parts.join('\n\n').trim()
  }

  if (commandName === 'run-cell' && 'result' in data && typeof data.result === 'object' && data.result) {
    const resultObject = data.result as Record<string, unknown>
    return [
      `path: ${formatValue(data.path)}`,
      `index: ${formatValue(data.index)}`,
      `status: ${formatValue(resultObject.status)}`,
      section('stdout:', String(resultObject.stdout ?? '')),
      String(resultObject.stderr ?? '').length > 0
        ? section('stderr:', String(resultObject.stderr ?? ''))
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }

  if (commandName === 'run-cells' && Array.isArray(data.results)) {
    return data.results
      .map((entry) => {
        const item = entry as Record<string, unknown>
        return `[${item.index}] ${item.status}${item.reason ? ` - ${item.reason}` : ''}`
      })
      .join('\n')
  }

  return renderKeyValue(data)
}
