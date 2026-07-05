import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, onboardingState, revokedTokens } from '@deft/db/schema';
import { env } from '../lib/env.js';
import { countOrgs, SINGLE_ORG_ERROR } from '../lib/single-org-guard.js';
import { ensureDeftyMembership, ensureDeftyDm } from '../lib/ensure-defty-membership.js';
import { OrgMembershipError, requireActiveOrgMembership } from '../lib/org-membership.js';

export const authRoutes = new Hono();

const signupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  org_name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function generateTokens(user: { id: string; email: string; org_id: string }) {
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, org_id: user.org_id },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  const refreshToken = jwt.sign(
    { id: user.id, email: user.email, org_id: user.org_id },
    env.JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );
  return { accessToken, refreshToken };
}

// GET /api/auth/has-workspace — public pre-check for the signup page
authRoutes.get('/has-workspace', async (c) => {
  const { countOrgs } = await import('../lib/single-org-guard.js');
  return c.json({ hasWorkspace: (await countOrgs()) > 0 });
});

// POST /api/auth/signup
authRoutes.post('/signup', async (c) => {
  const body = await c.req.json();
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const { name, email, password, org_name } = parsed.data;

  // Self-hosted v1 — only the first signup can create a workspace. Once
  // an org exists, new accounts must arrive through an invite flow that
  // joins the existing org. See apps/api/src/lib/single-org-guard.ts.
  if ((await countOrgs()) > 0) {
    return c.json(SINGLE_ORG_ERROR, 403);
  }

  // Check if user exists
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return c.json({ error: 'Email already registered', code: 'EMAIL_EXISTS' }, 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Create user. Self-hosted Deft has no outbound email — the bootstrap user
  // is implicitly verified (they own the instance). Subsequent accounts go
  // through invites, which flip the flag on acceptance.
  const [user] = await db.insert(users).values({
    name,
    email,
    password_hash: passwordHash,
    email_verified: true,
  }).returning();

  // Create org
  const slug = org_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const [org] = await db.insert(orgs).values({
    name: org_name,
    slug: `${slug}-${user!.id.slice(0, 8)}`,
  }).returning();

  // Add user as org owner
  await db.insert(orgMembers).values({
    org_id: org!.id,
    user_id: user!.id,
    role: 'owner',
  });

  // Create #general space
  const [generalSpace] = await db.insert(spaces).values({
    org_id: org!.id,
    name: 'general',
    description: 'General discussion',
    type: 'public',
    is_default: true,
    created_by: user!.id,
  }).returning();

  // Add user to #general
  await db.insert(spaceMembers).values({
    space_id: generalSpace!.id,
    user_id: user!.id,
  });

  // Phase 1 invariant — ensure Defty system user has an org_members row in
  // every org. Idempotent.
  try {
    await ensureDeftyMembership(org!.id);
  } catch (err) {
    console.error('[ensureDeftyMembership] failed for org', org!.id, err);
  }

  // Materialize Defty's 1:1 DM so the user sees it in the sidebar
  // immediately. Failure must not block signup.
  try {
    await ensureDeftyDm(org!.id, user!.id);
  } catch (err) {
    console.error('[ensureDeftyDm] failed for org', org!.id, 'user', user!.id, err);
  }

  // Create onboarding state
  await db.insert(onboardingState).values({
    user_id: user!.id,
    org_created: true,
  });

  const tokens = generateTokens({ id: user!.id, email: user!.email!, org_id: org!.id });

  return c.json({
    user: { id: user!.id, name: user!.name, email: user!.email },
    org: { id: org!.id, name: org!.name, slug: org!.slug },
    ...tokens,
  }, 201);
});

// POST /api/auth/login
authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const { email, password } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !user.password_hash) {
    return c.json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }, 401);
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }, 401);
  }

  // Private-alpha gate: block sign-in until the account has been verified.
  // Set by the signup handler (first user -> owner) and invite acceptance. An admin can flip it manually via SQL for locked-out users.
  if (!user.email_verified) {
    return c.json({
      error: 'Please verify your email before signing in. Check your inbox or ask an admin for a verification link.',
      code: 'EMAIL_NOT_VERIFIED',
    }, 403);
  }

  // Get user's org
  const [membership] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true)))
    .limit(1);
  if (!membership) {
    return c.json({ error: 'No active organization membership found', code: 'ORG_MEMBERSHIP_INACTIVE' }, 403);
  }

  const tokens = generateTokens({ id: user.id, email: user.email!, org_id: membership.org_id });

  return c.json({
    user: { id: user.id, name: user.name, email: user.email },
    org_id: membership.org_id,
    ...tokens,
  });
});

// POST /api/auth/refresh
authRoutes.post('/refresh', async (c) => {
  const body = await c.req.json();
  const { refreshToken } = body;

  if (!refreshToken) {
    return c.json({ error: 'No refresh token', code: 'NO_TOKEN' }, 401);
  }

  // Check revocation list before validating the JWT
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
  const [revoked] = await db.select().from(revokedTokens).where(eq(revokedTokens.token_hash, tokenHash)).limit(1);
  if (revoked) {
    return c.json({ error: 'Token revoked', code: 'TOKEN_REVOKED' }, 401);
  }

  try {
    const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { id: string; email: string; org_id: string };
    await requireActiveOrgMembership(payload.org_id, payload.id);
    const tokens = generateTokens({ id: payload.id, email: payload.email, org_id: payload.org_id });
    return c.json(tokens);
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Invalid refresh token', code: 'INVALID_TOKEN' }, 401);
  }
});

