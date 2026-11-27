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

/** JSON's own whitespace bytes: space, tab, line feed and carriage return. */
const JSON_WHITESPACE_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * For a route that takes no body: true when the body has no bytes, or only
 * JSON whitespace bytes, or holds a JSON value (which the route ignores; a
 * byte order mark before it is tolerated); false for anything else, which
 * the route answers with 400 VALIDATION_ERROR before changing anything.
 *
 * Emptiness is decided on the raw bytes: decoding to text strips a byte
 * order mark, so a body of only a BOM (or a BOM and whitespace) would read
 * as empty. It is parsed once, from those same bytes. Hono keeps the bytes,
 * so a later read of the body still works.
 */
export async function noBodyOrJson(c: Context): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await c.req.arrayBuffer());
  } catch {
    return false;
  }
  if (bytes.every((byte) => JSON_WHITESPACE_BYTES.has(byte))) return true;
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return true;
  } catch {
    return false;
  }
}
