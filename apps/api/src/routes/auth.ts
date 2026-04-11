import { Hono } from 'hono';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, onboardingState } from '@deft/db/schema';
import { env } from '../lib/env.js';

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

// POST /api/auth/signup
authRoutes.post('/signup', async (c) => {
  const body = await c.req.json();
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const { name, email, password, org_name } = parsed.data;

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

  const tokens = generateTokens({ id: user!.id, email: user!.email, org_id: org!.id });

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

  const tokens = generateTokens({ id: user.id, email: user.email, org_id: membership.org_id });

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

  try {
    const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { id: string; email: string; org_id: string };
    const tokens = generateTokens({ id: payload.id, email: payload.email, org_id: payload.org_id });
    return c.json(tokens);
  } catch {
    return c.json({ error: 'Invalid refresh token', code: 'INVALID_TOKEN' }, 401);
  }
});

// POST /api/auth/logout
authRoutes.post('/logout', async (c) => {
  // With JWT, logout is client-side (clear tokens)
  // In production, you'd add the token to a blacklist
  return c.json({ success: true });
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
