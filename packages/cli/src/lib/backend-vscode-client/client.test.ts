import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { VscodeHostConnectionRegistry } from './connection-registry.js'

type ServerHandle = ReturnType<typeof Bun.serve>

describe('VscodeHostConnectionRegistry', () => {
  let server: ServerHandle
  let port = 0
  let registry: VscodeHostConnectionRegistry

  beforeEach(() => {
    registry = new VscodeHostConnectionRegistry()
    server = Bun.serve({
      port: 0,
      fetch(req, websocketServer) {
        const url = new URL(req.url)
        if (req.headers.get('authorization') !== 'Bearer secret-token') {
          return new Response('forbidden', { status: 403 })
        }
        if (url.pathname !== '/rpc') {
          return new Response('not found', { status: 404 })
        }
        if (websocketServer.upgrade(req, { data: null })) {
          return
        }
        return new Response('upgrade failed', { status: 500 })
      },
      websocket: {
        message(ws, message) {
          const payload = JSON.parse(String(message))
          if (payload.method === 'host.handshake') {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: {
                  app: 'agentic-jupyter-vscode-host',
                  version: '1.0.0',
                  capabilities: {
                    jupyter_extension_available: true,
                    kernel_selected: true,
                    can_execute_code: true,
                    can_run_command: true,
                  },
                },
              }),
            )
            return
          }

          if (payload.method === 'get_connection_status') {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: {
                  capabilities: {
                    jupyter_extension_available: true,
                    kernel_selected: true,
                    can_execute_code: true,
                    can_run_command: true,
                  },
                },
              }),
            )
            return
          }

          if (payload.method === 'execute_code') {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'host.stream_event',
                params: {
                  request_id: payload.id,
                  event: 'stdout',
                  command: 'execute_code',
                  path: '@active',
                  timestamp: new Date().toISOString(),
                  sequence: 0,
                  line: 'hello\n',
                  newline: true,
                },
              }),
            )
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'host.stream_event',
                params: {
                  request_id: payload.id,
                  event: 'exec_complete',
                  command: 'execute_code',
                  path: '@active',
                  timestamp: new Date().toISOString(),
                  sequence: 1,
                  status: 'ok',
                  execution_count: 1,
                },
              }),
            )
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: {
                  status: 'ok',
                  stdout: 'hello\n',
                  stderr: '',
                  outputs: [],
                  rich_outputs: [],
                  execution_count: 1,
                },
              }),
            )
            return
          }

          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              result: payload.params,
            }),
          )
        },
      },
    })
    port = server.port!
  })

  afterEach(() => {
    server.stop(true)
  })

  test('connects and sends requests', async () => {
    const connected = await registry.connect({
      host: '127.0.0.1',
      port,
      token: 'secret-token',
    })

    expect(connected.backend).toBe('vscode-host')
    expect(connected.capabilities.can_execute_code).toBe(true)

    const echoed = (await registry.request(connected.connection_id, 'list_cells', {
      path: '@active',
    })) as Record<string, unknown>
    expect(echoed.path).toBe('@active')

    const status = await registry.getStatus(connected.connection_id)
    expect(status.capabilities?.can_run_command).toBe(true)
  })

  test('routes host stream notifications to the matching request', async () => {
    const connected = await registry.connect({
      host: '127.0.0.1',
      port,
      token: 'secret-token',
    })

    const events: Array<Record<string, unknown>> = []
    const result = await registry.requestStream(
      connected.connection_id,
      'execute_code',
      {
        path: '@active',
        code: 'print("hello")',
        stream: true,
      },
      (event) => {
        events.push(event as unknown as Record<string, unknown>)
      },
    )

    expect(result).toMatchObject({
      status: 'ok',
    })
    expect(events).toMatchObject([
      {
        event: 'stdout',
        line: 'hello\n',
      },
      {
        event: 'exec_complete',
        status: 'ok',
      },
    ])
  })
})
