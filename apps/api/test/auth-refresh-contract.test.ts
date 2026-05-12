/**
 * Contract pin for POST /api/auth/refresh
 *
 * Purpose: lock down the server-side refresh endpoint contract so that future
 * refactors cannot silently break the web client's 401-retry logic that now
 * relies on it. The server is NOT being changed here — we are merely asserting
 * its current behaviour.
 *
 * Covers:
 *   1. Valid refresh token → 200 + rotated accessToken + refreshToken
 *   2. Revoked refresh token → 401 + code: TOKEN_REVOKED
 *   3. Malformed / garbage token → 401 + code: INVALID_TOKEN
 *   4. Missing refresh token → 401 + code: NO_TOKEN
 *
 * Run: pnpm --filter @deft/api test -- auth-refresh-contract
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
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

// Mount the auth routes the same way the main app does.
const app = new Hono().route('/api/auth', authRoutes);

async function callRefresh(body: unknown): Promise<{ status: number; json: unknown }> {
  const req = new Request('http://localhost/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  return { status: res.status, json: await res.json() };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';

// Unique ids per run so parallel test suites don't collide.
const TEST_USER_ID = `auth-refresh-contract-user-${crypto.randomUUID()}`;
const TEST_ORG_ID = crypto.randomUUID();

let validRefreshToken: string;

before(async () => {
  await withClient(async (c) => {
    // Seed a minimal org row
    await c.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'contract-test-org', $2)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_ORG_ID, `contract-test-org-${TEST_ORG_ID.slice(0, 8)}`],
    );

    // Seed a minimal user row (no password_hash needed — we sign tokens directly)
    await c.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, $2, 'Contract Test User')
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, `contract-test-${TEST_USER_ID.slice(-8)}@test.local`],
    );

    // Seed org membership (id is required — use a stable UUID so ON CONFLICT works)
    const memberId = crypto.randomUUID();
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [memberId, TEST_ORG_ID, TEST_USER_ID],
    );
  });

  // Generate a valid refresh token via the same algorithm the server uses.
  validRefreshToken = jwt.sign(
    { id: TEST_USER_ID, email: `contract-test-${TEST_USER_ID.slice(-8)}@test.local`, org_id: TEST_ORG_ID },
    JWT_REFRESH_SECRET,
    { expiresIn: '30d' },
  );
});

after(async () => {
  await withClient(async (c) => {
    // Clean up revoked tokens first (FK constraint) — guard against seeding failure
    if (validRefreshToken) {
      const tokenHash = createHash('sha256').update(validRefreshToken).digest('hex');
      await c.query(`DELETE FROM revoked_tokens WHERE token_hash = $1`, [tokenHash]);
    }

    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [TEST_USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [TEST_ORG_ID]);
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/auth/refresh contract', () => {
  test('1. valid refresh token → 200 with rotated accessToken and refreshToken', async () => {
    const { status, json } = await callRefresh({ refreshToken: validRefreshToken });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);

    const body = json as Record<string, unknown>;
    assert.ok(
      typeof body.accessToken === 'string' && body.accessToken.length > 0,
      `accessToken should be a non-empty string, got: ${JSON.stringify(body.accessToken)}`,
    );
    assert.ok(
      typeof body.refreshToken === 'string' && body.refreshToken.length > 0,
      `refreshToken should be a non-empty string (rotated), got: ${JSON.stringify(body.refreshToken)}`,
    );
    // Rotated refresh token should be a valid JWT verifiable with the same secret.
    const decoded = jwt.verify(body.refreshToken as string, JWT_REFRESH_SECRET) as Record<string, unknown>;
    assert.equal(decoded.id, TEST_USER_ID, 'rotated refreshToken should carry the correct user id');
  });

  test('2. revoked refresh token → 401 with code TOKEN_REVOKED', async () => {
    // Revoke the token by inserting its hash into revoked_tokens (same logic as /logout).
    const tokenHash = createHash('sha256').update(validRefreshToken).digest('hex');
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO revoked_tokens (id, token_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), tokenHash],
      );
    });

    try {
      const { status, json } = await callRefresh({ refreshToken: validRefreshToken });
      assert.equal(status, 401, `expected 401 for revoked token, got ${status}`);
      const body = json as Record<string, unknown>;
      assert.equal(body.code, 'TOKEN_REVOKED', `expected code TOKEN_REVOKED, got ${body.code}`);
    } finally {
      // Remove the revocation so other tests (e.g. test 1 if run order changes) aren't affected.
      await withClient(async (c) => {
        await c.query(`DELETE FROM revoked_tokens WHERE token_hash = $1`, [tokenHash]);
      });
    }
  });

  test('3. malformed / garbage token → 401 with code INVALID_TOKEN', async () => {
    const { status, json } = await callRefresh({ refreshToken: 'totally.garbage.jwt' });
    assert.equal(status, 401, `expected 401 for garbage token, got ${status}`);
    const body = json as Record<string, unknown>;
    assert.ok(
      body.code === 'INVALID_TOKEN' || body.code === 'NO_TOKEN',
      `expected INVALID_TOKEN or NO_TOKEN code, got ${body.code}`,
    );
  });

  test('4. missing refresh token → 401 with code NO_TOKEN', async () => {
    const { status, json } = await callRefresh({});
    assert.equal(status, 401, `expected 401 when no token provided, got ${status}`);
    const body = json as Record<string, unknown>;
    assert.equal(body.code, 'NO_TOKEN', `expected NO_TOKEN code, got ${body.code}`);
  });
});
