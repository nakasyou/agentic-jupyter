import { z } from 'zod/v4'
import { actionDefinitions } from './actions.js'
import type { VscodeHostCapabilities } from './types.js'

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
})

export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
})

export const rpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
})

export const rpcErrorSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullable(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
})

export type RpcRequest = z.output<typeof rpcRequestSchema>
export type RpcSuccess = z.output<typeof rpcSuccessSchema>
export type RpcError = z.output<typeof rpcErrorSchema>
export type RpcNotification = z.output<typeof rpcNotificationSchema>
export type JsonRpcRequest = RpcRequest
export type JsonRpcSuccess = RpcSuccess
export type JsonRpcFailure = RpcError
export type JsonRpcNotification = RpcNotification

export const HOST_STREAM_EVENT_METHOD = 'host.stream_event'

export interface HostHandshakeResult {
  app?: 'agentic-jupyter-vscode-host'
  version?: string
  host?: string
  port?: number
  extension_id?: string
  extension_version?: string
  capabilities: VscodeHostCapabilities
}

export const hostMethodNames = new Set([
  'host.handshake',
  'get_connection_status',
  ...actionDefinitions
    .map((action) => action.name)
    .filter((name) => name !== 'connect_remote_jupyter' && name !== 'connect_vscode_host'),
])
