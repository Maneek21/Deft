import type { Context } from 'hono';

/**
 * The request's JSON body, or undefined when it is missing or malformed, so
 * the route's schema refuses it with 400 VALIDATION_ERROR. A body that
 * defaulted to `{}` instead would pass a schema whose fields are all optional
 * (a PATCH) and answer 200 to malformed JSON.
 */
export function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}
