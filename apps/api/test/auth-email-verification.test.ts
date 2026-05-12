/**
 * Email-verification gate for POST /api/auth/login
 *
 * Self-hosted Deft has no outbound email — verification is set explicitly by
 * the signup handler (first user becomes owner) and by invite acceptance.
 * For private alpha we still gate /login on the `email_verified` flag so a
 * leaked password on an unaccepted invite (verified=false) cannot be used to
 * sign in.
 *
 * Schema reality (2026-05-12): the users table uses `email_verified BOOLEAN
 * DEFAULT false NOT NULL`. The original plan referred to `email_verified_at`
 * (timestamp), but that column does not exist. Tests assert on the actual
 * column.
 *
 * Run: pnpm --filter @deft/api test -- auth-email-verification
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { Hono } from 'hono';
import { authRoutes } from '../src/routes/auth.js';

// ── Database helpers ──────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────

const app = new Hono().route('/api/auth', authRoutes);

async function callLogin(body: unknown): Promise<{ status: number; json: unknown }> {
  const req = new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  return { status: res.status, json: await res.json() };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RUN_ID = crypto.randomUUID();
const UNVERIFIED_USER_ID = `auth-emailver-unverified-${RUN_ID}`;
const VERIFIED_USER_ID = `auth-emailver-verified-${RUN_ID}`;
const ORG_ID = crypto.randomUUID();
const UNVERIFIED_EMAIL = `unverified-${RUN_ID}@test.local`;
const VERIFIED_EMAIL = `verified-${RUN_ID}@test.local`;
const PASSWORD = 'correct-horse-battery-staple';

before(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await withClient(async (c) => {
    // Seed org + membership for the verified user so the login can resolve org_id.
    await c.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'emailver-test-org', $2)
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, `emailver-test-org-${ORG_ID.slice(0, 8)}`],
    );

    await c.query(
      `INSERT INTO users (id, email, name, password_hash, email_verified)
       VALUES ($1, $2, 'Unverified Test User', $3, false)
       ON CONFLICT (id) DO NOTHING`,
      [UNVERIFIED_USER_ID, UNVERIFIED_EMAIL, passwordHash],
    );

    await c.query(
      `INSERT INTO users (id, email, name, password_hash, email_verified)
       VALUES ($1, $2, 'Verified Test User', $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [VERIFIED_USER_ID, VERIFIED_EMAIL, passwordHash],
    );

    const memberId = crypto.randomUUID();
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [memberId, ORG_ID, VERIFIED_USER_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM org_members WHERE user_id IN ($1, $2)`, [
      UNVERIFIED_USER_ID,
      VERIFIED_USER_ID,
    ]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
      UNVERIFIED_USER_ID,
      VERIFIED_USER_ID,
    ]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/auth/login email verification gate', () => {
  test('login blocks users whose email is not verified', async () => {
    const { status, json } = await callLogin({
      email: UNVERIFIED_EMAIL,
      password: PASSWORD,
    });

    assert.equal(status, 403, `expected 403 for unverified user, got ${status}: ${JSON.stringify(json)}`);
    const body = json as Record<string, unknown>;
    assert.equal(body.code, 'EMAIL_NOT_VERIFIED', `expected code EMAIL_NOT_VERIFIED, got ${body.code}`);
  });

  test('login succeeds for verified users', async () => {
    const { status, json } = await callLogin({
      email: VERIFIED_EMAIL,
      password: PASSWORD,
    });

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    const body = json as Record<string, unknown>;
    assert.ok(
      typeof body.accessToken === 'string' && body.accessToken.length > 0,
      `accessToken should be a non-empty string, got: ${JSON.stringify(body.accessToken)}`,
    );
    assert.ok(
      typeof body.refreshToken === 'string' && body.refreshToken.length > 0,
      `refreshToken should be a non-empty string, got: ${JSON.stringify(body.refreshToken)}`,
    );
  });

  test('login still rejects wrong password for verified users with INVALID_CREDENTIALS (not EMAIL_NOT_VERIFIED)', async () => {
    // Order matters: the bcrypt check must run before the verification check,
    // otherwise we leak verification state to attackers via probe responses.
    const { status, json } = await callLogin({
      email: VERIFIED_EMAIL,
      password: 'wrong-password',
    });
    assert.equal(status, 401, `expected 401 for bad password, got ${status}`);
    const body = json as Record<string, unknown>;
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  });

  test('login on unverified user with wrong password returns INVALID_CREDENTIALS (does not leak verification state)', async () => {
    const { status, json } = await callLogin({
      email: UNVERIFIED_EMAIL,
      password: 'wrong-password',
    });
    assert.equal(status, 401);
    const body = json as Record<string, unknown>;
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  });
});
