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

/**
 * For a route that takes no body: true when none was sent, it is blank, or it
 * is well-formed JSON (which the route ignores); false for a malformed body,
 * which the route answers with 400 VALIDATION_ERROR before changing anything.
 */
export async function noBodyOrJson(c: Context): Promise<boolean> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return false;
  }
  if (text.trim() === '') return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
