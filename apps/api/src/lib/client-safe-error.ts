import { randomUUID } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm';

/**
 * Error text that may reach a person or an outside agent (the approve answer,
 * the approval card, the MCP result, the stored action error).
 *
 * The executors' own refusal and validation messages ("Project not found",
 * "Invalid due_date: …") are written for people and pass through unchanged.
 * A database error is not: Drizzle's message is `Failed query: <SQL>
 * params: <values>`, and a driver error can name tables, columns and
 * constraints. Those are replaced with a fixed message and a reference id;
 * the detail is logged on the server under the same id.
 */
export const SERVER_ERROR_MESSAGE = 'The action could not be completed because of a server error.';

/** Markers of database or driver error text. */
const DATABASE_ERROR_TEXT = [
  /Failed query:/i,
  /\bparams:\s/i,
  /violates (?:not-null|foreign key|unique|check|exclusion) constraint/i,
  /duplicate key value/i,
  /(?:relation|column|table) "[^"]+" (?:does not exist|of relation)/i,
  /invalid input (?:syntax|value) for/i,
  /\b(?:insert into|delete from)\s+"?\w/i,
  /\b(?:from|update|into|join)\s+"[a-z_][a-z0-9_]*"/i,
  /\bat character \d+\b/i,
];

function isDatabaseError(err: unknown): boolean {
  if (err instanceof DrizzleQueryError) return true;
  // node-postgres DatabaseError: SQLSTATE code plus severity.
  const candidate = err as { code?: unknown; severity?: unknown; cause?: unknown } | null;
  if (candidate && typeof candidate === 'object') {
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code) && typeof candidate.severity === 'string') return true;
    if (candidate.cause && candidate.cause !== err && isDatabaseError(candidate.cause)) return true;
  }
  return false;
}

/** True when the text reads as database or driver error output. */
export function looksLikeDatabaseErrorText(text: string): boolean {
  return DATABASE_ERROR_TEXT.some((pattern) => pattern.test(text));
}

function serverErrorWithReference(detail: unknown, context: string): string {
  const reference = randomUUID().slice(0, 8);
  console.error(`[client-safe-error] ${context} failed (ref ${reference})`, detail);
  return `${SERVER_ERROR_MESSAGE} Reference: ${reference}`;
}

/** A message safe to show for a caught exception. */
export function clientSafeErrorMessage(err: unknown, context: string): string {
  if (!(err instanceof Error)) return serverErrorWithReference(err, context);
  if (isDatabaseError(err) || looksLikeDatabaseErrorText(err.message)) return serverErrorWithReference(err, context);
  return err.message;
}

/** Error text (possibly a JSON string from a tool result) safe to show. */
export function clientSafeErrorText(text: string, context: string): string {
  return looksLikeDatabaseErrorText(text) ? serverErrorWithReference(text, context) : text;
}
