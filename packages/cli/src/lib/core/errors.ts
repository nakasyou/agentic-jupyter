export type RemoteJupyterErrorCode =
  | 'auth_failed'
  | 'tunnel_failed'
  | 'not_found'
  | 'kernel_dead'
  | 'execution_timeout'
  | 'unsupported_kernel'
  | 'remote_io_failed'
  | 'invalid_request'
  | 'connection_failed'

export class RemoteJupyterError extends Error {
  constructor(
    public readonly code: RemoteJupyterErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'RemoteJupyterError'
  }
}

export function isRemoteJupyterError(value: unknown): value is RemoteJupyterError {
  return value instanceof RemoteJupyterError
}

export function toRemoteJupyterError(value: unknown): RemoteJupyterError {
  if (isRemoteJupyterError(value)) {
    return value
  }

  if (value instanceof Error) {
    return new RemoteJupyterError('remote_io_failed', value.message, {
      cause: value,
    })
  }

  return new RemoteJupyterError('remote_io_failed', 'Unexpected error', {
    cause: value,
  })
}
