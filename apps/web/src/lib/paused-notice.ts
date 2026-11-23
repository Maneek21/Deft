/**
 * A paused workspace (the API started with DEFT_PAUSED_START=true) can be read
 * but not changed. GET /api/auth/me reports `paused: { reason }` to signed-in
 * people; every refused request answers 503 `{ code: 'PAUSED' }`.
 */
export type PausedReason = 'restore_review' | 'billing' | 'emergency_stop';
export type PausedNotice = { reason: PausedReason };

export const PAUSED_BANNER_TEXT: Record<PausedReason, string> = {
  billing:
    'This workspace is paused because a payment is overdue. You can read everything, but nothing can be changed, ' +
    'and AI, notifications and live updates are off. The workspace owner can restore it by paying the outstanding invoice.',
  restore_review:
    'This workspace is being checked after a restore. You can read everything, but nothing can be changed yet.',
  emergency_stop:
    'Outgoing activity in this workspace is stopped while a problem is looked into. You can sign in and read everything, ' +
    'but nothing can be changed, and link previews, email, notifications and AI are off. Nothing scheduled is lost: ' +
    'it goes out once the stop is lifted.',
};

/** Shown in place of the server's operator wording when a change is refused. */
export const PAUSED_WRITE_MESSAGE = 'Nothing was changed: this workspace is paused. See the notice at the top of the page.';
/** Shown when a read is refused (a few reads would change shared state). */
export const PAUSED_READ_MESSAGE = 'This is not available while the workspace is paused. See the notice at the top of the page.';

/** Fired on window whenever the API or realtime refuses something as paused. */
export const PAUSED_REFUSED_EVENT = 'deft:paused-refused';

/**
 * Absent or not an object: not paused. An object is the API saying it is
 * paused; a reason this build does not know still gets the neutral notice,
 * because hiding the banner while changes are refused is the worse failure.
 */
export function parsePausedNotice(value: unknown): PausedNotice | null {
  if (!value || typeof value !== 'object') return null;
  const reason = (value as { reason?: unknown }).reason;
  if (reason === 'billing' || reason === 'restore_review' || reason === 'emergency_stop') return { reason };
  // A paused install with an unknown reason still gets the neutral notice.
  return { reason: 'restore_review' };
}

export function reportPausedRefusal(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(PAUSED_REFUSED_EVENT));
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * When the API refused a request because the workspace is paused, report it
 * (the session is rechecked if needed) and hand callers a calm message in place of the
 * server's operator wording. Any other response passes through untouched.
 */
export async function calmPausedRefusal(response: Response, method: string): Promise<Response> {
  if (response.status !== 503) return response;
  const body: unknown = await response.clone().json().catch(() => null);
  if (!body || typeof body !== 'object' || (body as { code?: unknown }).code !== 'PAUSED') return response;
  const write = !READ_METHODS.has(method.toUpperCase());
  reportPausedRefusal();
  return new Response(JSON.stringify({ error: write ? PAUSED_WRITE_MESSAGE : PAUSED_READ_MESSAGE, code: 'PAUSED' }), {
    status: 503,
    statusText: response.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}
