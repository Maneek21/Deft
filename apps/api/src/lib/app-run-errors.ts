import { AppRunErrorCodeSchema, type AppRunErrorCode } from '@deft/shared';

const SAFE_MESSAGES: Record<AppRunErrorCode, string> = {
  APP_RUNS_DISABLED: 'App Run execution is disabled',
  APP_RUN_KEYRING_INVALID: 'App Run key configuration is invalid',
  APP_RUN_KEY_VERSION_UNAVAILABLE: 'A required App Run key version is unavailable',
  APP_RUN_INPUT_INVALID: 'App Run input is invalid',
  APP_RUN_INPUT_TOO_LARGE: 'App Run input exceeds its limit',
  APP_RUN_OUTPUT_TOO_LARGE: 'App Run output exceeds its limit',
  APP_RUN_IDEMPOTENCY_CONFLICT: 'The App Run idempotency key conflicts with an existing Run',
  APP_RUN_ILLEGAL_TRANSITION: 'The App Run state transition is not allowed',
  APP_RUN_EXECUTION_NOT_RELEASED: 'The App Run is not released for execution',
  APP_RUN_ACCESS_DENIED: 'Access to the App Run is denied',
  APP_RUN_AUTHORIZATION_STALE: 'App Run authorization is no longer current',
  APP_RUN_PROVIDER_UNAVAILABLE: 'The App Run provider is unavailable',
  APP_RUN_PROVIDER_ERROR: 'The App Run provider returned an error',
  APP_RUN_PROVIDER_TIMEOUT: 'The App Run provider timed out',
  APP_RUN_APPROVAL_REJECTED: 'App Run approval was rejected',
  APP_RUN_APPROVAL_EXPIRED: 'App Run approval expired',
  APP_RUN_CANCELLED: 'The App Run was cancelled',
  APP_RUN_EXPIRED: 'The App Run expired',
  APP_RUN_UNKNOWN_OUTCOME: 'The App Run outcome is unknown',
  APP_RUN_RESULT_EXPIRED: 'The exact App Run result is no longer retained',
  APP_RUN_REPAIR_REQUIRED: 'The App Run requires local repair',
  APP_RUN_ANCESTRY_LIMIT: 'The App Run ancestry limit was reached',
  APP_RUN_CAPABILITY_CYCLE: 'The App Run capability cycle was rejected',
};

export class AppRunError extends Error {
  constructor(readonly code: AppRunErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'AppRunError';
  }
}

export function asAppRunError(error: unknown): AppRunError {
  if (error instanceof AppRunError) return error;
  const parsed = error instanceof Error ? AppRunErrorCodeSchema.safeParse(error.message) : null;
  const code = parsed?.success ? parsed.data : 'APP_RUN_INPUT_INVALID';
  return new AppRunError(code);
}
