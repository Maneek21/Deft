import type { Context } from 'hono';
import { z } from 'zod';
import { isAppError } from '../lib/app-errors.js';
import { AppRunError } from '../lib/app-run-errors.js';

function runErrorStatus(error: AppRunError): 400 | 403 | 409 | 410 | 503 {
  switch (error.code) {
    case 'APP_RUN_INPUT_INVALID':
    case 'APP_RUN_INPUT_TOO_LARGE':
      return 400;
    case 'APP_RUN_ACCESS_DENIED':
      return 403;
    case 'APP_RUN_RESULT_EXPIRED':
    case 'APP_RUN_EXPIRED':
      return 410;
    case 'APP_RUNS_DISABLED':
    case 'APP_RUN_KEYRING_INVALID':
    case 'APP_RUN_KEY_VERSION_UNAVAILABLE':
    case 'APP_RUN_PROVIDER_UNAVAILABLE':
      return 503;
    default:
      return 409;
  }
}

export function appHttpFailure(
  c: Context,
  error: unknown,
  requestLabel: 'App action' | 'App Run',
  logLabel: 'app-actions' | 'app-runs',
) {
  if (isAppError(error)) {
    return c.json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    }, error.status);
  }
  if (error instanceof AppRunError) {
    return c.json({ error: error.message, code: error.code }, runErrorStatus(error));
  }
  if (error instanceof z.ZodError) {
    return c.json({
      error: `Invalid ${requestLabel} request`,
      code: 'VALIDATION_ERROR',
      details: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    }, 400);
  }
  console.error(`[${logLabel}] request failed:`, error);
  return c.json({ error: `${requestLabel} request failed`, code: 'INTERNAL_ERROR' }, 500);
}
