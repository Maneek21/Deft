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

  // Create user
  const [user] = await db.insert(users).values({
    name,
    email,
    password_hash: passwordHash,
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

  // Get user's org
  const [membership] = await db.select().from(orgMembers).where(eq(orgMembers.user_id, user.id)).limit(1);
  if (!membership) {
    return c.json({ error: 'No organization found', code: 'NO_ORG' }, 404);
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
    const tokens = generateTokens({ id: payload.id, email: payload.email, org_id: payload.org_id });
    return c.json(tokens);
  } catch {
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

    const [org] = await db.select({
      id: orgs.id,
      name: orgs.name,
      slug: orgs.slug,
    }).from(orgs).where(eq(orgs.id, payload.org_id)).limit(1);

    // Get user's role in the org
    const [membership] = await db.select({
      role: orgMembers.role,
    }).from(orgMembers).where(
      and(eq(orgMembers.user_id, payload.id), eq(orgMembers.org_id, payload.org_id)),
    ).limit(1);

    return c.json({ user: { ...user, role: membership?.role ?? 'member' }, org });
  } catch {
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }
});

// PATCH /api/auth/me — update user profile (name, timezone, avatar_url)
const profileUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  avatar_url: z.string().url().nullable().optional(),
});

// POST /api/auth/forgot-password — send password reset email
const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

authRoutes.post('/forgot-password', async (c) => {
  const body = await c.req.json();
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const { email } = parsed.data;

  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);

  // Always return 200 to prevent email enumeration
  if (!user) {
    return c.json({ success: true, message: 'If an account exists with this email, a reset link has been sent.' });
  }

  // Generate reset token (15 min expiry)
  const resetToken = jwt.sign(
    { id: user.id, email: user.email, purpose: 'password-reset' },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const resetUrl = `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${resetToken}`;

  // Send email via Resend if configured, otherwise log
  if (env.RESEND_API_KEY) {
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.FROM_EMAIL || 'noreply@deft.dev',
          to: email,
          subject: 'Reset your Deft password',
          html: `<p>Click the link below to reset your password. This link expires in 15 minutes.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
        }),
      });
      await resendRes.text();
    } catch (err) {
      console.error('[auth] Failed to send reset email:', err);
    }
  } else {
    console.log(`[auth] Password reset link for ${email}: ${resetUrl}`);
  }

  return c.json({ success: true, message: 'If an account exists with this email, a reset link has been sent.' });
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

// GET /api/auth/google — redirect to Google OAuth consent
authRoutes.get('/google', async (c) => {
  if (!env.GOOGLE_CLIENT_ID) {
    return c.json({ error: 'Google OAuth not configured', code: 'NOT_CONFIGURED' }, 503);
  }

  const redirectUri = `http://localhost:${env.API_PORT}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// GET /api/auth/google/callback — exchange code for tokens, create/find user
authRoutes.get('/google/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) {
    return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?error=no_code`);
  }

  const redirectUri = `http://localhost:${env.API_PORT}/api/auth/google/callback`;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json() as { access_token: string };

    // Fetch user info
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoRes.ok) {
      return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?error=userinfo_failed`);
    }

    const googleUser = await userInfoRes.json() as { email: string; name: string; picture: string };

    // Find or create user
    let [user] = await db.select().from(users).where(eq(users.email, googleUser.email)).limit(1);

    if (!user) {
      // Self-hosted v1 — only bootstrap a workspace for the very first
      // Google sign-in. Subsequent new accounts need an invite.
      if ((await countOrgs()) > 0) {
        return c.redirect(
          `${env.NEXT_PUBLIC_APP_URL}/login?error=single_org_limit`,
        );
      }

      // New user — create user + org
      const [newUser] = await db.insert(users).values({
        name: googleUser.name,
        email: googleUser.email,
        avatar_url: googleUser.picture,
      }).returning();
      user = newUser!;

      // Create default org
      const slug = googleUser.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const [org] = await db.insert(orgs).values({
        name: `${googleUser.name}'s Workspace`,
        slug: `${slug}-${user.id.slice(0, 8)}`,
      }).returning();

      await db.insert(orgMembers).values({
        org_id: org!.id,
        user_id: user.id,
        role: 'owner',
      });

      // Create #general space
      const [generalSpace] = await db.insert(spaces).values({
        org_id: org!.id,
        name: 'general',
        description: 'General discussion',
        type: 'public',
        is_default: true,
        created_by: user.id,
      }).returning();

      await db.insert(spaceMembers).values({
        space_id: generalSpace!.id,
        user_id: user.id,
      });

      await db.insert(onboardingState).values({
        user_id: user.id,
        org_created: true,
      });
    }

    // Get org membership
    const [membership] = await db.select().from(orgMembers).where(eq(orgMembers.user_id, user.id)).limit(1);
    if (!membership) {
      return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?error=no_org`);
    }

    const tokens = generateTokens({ id: user.id, email: user.email!, org_id: membership.org_id });

    // Redirect back to app with tokens in URL fragment (client reads them)
    return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`);
  } catch (err) {
    console.error('[auth] Google OAuth error:', err);
    return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?error=oauth_failed`);
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
  } catch {
    return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
  }
});
