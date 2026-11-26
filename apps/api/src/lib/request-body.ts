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

/** JSON's own whitespace: space, tab, line feed and carriage return. Nothing else counts as empty. */
const JSON_WHITESPACE_ONLY = /^[ \t\n\r]*$/;

/**
 * For a route that takes no body: true when none was sent, it holds only
 * JSON whitespace, or it is well-formed JSON (which the route ignores); false
 * for anything else (a no-break space alone included), which the route
 * answers with 400 VALIDATION_ERROR before changing anything.
 */
export async function noBodyOrJson(c: Context): Promise<boolean> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return false;
  }
  if (JSON_WHITESPACE_ONLY.test(text)) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
