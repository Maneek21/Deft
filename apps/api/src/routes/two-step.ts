import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { OrgMembershipError } from '../lib/org-membership.js';
import { verifyWebAccess } from '../lib/web-sessions.js';
import { issueSession } from '../lib/session-issuance.js';
import { SecondStepRequiredError } from '../lib/two-step-policy.js';
import {
  confirmTwoStepEnrolment,
  disableTwoStep,
  getTwoStepStatus,
  regenerateRecoveryCodes,
  resolveEnrolChallenge,
  startTwoStepEnrolment,
  twoStepIsMandatoryFor,
  type SecondStepCheck,
} from '../lib/two-step-service.js';

/**
 * Two-step verification, mounted at /api/auth/two-step.
 *
 *   POST /verify           challenge + code (or recovery code) -> session
 *   GET  /                 status
 *   POST /enrol/start      -> secret + otpauth:// address
 *   POST /enrol/confirm    code -> recovery codes (shown once) + a new session
 *   POST /recovery-codes   current code -> new recovery codes
 *   POST /disable          current code -> off (refused for hosted owners/admins)
 *
 * Callers are a signed-in person, or, for the two enrol calls only, the
 * holder of an enrol-only token. That token is opaque (not a JWT), so nothing
 * else in the API accepts it.
 */
export const twoStepRoutes = new Hono();
twoStepRoutes.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request body is too large', code: 'VALIDATION_ERROR' }, 413) }));
twoStepRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

const codeField = z.string().trim().min(6).max(16);
const recoveryCodeField = z.string().trim().min(16).max(64);

const verifySchema = z.object({
  challenge_token: z.string().min(1).max(256),
  code: codeField.optional(),
  recovery_code: recoveryCodeField.optional(),
}).refine((value) => Boolean(value.code) !== Boolean(value.recovery_code));

const startSchema = z.object({
  code: codeField.optional(),
  recovery_code: recoveryCodeField.optional(),
}).refine((value) => !(value.code && value.recovery_code));

const codeSchema = z.object({ code: codeField });

type Caller = { id: string; email: string; org_id: string; restricted: boolean };

function refuse(c: Context, check: Exclude<SecondStepCheck, { ok: true }> | { ok: false; reason: 'proof_required' }) {
  if (check.reason === 'locked') {
    c.header('Retry-After', String(check.retryAfterSeconds));
    return c.json({ error: 'Too many wrong codes. Wait before trying again.', code: 'TWO_STEP_LOCKED', retry_after_seconds: check.retryAfterSeconds }, 429);
  }
  if (check.reason === 'not_enrolled') {
    return c.json({ error: 'Two-step verification is not set up', code: 'TWO_STEP_NOT_ENROLLED' }, 409);
  }
  if (check.reason === 'proof_required') {
    return c.json({ error: 'A current code or a recovery code is required to replace the authenticator', code: 'TWO_STEP_CODE_REQUIRED' }, 403);
  }
  return c.json({ error: 'That code is not valid', code: 'TWO_STEP_CODE_INVALID' }, 403);
}

/** A signed-in person, or (when allowed) the holder of an enrol-only token. */
async function authenticate(c: Context, allowRestricted: boolean): Promise<Caller | Response> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  const token = header.slice(7);
  if (token.startsWith('tsc_')) {
    const identity = allowRestricted ? await resolveEnrolChallenge(token) : null;
    if (!identity) return c.json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' }, 401);
    return { ...identity, restricted: true };
  }
  try {
    const payload = await verifyWebAccess(token);
    return { id: payload.id, email: payload.email, org_id: payload.org_id, restricted: false };
  } catch (err) {
    if (err instanceof OrgMembershipError) return c.json({ error: err.message, code: err.code }, err.status as 403);
    if (err instanceof SecondStepRequiredError) return c.json({ error: err.message, code: err.code }, 401);
    return c.json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' }, 401);
  }
}

