import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { actionDefinitions, toRemoteJupyterError } from '../core/index.js'
import { UnifiedConnectionRegistry, executeAction } from './dispatcher.js'

const registry = new UnifiedConnectionRegistry()

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}

function errorResult(error: unknown) {
  const normalized = toRemoteJupyterError(error)
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details ?? null,
            },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  }
}

export async function startServer(): Promise<void> {
  const server = new McpServer({
    name: 'remote-jupyter-mcp',
    version: '1.1.0',
  })

  for (const action of actionDefinitions) {
    const objectSchema = action.inputSchema as any
    server.registerTool(
      action.name,
      {
        description: action.description,
        inputSchema: objectSchema.shape ?? objectSchema,
      },
      async (args: unknown) => {
        try {
          return jsonResult(await executeAction(registry, action.name, args)) as any
        } catch (error) {
          return errorResult(error) as any
        }
      },
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('remote-jupyter-mcp running on stdio')
}
