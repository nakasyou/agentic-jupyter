import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ConnectionRegistry } from './connection-registry.js'

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

describe('ConnectionRegistry direct Jupyter mode', () => {
  let server: ServerHandle
  let registry: ConnectionRegistry

  beforeEach(() => {
    registry = new ConnectionRegistry()
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api') {
          return json({ version: '2.15.0' })
        }
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          return json([])
        }
        return json({ message: 'not found' }, { status: 404 })
      },
    })
  })

  afterEach(() => {
    server.stop(true)
  })

  test('connects directly to a Jupyter base URL and reports status', async () => {
    const connected = await registry.connect({
      jupyter_host: '127.0.0.1',
      jupyter_port: server.port!,
      jupyter_base_path: '/',
    })

    expect(connected.base_url).toBe(`http://127.0.0.1:${server.port!}/`)

    const status = await registry.getStatus(connected.connection_id)
    expect(status.base_url).toBe(`http://127.0.0.1:${server.port!}/`)
    expect(status.jupyter_status).toBe('ok')

    const disconnected = await registry.disconnect(connected.connection_id)
    expect(disconnected.disconnected).toBe(true)
  })
})
