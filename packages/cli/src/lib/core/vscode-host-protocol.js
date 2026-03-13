import { z } from 'zod/v4';
import { actionDefinitions } from './actions.js';
export const rpcRequestSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]),
    method: z.string(),
    params: z.unknown().optional(),
});
export const rpcNotificationSchema = z.object({
    jsonrpc: z.literal('2.0'),
    method: z.string(),
    params: z.unknown().optional(),
});
export const rpcSuccessSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]),
    result: z.unknown(),
});
export const rpcErrorSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).nullable(),
    error: z.object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
    }),
});
export const HOST_STREAM_EVENT_METHOD = 'host.stream_event';
export const hostMethodNames = new Set([
    'host.handshake',
    'get_connection_status',
    ...actionDefinitions
        .map((action) => action.name)
        .filter((name) => name !== 'connect_remote_jupyter' && name !== 'connect_vscode_host'),
]);
