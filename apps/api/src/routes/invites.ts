import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users, orgs, orgMembers, invites } from '@deft/db/schema';
import { env } from '../lib/env.js';
import { ensureDeftyMembership, ensureDeftyDm } from '../lib/ensure-defty-membership.js';
import { WebCredentialsChangedError } from '../lib/web-sessions.js';
import { issueSession, issuedSessionBody } from '../lib/session-issuance.js';

export const inviteRoutes = new Hono();

type InvitePayload = {
  user_id: string;
  org_id: string;
  email: string;
  inviter_id: string;
  role: 'admin' | 'member' | 'guest';
  purpose: 'invite-accept';
  /** The account's password generation when the link was made; absent on links made before it existed. */
  password_version?: number;
  iat?: number;
  exp?: number;
};

// Invite tokens are signed with HS256 in routes/members.ts; never accept any
// other algorithm when verifying them.
function verifyInviteToken(token: string): InvitePayload {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as InvitePayload;
}

const previewSchema = z.object({ token: z.string().min(1).max(8192) });

// POST /api/invites/preview — public preview of an invite, token in the body.
// Used by the accept page to render "Sara invited you to Acme". The token
// travels in the body so it never appears in a request log.
inviteRoutes.post('/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }
  return previewInvite(c, parsed.data.token);
});

// GET /api/invites/preview/:token — legacy preview. No current page calls it:
// both the new `/invite#token=` page and the old `/invite/<token>` page use
// POST /preview. It serves only browser bundles cached from before that
// change, and should be removed after the next deploy. The request logger
// redacts this path.
inviteRoutes.get('/preview/:token', async (c) => previewInvite(c, c.req.param('token')));

async function previewInvite(c: Context, token: string) {
  let payload: InvitePayload;
  try {
    payload = verifyInviteToken(token);
  } catch (err) {
    const isExpired = err instanceof Error && err.name === 'TokenExpiredError';
    return c.json({ error: isExpired ? 'expired' : 'invalid', code: isExpired ? 'INVITE_EXPIRED' : 'INVITE_INVALID' }, 400);
  }

  if (payload.purpose !== 'invite-accept') {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }

  const [invite] = await db
    .select({
      id: invites.id,
      accepted_at: invites.accepted_at,
      expires_at: invites.expires_at,
    })
    .from(invites)
    .where(and(eq(invites.token, token), eq(invites.org_id, payload.org_id)))
    .limit(1);

  if (!invite) {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }
  if (invite.expires_at && invite.expires_at < new Date()) {
    return c.json({ error: 'expired', code: 'INVITE_EXPIRED' }, 400);
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
    already_accepted: Boolean(invite.accepted_at ?? user.password_hash),
    expires_at: invite.expires_at?.toISOString() ?? (payload.exp ? new Date(payload.exp * 1000).toISOString() : null),
  });
}

// POST /api/invites/accept — finalize an invite and log the user in
const acceptSchema = z.object({
  token: z.string().min(1).max(8192),
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
    payload = verifyInviteToken(parsed.data.token);
  } catch (err) {
    const isExpired = err instanceof Error && err.name === 'TokenExpiredError';
    return c.json({ error: isExpired ? 'expired' : 'invalid', code: isExpired ? 'INVITE_EXPIRED' : 'INVITE_INVALID' }, 400);
  }

  if (payload.purpose !== 'invite-accept') {
    return c.json({ error: 'invalid', code: 'INVITE_INVALID' }, 400);
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const updates: Record<string, unknown> = {
    password_hash: passwordHash,
    email_verified: true,
  };
  if (parsed.data.name) updates.name = parsed.data.name;

  type AcceptanceFailure = 'INVITE_INVALID' | 'INVITE_ALREADY_ACCEPTED' | 'INVITE_EXPIRED' | 'INVITE_REVOKED';
  const accepted = await db.transaction(async (tx) => {
    // The account row first, then the invite: the order the membership guard
    // takes (account, membership, invites), so a removal and an acceptance
    // cannot deadlock. The invite lock lets exactly one concurrent acceptance
    // set the password and mint a session from this token.
    const [user] = await tx.select().from(users).where(eq(users.id, payload.user_id)).for('update');
    const [invite] = await tx
      .select({ id: invites.id, accepted_at: invites.accepted_at, expires_at: invites.expires_at })
      .from(invites)
      .where(and(eq(invites.token, parsed.data.token), eq(invites.org_id, payload.org_id)))
      .for('update');
    if (!invite) return { failure: 'INVITE_INVALID' as AcceptanceFailure };
    if (invite.accepted_at) return { failure: 'INVITE_ALREADY_ACCEPTED' as AcceptanceFailure };
    if (invite.expires_at && invite.expires_at < new Date()) return { failure: 'INVITE_EXPIRED' as AcceptanceFailure };

    if (!user) return { failure: 'INVITE_INVALID' as AcceptanceFailure };
    // An invite-created account has no password until its one accepted invite
    // establishes credentials. Never let a stale pending invite replace
    // credentials established by another invite or an admin recovery.
    if (user.password_hash) return { failure: 'INVITE_ALREADY_ACCEPTED' as AcceptanceFailure };
    const [membership] = await tx
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.user_id, payload.user_id), eq(orgMembers.org_id, payload.org_id), eq(orgMembers.is_active, true)))
      .for('share');
    if (!membership) return { failure: 'INVITE_REVOKED' as AcceptanceFailure };
    // A link is refused if the account's generation has moved at all since
    // it was made, whoever made it (lib/membership-guard.ts moves it on at
    // every role or active-state change). A link made before links carried a
    // generation is refused once the generation has left its starting value 0.
    const madeAt = payload.password_version ?? 0;
    if (madeAt !== user.password_version) return { failure: 'INVITE_REVOKED' as AcceptanceFailure };

    await tx.update(users).set({ ...updates, password_version: user.password_version + 1 }).where(eq(users.id, payload.user_id));
    await tx.update(invites)
      .set({ accepted_by: payload.user_id, accepted_at: new Date() })
      .where(and(eq(invites.id, invite.id), eq(invites.org_id, payload.org_id)));
    return { user };
  });

  if ('failure' in accepted) {
    const messages: Record<AcceptanceFailure, string> = {
      INVITE_INVALID: 'invalid',
      INVITE_ALREADY_ACCEPTED: 'already accepted',
      INVITE_EXPIRED: 'expired',
      INVITE_REVOKED: 'invalid',
    };
    const failure = accepted.failure as AcceptanceFailure;
    return c.json({ error: messages[failure], code: failure }, 400);
  }
  const user = accepted.user;

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

  // Same policy as login: in hosted mode a new admin gets an enrol-only token.
  let issued;
  try {
    issued = await issueSession({ via: 'invite', identity: { id: user.id, email: user.email!, org_id: payload.org_id }, expectedPasswordHash: passwordHash });
  } catch (error) {
    if (error instanceof WebCredentialsChangedError) {
      return c.json({ error: 'Credentials changed; sign in again', code: 'CREDENTIALS_CHANGED' }, 409);
    }
    throw error;
  }

  return c.json({
    user: { id: user.id, name: parsed.data.name ?? user.name, email: user.email },
    org_id: payload.org_id,
    ...issuedSessionBody(issued),
  });
});
