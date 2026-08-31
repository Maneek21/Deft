export type AppErrorCode =
  | 'APP_ACCESS_DENIED'
  | 'APP_ALREADY_INSTALLED'
  | 'APP_DISABLED'
  | 'APP_FEATURE_DISABLED'
  | 'APP_INVALID_PACKAGE'
  | 'APP_DEPENDENCY_UNHEALTHY'
  | 'APP_PROVIDER_UNAVAILABLE'
  | 'APP_REVIEW_REQUIRED'
  | 'APP_NOT_FOUND'
  | 'APP_PROTOCOL_UNSUPPORTED'
  | 'APP_STATE_CONFLICT'
  | 'APP_STALE';

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 413 | 503,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
