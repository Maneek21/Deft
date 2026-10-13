import type { Context } from 'hono';
import { z } from 'zod';
import { isAppError } from '../lib/app-errors.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { appHttpFailure } from './app-http-errors.js';

const transientSqlStates = new Set(['08000', '08003', '08006', '57P01', '57P02', '57P03', '53300', '57014']);
const transientPgMessages = new Set(['Connection terminated', 'Connection terminated unexpectedly', 'Query read timeout']);

function transientStatusRead(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;
  let transient = false;
  for (let depth = 0; depth < 8 && current instanceof Error && !visited.has(current); depth++) {
    visited.add(current);
    // A typed authority or validation decision never becomes a transient read.
    if (current instanceof ResourceSyncWebAuthenticationError || isAppError(current)
      || current instanceof AppRunError || current instanceof z.ZodError
      || current instanceof TypeError || current instanceof RangeError || current instanceof SyntaxError) return false;
    const cause = current as Error & { code?: unknown; cause?: unknown };
    if ((typeof cause.code === 'string' && transientSqlStates.has(cause.code))
      || transientPgMessages.has(current.message)) transient = true;
    current = cause.cause;
  }
  return transient;
}

/** Only the original-result GET uses this; unavailable reads say nothing about
 * execution outcome and never retry or release the original action. */
export function appRunStatusReadFailure(c: Context, error: unknown) {
  if (!transientStatusRead(error)) return appHttpFailure(c, error, 'App Run', 'app-runs');
  c.header('Retry-After', '2');
  return c.json({
    error: 'The original App Run status is temporarily unavailable. Check this submission again; do not submit the action again.',
    code: 'APP_RUN_STATUS_UNAVAILABLE',
  }, 503);
}
