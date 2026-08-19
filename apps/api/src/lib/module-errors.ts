export type ModuleErrorCode =
  | 'MODULE_NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'MODULE_ACCESS_DENIED'
  | 'MODULE_SCOPE_REQUIRED'
  | 'MODULE_MANIFEST_STALE'
  | 'MODULE_REVISION_CONFLICT'
  | 'MODULE_IDEMPOTENCY_CONFLICT'
  | 'MODULE_VALIDATION_ERROR'
  | 'MODULE_RECORD_NOT_FOUND'
  | 'MODULE_ALREADY_INSTALLED'
  | 'MODULE_UPDATE_NOT_AVAILABLE'
  | 'MODULE_IDENTITY_MISMATCH'
  | 'MODULE_MANIFEST_INVALID'
  | 'MODULE_MANIFEST_TOO_LARGE'
  | 'MODULE_MEDIA_TYPE_UNSUPPORTED'
  | 'MODULE_RELATION_NOT_FOUND'
  | 'MODULE_SAVED_VIEW_NOT_FOUND'
  | 'MODULE_SAVED_VIEW_CONFLICT';

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly code: ModuleErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ModuleError';
  }
}

export function isModuleError(error: unknown): error is ModuleError {
  return error instanceof ModuleError;
}
