import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createEmptyNotebook, type JupyterContentModel, type JupyterNotebook, type JupyterNotebookContentModel, type JupyterSessionModel } from '../core/index.js'
import { JupyterClient } from './jupyter-client.js'

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

function createDirectoryModel(
  path: string,
  content: JupyterContentModel[] = [],
): JupyterContentModel {
  return {
    name: path.split('/').at(-1) ?? '',
    path,
    type: 'directory',
    content,
    format: 'json',
  }
}

describe('JupyterClient', () => {
  let server: ServerHandle
  let client: JupyterClient
  const token = 'secret-token'
  const directories = new Set<string>([''])
  const notebooks = new Map<string, JupyterNotebook>()
  const sessions = new Map<string, JupyterSessionModel>()

  beforeEach(() => {
    directories.clear()
    directories.add('')
    notebooks.clear()
    sessions.clear()

    server = Bun.serve({
      port: 0,
      fetch(req, websocketServer) {
        const url = new URL(req.url)
        if (req.headers.get('authorization') !== `token ${token}`) {
          return json({ message: 'forbidden' }, { status: 403 })
        }

        const pathname = url.pathname
        if (pathname.startsWith('/api/kernels/') && pathname.endsWith('/channels')) {
          if (websocketServer.upgrade(req, { data: null })) {
            return
          }
          return new Response('upgrade failed', { status: 500 })
        }

        if (pathname === '/api') {
          return json({ version: '2.15.0' })
        }

        if (pathname === '/api/sessions' && req.method === 'GET') {
          return json([...sessions.values()])
        }

        if (pathname === '/api/sessions' && req.method === 'POST') {
          const body = req.json() as Promise<{ path: string; kernel: { name: string } }>
          return body.then(({ path, kernel }) => {
            const session: JupyterSessionModel = {
              id: crypto.randomUUID(),
              path,
              kernel: {
                id: crypto.randomUUID(),
                name: kernel.name,
              },
            }
            sessions.set(path, session)
            return json(session, { status: 201 })
          })
        }

        if (pathname.startsWith('/api/contents')) {
          const contentPath = decodeURIComponent(pathname.replace(/^\/api\/contents\/?/, ''))

          if (req.method === 'GET') {
            if (contentPath === '') {
              return json(createDirectoryModel('', listChildren('', directories)))
            }

            if (directories.has(contentPath)) {
              return json(createDirectoryModel(contentPath, listChildren(contentPath, directories)))
            }

            if (notebooks.has(contentPath)) {
              if (url.searchParams.get('format') === 'json') {
                return json({ message: "Format 'json' is invalid" }, { status: 400 })
              }
              const notebook = notebooks.get(contentPath)!
              const model: JupyterNotebookContentModel = {
                name: contentPath.split('/').at(-1) ?? contentPath,
                path: contentPath,
                type: 'notebook',
                format: 'json',
                content: structuredClone(notebook),
              }
              return json(model)
            }

            return json({ message: 'not found' }, { status: 404 })
          }

          if (req.method === 'PUT') {
            const body = req.json() as Promise<Record<string, unknown>>
            return body.then((payload) => {
              const type = payload.type
              if (type === 'directory') {
                directories.add(contentPath)
                return json(createDirectoryModel(contentPath), { status: 201 })
              }

              if (type === 'notebook') {
                const notebook = payload.content as JupyterNotebook
                notebooks.set(contentPath, structuredClone(notebook))
                ensureDirectories(contentPath, directories)
                return json({
                  name: contentPath.split('/').at(-1) ?? contentPath,
                  path: contentPath,
                  type: 'notebook',
                  format: 'json',
                  content: structuredClone(notebook),
                })
              }

              return json({
                name: contentPath.split('/').at(-1) ?? contentPath,
                path: contentPath,
                type: 'file',
                format: payload.format ?? 'text',
                content: payload.content ?? '',
              })
            })
          }
        }

        return json({ message: 'not found' }, { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const payload = JSON.parse(String(message))
          const parentId = payload.header.msg_id
          ws.send(
            JSON.stringify({
              header: {
                msg_id: crypto.randomUUID(),
                username: 'fake',
                session: 'fake',
                msg_type: 'stream',
                version: '5.3',
              },
              parent_header: {
                msg_id: parentId,
              },
              metadata: {},
              channel: 'iopub',
              content: {
                name: 'stdout',
                text: 'hello\n',
              },
            }),
          )
          ws.send(
            JSON.stringify({
              header: {
                msg_id: crypto.randomUUID(),
                username: 'fake',
                session: 'fake',
                msg_type: 'execute_result',
                version: '5.3',
              },
              parent_header: {
                msg_id: parentId,
              },
              metadata: {},
              channel: 'iopub',
              content: {
                execution_count: 1,
                data: {
                  'text/plain': '2',
                },
                metadata: {},
              },
            }),
          )
          ws.send(
            JSON.stringify({
              header: {
                msg_id: crypto.randomUUID(),
                username: 'fake',
                session: 'fake',
                msg_type: 'execute_reply',
                version: '5.3',
              },
              parent_header: {
                msg_id: parentId,
              },
              metadata: {},
              channel: 'shell',
              content: {
                status: 'ok',
                execution_count: 1,
              },
            }),
          )
          ws.send(
            JSON.stringify({
              header: {
                msg_id: crypto.randomUUID(),
                username: 'fake',
                session: 'fake',
                msg_type: 'status',
                version: '5.3',
              },
              parent_header: {
                msg_id: parentId,
              },
              metadata: {},
              channel: 'iopub',
              content: {
                execution_state: 'idle',
              },
            }),
          )
        },
      },
    })

    client = new JupyterClient(`http://127.0.0.1:${server.port}/`, token)
  })

  afterEach(() => {
    server.stop(true)
  })

  test('creates notebooks and executes code over websocket', async () => {
    await client.ensureDirectory('notebooks')
    await client.saveNotebook('notebooks/demo.ipynb', createEmptyNotebook('python3'))
    const notebook = await client.getNotebook('notebooks/demo.ipynb')
    expect(notebook.content?.metadata.kernelspec?.name).toBe('python3')

    const session = await client.ensureSession('notebooks/demo.ipynb', 'python3')
    const streamed: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    const execution = await client.executeCode(session, '1 + 1', 5, (stream, text) => {
      streamed.push({ stream, text })
    })

    expect(execution.status).toBe('ok')
    expect(execution.stdout).toBe('hello\n')
    expect(execution.execution_count).toBe(1)
    expect(execution.outputs).toHaveLength(2)
    expect(streamed).toEqual([{ stream: 'stdout', text: 'hello\n' }])
  })

  test('fails authentication with the wrong token', async () => {
    const badClient = new JupyterClient(`http://127.0.0.1:${server.port}/`, 'wrong')
    await expect(badClient.getApiInfo()).rejects.toThrow('Jupyter authentication failed')
  })
})

function ensureDirectories(path: string, directories: Set<string>) {
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    directories.add(current)
  }
}

function listChildren(directory: string, directories: Set<string>): JupyterContentModel[] {
  const prefix = directory ? `${directory}/` : ''
  const items: JupyterContentModel[] = []
  for (const child of directories) {
    if (!child.startsWith(prefix) || child === directory) {
      continue
    }
    const remainder = child.slice(prefix.length)
    if (remainder.includes('/')) {
      continue
    }
    items.push(createDirectoryModel(child))
  }
  return items
}
