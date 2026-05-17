import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users, orgs, orgMembers } from '@deft/db/schema';
import { env } from '../lib/env.js';
import { ensureDeftyMembership, ensureDeftyDm } from '../lib/ensure-defty-membership.js';

export const inviteRoutes = new Hono();

type InvitePayload = {
  user_id: string;
  org_id: string;
  email: string;
  inviter_id: string;
  role: 'admin' | 'member' | 'guest';
  purpose: 'invite-accept';
  iat?: number;
  exp?: number;
};

function generateAuthTokens(user: { id: string; email: string; org_id: string }) {
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, org_id: user.org_id },
    env.JWT_SECRET,
    { expiresIn: '15m' },
  );
  const refreshToken = jwt.sign(
    { id: user.id, email: user.email, org_id: user.org_id },
    env.JWT_REFRESH_SECRET,
    { expiresIn: '30d' },
  );
  return { accessToken, refreshToken };
}

// GET /api/invites/preview/:token — public preview of an invite
// Used by the accept page to render "Sara invited you to Acme".
inviteRoutes.get('/preview/:token', async (c) => {
  const token = c.req.param('token');
  let payload: InvitePayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as InvitePayload;
  } catch (err) {
    const isExpired = err instanceof Error && err.name === 'TokenExpiredError';
    return c.json({ error: isExpired ? 'expired' : 'invalid', code: isExpired ? 'INVITE_EXPIRED' : 'INVITE_INVALID' }, 400);
  }

  if (payload.purpose !== 'invite-accept') {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name, password_hash: users.password_hash })
    .from(users)
    .where(eq(users.id, payload.user_id))
    .limit(1);

  if (!user) {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }

  const [org] = await db
    .select({ name: orgs.name, slug: orgs.slug })
    .from(orgs)
    .where(eq(orgs.id, payload.org_id))
    .limit(1);

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, payload.inviter_id))
    .limit(1);

  return c.json({
    org_name: org?.name ?? 'this workspace',
    org_slug: org?.slug ?? '',
    inviter_name: inviter?.name ?? 'an admin',
    email: payload.email,
    role: payload.role,
    already_accepted: Boolean(user.password_hash),
    expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
  });
});

// POST /api/invites/accept — finalize an invite and log the user in
const acceptSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8),
});

inviteRoutes.post('/accept', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  let payload: InvitePayload;
  try {
    payload = jwt.verify(parsed.data.token, env.JWT_SECRET) as InvitePayload;
  } catch (err) {
    const isExpired = err instanceof Error && err.name === 'TokenExpiredError';
    return c.json({ error: isExpired ? 'expired' : 'invalid', code: isExpired ? 'INVITE_EXPIRED' : 'INVITE_INVALID' }, 400);
  }

  if (payload.purpose !== 'invite-accept') {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }

  // Verify user + membership still exist (admin may have removed them)
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.user_id))
    .limit(1);
  if (!user) {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }

  const [membership] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.user_id, payload.user_id), eq(orgMembers.org_id, payload.org_id)))
    .limit(1);
  if (!membership || !membership.is_active) {
    return c.json({ error: 'invalid', code: 'INVITE_REVOKED' }, 400);
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const updates: Record<string, unknown> = {
    password_hash: passwordHash,
    email_verified: true,
  };
  if (parsed.data.name) updates.name = parsed.data.name;

  await db.update(users).set(updates).where(eq(users.id, payload.user_id));

  // Ensure Defty is in the org and materialize the 1:1 DM so the new
  // member sees it in their sidebar immediately. Both are idempotent;
  // failure must not block sign-in.
  try {
    await ensureDeftyMembership(payload.org_id);
  } catch (err) {
    console.error('[ensureDeftyMembership] failed for org', payload.org_id, err);
  }
  try {
    await ensureDeftyDm(payload.org_id, payload.user_id);
  } catch (err) {
    console.error('[ensureDeftyDm] failed for org', payload.org_id, 'user', payload.user_id, err);
  }

  // Fire member.joined trigger now that the user has actually joined.
  // Fire-and-forget — a failing subscriber must not block sign-in.
  (async () => {
    try {
      const { emitMemberJoinedTrigger } = await import('../lib/member-joined-trigger.js');
      const count = await emitMemberJoinedTrigger({
        org_id: payload.org_id,
        new_user_id: payload.user_id,
        inviter_user_id: payload.inviter_id,
        role: payload.role,
      });
      if (count > 0) {
        console.log(`[invites] Fired member.joined trigger to ${count} employee(s)`);
      }
    } catch (err) {
      console.warn('[invites] member.joined trigger failed:', (err as Error).message);
    }
  })();

  const tokens = generateAuthTokens({ id: user.id, email: user.email!, org_id: payload.org_id });

  return c.json({
    user: { id: user.id, name: parsed.data.name ?? user.name, email: user.email },
    org_id: payload.org_id,
    ...tokens,
  });
});
