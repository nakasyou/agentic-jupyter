export type RemoteJupyterErrorCode = 'auth_failed' | 'tunnel_failed' | 'not_found' | 'kernel_dead' | 'execution_timeout' | 'unsupported_kernel' | 'remote_io_failed' | 'invalid_request' | 'connection_failed';
export declare class RemoteJupyterError extends Error {
    readonly code: RemoteJupyterErrorCode;
    readonly details?: unknown | undefined;
    constructor(code: RemoteJupyterErrorCode, message: string, details?: unknown | undefined);
}
export declare function isRemoteJupyterError(value: unknown): value is RemoteJupyterError;
export declare function toRemoteJupyterError(value: unknown): RemoteJupyterError;
