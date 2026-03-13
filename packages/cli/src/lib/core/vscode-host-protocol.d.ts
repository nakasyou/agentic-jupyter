import { z } from 'zod/v4';
import type { VscodeHostCapabilities } from './types.js';
export declare const rpcRequestSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
export declare const rpcNotificationSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
export declare const rpcSuccessSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    result: z.ZodUnknown;
}, z.core.$strip>;
export declare const rpcErrorSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    error: z.ZodObject<{
        code: z.ZodNumber;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type RpcRequest = z.output<typeof rpcRequestSchema>;
export type RpcSuccess = z.output<typeof rpcSuccessSchema>;
export type RpcError = z.output<typeof rpcErrorSchema>;
export type RpcNotification = z.output<typeof rpcNotificationSchema>;
export type JsonRpcRequest = RpcRequest;
export type JsonRpcSuccess = RpcSuccess;
export type JsonRpcFailure = RpcError;
export type JsonRpcNotification = RpcNotification;
export declare const HOST_STREAM_EVENT_METHOD = "host.stream_event";
export interface HostHandshakeResult {
    app?: 'agentic-jupyter-vscode-host';
    version?: string;
    host?: string;
    port?: number;
    extension_id?: string;
    extension_version?: string;
    capabilities: VscodeHostCapabilities;
}
export declare const hostMethodNames: Set<string>;