// POST /api/auth/logout — revoke the caller's refresh token
authRoutes.post('/logout', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as { refreshToken?: string }));
    const token = body.refreshToken;
    if (!token) return c.json({ ok: true }); // idempotent: nothing to revoke

    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.insert(revokedTokens).values({
      id: crypto.randomUUID(),
      token_hash: tokenHash,
    }).onConflictDoNothing();

    return c.json({ ok: true });
  } catch (err) {
    console.error('[auth] Failed to logout:', err);
    return c.json({ error: 'Failed to logout', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/auth/me
authRoutes.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; email: string; org_id: string };

    const [user] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatar_url: users.avatar_url,
      title: users.title,
      timezone: users.timezone,
      status_emoji: users.status_emoji,
      status_text: users.status_text,
    }).from(users).where(eq(users.id, payload.id)).limit(1);

    if (!user) {
      return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);
    }

    const membership = await requireActiveOrgMembership(payload.org_id, payload.id);

    const [org] = await db.select({
      id: orgs.id,
      name: orgs.name,
      slug: orgs.slug,
    }).from(orgs).where(eq(orgs.id, payload.org_id)).limit(1);

    return c.json({ user: { ...user, role: membership.role }, org });
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }
});

// PATCH /api/auth/me — update user profile (name, timezone, avatar_url)
const profileUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  avatar_url: z.string().url().nullable().optional(),
});

// POST /api/auth/forgot-password — self-hosted Deft has no outbound email.
// Returns a generic 200 so the public surface keeps the same shape, but no
// link is generated and no message is sent. Users locked out should ask an
// admin to generate a recovery URL via Settings → Members.
authRoutes.post('/forgot-password', async (c) => {
  return c.json({
    success: true,
    message: 'Password reset is handled by your workspace admin. Ask an admin to generate a recovery link from Settings → Members.',
    self_service: false,
  });
});

// POST /api/auth/reset-password — reset password with token
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

authRoutes.post('/reset-password', async (c) => {
  const body = await c.req.json();
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const { token, password } = parsed.data;

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; email: string; purpose?: string };
    if (payload.purpose !== 'password-reset') {
      return c.json({ error: 'Invalid reset token', code: 'INVALID_TOKEN' }, 400);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await db.update(users).set({ password_hash: passwordHash }).where(eq(users.id, payload.id));

    return c.json({ success: true, message: 'Password has been reset. You can now log in.' });
  } catch {
    return c.json({ error: 'Reset token is invalid or expired', code: 'INVALID_TOKEN' }, 400);
  }
});

// GET /api/auth/onboarding — fetch the caller's onboarding state, creating it lazily
authRoutes.get('/onboarding', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; org_id: string };
    await requireActiveOrgMembership(payload.org_id, payload.id);
    let [state] = await db.select().from(onboardingState).where(eq(onboardingState.user_id, payload.id)).limit(1);
    if (!state) {
      const [created] = await db.insert(onboardingState).values({ user_id: payload.id }).returning();
      state = created!;
    }
    return c.json(state);
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }
});

// PATCH /api/auth/onboarding — set onboarding flags (profile_set, agent_tried, completed, …)
const onboardingUpdateSchema = z.object({
  profile_set: z.boolean().optional(),
  first_space_created: z.boolean().optional(),
  first_message_sent: z.boolean().optional(),
  first_invite_sent: z.boolean().optional(),
  first_task_created: z.boolean().optional(),
  agent_tried: z.boolean().optional(),
  completed: z.boolean().optional(),
});

authRoutes.patch('/onboarding', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; org_id: string };
    await requireActiveOrgMembership(payload.org_id, payload.id);
    const body = await c.req.json().catch(() => ({}));
    const parsed = onboardingUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    // Ensure the row exists
    const [existing] = await db.select().from(onboardingState).where(eq(onboardingState.user_id, payload.id)).limit(1);
    if (!existing) {
      await db.insert(onboardingState).values({ user_id: payload.id, ...parsed.data });
    } else {
      await db.update(onboardingState).set(parsed.data).where(eq(onboardingState.user_id, payload.id));
    }

    const [refreshed] = await db.select().from(onboardingState).where(eq(onboardingState.user_id, payload.id)).limit(1);
    return c.json(refreshed);
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }
});

authRoutes.patch('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { id: string; email: string; org_id: string };
    await requireActiveOrgMembership(payload.org_id, payload.id);
    const body = await c.req.json();
    const parsed = profileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const updates: Record<string, string | null> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.timezone !== undefined) updates.timezone = parsed.data.timezone;
    if (parsed.data.avatar_url !== undefined) updates.avatar_url = parsed.data.avatar_url;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No fields to update', code: 'EMPTY_UPDATE' }, 400);
    }

    await db.update(users).set(updates).where(eq(users.id, payload.id));

    return c.json({ success: true });
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }
});
