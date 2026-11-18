import type { ErrorHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import { logId } from './log-metadata.js';

/** Hono's default handler prints the complete exception, including its cause. */
export const contentFreeErrorHandler: ErrorHandler = (error, c) => {
  // Match Hono's default response handling, including prepared headers and
  // compatible errors from another Hono instance.
  if ('getResponse' in error && typeof error.getResponse === 'function') {
    const response = error.getResponse() as Response;
    return c.newResponse(response.body, response);
  }
  const reference = randomUUID();
  console.error('[http] Unhandled request error; reference:', logId(reference));
  c.header('X-Deft-Error-Reference', reference);
  return c.text('Internal Server Error', 500);
};
