export class RemoteJupyterError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RemoteJupyterError';
    }
}
export function isRemoteJupyterError(value) {
    return value instanceof RemoteJupyterError;
}
export function toRemoteJupyterError(value) {
    if (isRemoteJupyterError(value)) {
        return value;
    }
    if (value instanceof Error) {
        return new RemoteJupyterError('remote_io_failed', value.message, {
            cause: value,
        });
    }
    return new RemoteJupyterError('remote_io_failed', 'Unexpected error', {
        cause: value,
    });
}
