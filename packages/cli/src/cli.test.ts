import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './cli-core.js'

type ServerHandle = ReturnType<typeof Bun.serve>

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

function createIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
    stdout,
    stderr,
  }
}

describe('CLI', () => {
  let server: ServerHandle
  let configRoot: string

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'agentic-jupyter-cli-'))
    process.env.XDG_CONFIG_HOME = configRoot

    server = Bun.serve({
      port: 0,
      fetch(req, websocketServer) {
        const url = new URL(req.url)
        if (url.pathname === '/rpc' && websocketServer.upgrade(req, { data: null })) {
          return
        }
        if (req.headers.get('authorization') !== 'token secret-token') {
          return json({ message: 'forbidden' }, { status: 403 })
        }
        if (url.pathname === '/api') {
          return json({ version: '2.15.0' })
        }
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          return json([])
        }
        if (url.pathname.startsWith('/api/kernels/') && url.pathname.endsWith('/channels')) {
          if (websocketServer.upgrade(req, { data: null })) {
            return
          }
          return new Response('upgrade failed', { status: 500 })
        }
        if (url.pathname.startsWith('/api/contents') && req.method === 'GET') {
          return json({
            name: '',
            path: '',
            type: 'directory',
            format: 'json',
            content: [
              {
                name: 'demo.ipynb',
                path: 'demo.ipynb',
                type: 'notebook',
              },
            ],
          })
        }
        return json({ message: 'not found' }, { status: 404 })
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
          if (payload.method === 'run_cells') {
            const events = [
              {
                event: 'run_start',
                start_index: 0,
                end_index: 2,
              },
              {
                event: 'cell_start',
                cell_index: 0,
              },
              {
                event: 'stdout',
                cell_index: 0,
                line: 'alpha\n',
                newline: true,
              },
              {
                event: 'cell_complete',
                cell_index: 0,
                status: 'ok',
                execution_count: 1,
                saved: true,
              },
              {
                event: 'cell_skipped',
                cell_index: 1,
                reason: 'Cell 1 is not a code cell',
              },
              {
                event: 'cell_start',
                cell_index: 2,
              },
              {
                event: 'stderr',
                cell_index: 2,
                line: 'boom\n',
                newline: true,
              },
              {
                event: 'cell_complete',
                cell_index: 2,
                status: 'error',
                execution_count: 2,
                saved: true,
              },
              {
                event: 'run_complete',
                start_index: 0,
                end_index: 2,
                saved: true,
              },
            ]

            for (const [sequence, event] of events.entries()) {
              ws.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'host.stream_event',
                  params: {
                    request_id: payload.id,
                    command: 'run_cells',
                    path: '@active',
                    timestamp: new Date().toISOString(),
                    sequence,
                    ...event,
                  },
                }),
              )
            }

            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: {
                  path: '@active',
                  start_index: 0,
                  end_index: 2,
                  results: [
                    {
                      index: 0,
                      status: 'ok',
                      result: {
                        status: 'ok',
                        stdout: 'alpha\n',
                        stderr: '',
                        execution_count: 1,
                      },
                    },
                    {
                      index: 1,
                      status: 'skipped',
                      reason: 'Cell 1 is not a code cell',
                    },
                    {
                      index: 2,
                      status: 'error',
                      result: {
                        status: 'error',
                        stdout: '',
                        stderr: 'boom\n',
                        execution_count: 2,
                      },
                    },
                  ],
                  saved: true,
                },
              }),
            )
            return
          }
        },
      },
    })
  })

  afterEach(async () => {
    delete process.env.XDG_CONFIG_HOME
    server.stop(true)
    await rm(configRoot, { recursive: true, force: true })
  })

  test('stores and reads a remote profile', async () => {
    const { io, stdout } = createIo()
    const code = await runCli(
      [
        'profile',
        'set',
        'local',
        '--backend',
        'remote-jupyter',
        '--jupyter-host',
        '127.0.0.1',
        '--jupyter-port',
        String(server.port!),
        '--jupyter-token',
        'secret-token',
        '--default-notebook-path',
        'demo.ipynb',
        '--json',
      ],
      { io },
    )
    expect(code).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      profile: 'local',
      backend: 'remote-jupyter',
      jupyter_host: '127.0.0.1',
      default_notebook_path: 'demo.ipynb',
    })
  })

  test('lists Jupyter contents through the CLI', async () => {
    const { io: setupIo } = createIo()
    await runCli(
      [
        'profile',
        'set',
        'local',
        '--backend',
        'remote-jupyter',
        '--jupyter-host',
        '127.0.0.1',
        '--jupyter-port',
        String(server.port!),
        '--jupyter-token',
        'secret-token',
      ],
      { io: setupIo },
    )

    const { io, stdout } = createIo()
    const code = await runCli(['list-jupyter-contents', '--profile', 'local'], { io })
    expect(code).toBe(0)
    expect(stdout.join('')).toContain('notebook\tdemo.ipynb')
  })

  test('connects to a vscode host profile', async () => {
    const { io: setupIo } = createIo()
    await runCli(
      [
        'profile',
        'set',
        'editor',
        '--backend',
        'vscode-host',
        '--vscode-host',
        '127.0.0.1',
        '--vscode-port',
        String(server.port!),
        '--vscode-token',
        'secret-token',
      ],
      { io: setupIo },
    )

    const { io, stdout } = createIo()
    const code = await runCli(['get-connection-status', '--profile', 'editor', '--json'], { io })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      backend: 'vscode-host',
      capabilities: {
        can_execute_code: true,
      },
    })
  })

  test('streams run-cells results incrementally', async () => {
    const { io: setupIo } = createIo()
    await runCli(
      [
        'profile',
        'set',
        'editor',
        '--backend',
        'vscode-host',
        '--vscode-host',
        '127.0.0.1',
        '--vscode-port',
        String(server.port!),
        '--vscode-token',
        'secret-token',
      ],
      { io: setupIo },
    )

    const { io, stdout } = createIo()
    const code = await runCli(['run-cells', '--profile', 'editor', '--stream', '--json'], { io })
    expect(code).toBe(0)
    expect(stdout).toHaveLength(9)
    expect(stdout.map((entry) => JSON.parse(entry))).toMatchObject([
      {
        event: 'run_start',
        path: '@active',
        start_index: 0,
        end_index: 2,
      },
      {
        event: 'cell_start',
        cell_index: 0,
      },
      {
        event: 'stdout',
        cell_index: 0,
        line: 'alpha\n',
      },
      {
        event: 'cell_complete',
        cell_index: 0,
        status: 'ok',
      },
      {
        event: 'cell_skipped',
        cell_index: 1,
        reason: 'Cell 1 is not a code cell',
      },
      {
        event: 'cell_start',
        cell_index: 2,
      },
      {
        event: 'stderr',
        cell_index: 2,
        line: 'boom\n',
      },
      {
        event: 'cell_complete',
        cell_index: 2,
        status: 'error',
      },
      {
        event: 'run_complete',
        path: '@active',
        start_index: 0,
        end_index: 2,
        saved: true,
      },
    ])
  })
})