// POST /api/auth/two-step/verify — second call of a login.
twoStepRoutes.post('/verify', async (c) => {
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);

  let issued;
  try {
    issued = await issueSession({
      via: 'challenge',
      challengeToken: parsed.data.challenge_token,
      proof: { code: parsed.data.code, recoveryCode: parsed.data.recovery_code },
    });
  } catch (err) {
    if (err instanceof OrgMembershipError) return c.json({ error: err.message, code: err.code }, err.status as 403);
    if (err instanceof SecondStepRequiredError) return c.json({ error: err.message, code: err.code }, 403);
    throw err;
  }
  if (issued.status === 'refused') {
    const exchange = issued.exchange;
    if (exchange.reason === 'locked') return refuse(c, exchange);
    if (exchange.reason === 'invalid') return c.json({ error: 'That code is not valid', code: 'TWO_STEP_CODE_INVALID' }, 401);
    if (exchange.reason === 'challenge_dead') return c.json({ error: 'Too many wrong codes. Sign in again.', code: 'TWO_STEP_CHALLENGE_DEAD' }, 401);
    return c.json({ error: 'Sign in again', code: 'TWO_STEP_CHALLENGE_INVALID' }, 401);
  }
  if (issued.status !== 'session') return c.json({ error: 'Sign in again', code: 'TWO_STEP_CHALLENGE_INVALID' }, 401);
  return c.json({ accessToken: issued.accessToken, refreshToken: issued.refreshToken });
});

// GET /api/auth/two-step — status for the settings screen.
twoStepRoutes.get('/', async (c) => {
  const caller = await authenticate(c, false);
  if (caller instanceof Response) return caller;
  const [status, mandatory] = await Promise.all([getTwoStepStatus(caller.id), twoStepIsMandatoryFor(caller.id)]);
  return c.json({
    enabled: status.enabled,
    confirmed_at: status.confirmed_at?.toISOString() ?? null,
    recovery_codes_remaining: status.recovery_codes_remaining,
    required: mandatory,
    can_disable: status.enabled && !mandatory,
  });
});

// POST /api/auth/two-step/enrol/start
twoStepRoutes.post('/enrol/start', async (c) => {
  const caller = await authenticate(c, true);
  if (caller instanceof Response) return caller;
  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  const started = await startTwoStepEnrolment(caller, { code: parsed.data.code, recoveryCode: parsed.data.recovery_code });
  if (!started.ok) return refuse(c, started.check);
  return c.json({ secret: started.secret, otpauth_url: started.otpauth_url });
});

// POST /api/auth/two-step/enrol/confirm — recovery codes are returned once.
twoStepRoutes.post('/enrol/confirm', async (c) => {
  const caller = await authenticate(c, true);
  if (caller instanceof Response) return caller;
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  const confirmed = await confirmTwoStepEnrolment(caller.id, parsed.data.code);
  if (!confirmed.ok) return refuse(c, confirmed.check);
  // Every earlier session (this one included) and the enrol-only token ended
  // with the confirmation. The person continues on a session issued now.
  const issued = await issueSession({ via: 'enrolment', identity: { id: caller.id, email: caller.email, org_id: caller.org_id } });
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, caller.id)).limit(1);
  return c.json({
    recovery_codes: confirmed.recoveryCodes,
    user,
    org_id: caller.org_id,
    ...(issued.status === 'session' ? { accessToken: issued.accessToken, refreshToken: issued.refreshToken } : {}),
  });
});

// POST /api/auth/two-step/recovery-codes — replaces every recovery code.
twoStepRoutes.post('/recovery-codes', async (c) => {
  const caller = await authenticate(c, false);
  if (caller instanceof Response) return caller;
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  const result = await regenerateRecoveryCodes(caller.id, parsed.data.code);
  if (!result.ok) return refuse(c, result.check);
  return c.json({ recovery_codes: result.recoveryCodes });
});

// POST /api/auth/two-step/disable
twoStepRoutes.post('/disable', async (c) => {
  const caller = await authenticate(c, false);
  if (caller instanceof Response) return caller;
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  if (await twoStepIsMandatoryFor(caller.id)) {
    return c.json({ error: 'Owners and admins must keep two-step verification on', code: 'TWO_STEP_REQUIRED_FOR_ROLE' }, 403);
  }
  const result = await disableTwoStep(caller.id, parsed.data.code);
  if ('mandatory' in result) {
    return c.json({ error: 'Owners and admins must keep two-step verification on', code: 'TWO_STEP_REQUIRED_FOR_ROLE' }, 403);
  }
  if (!result.ok) return refuse(c, result.check);
  return c.json({ success: true });
});
