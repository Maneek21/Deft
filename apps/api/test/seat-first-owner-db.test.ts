/**
 * The first owner of a hosted cell is never refused for want of seats (owner's
 * decision, 16 Nov 2026): signup with the setup token succeeds with no seat
 * statement at all, and the owner then counts as one used seat. Claiming a
 * cell must not depend on the control plane answering at that moment.
 *
 * Like signup-first-workspace-db.test.ts, this file gives its own process
 * empty copies of the tables signup touches, in a throwaway schema placed
 * first on the search path, because signup only acts on an install with no
 * workspace.
 *
 * Run: pnpm --filter @deft/api test test/seat-first-owner-db.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();

// A hosted signup also writes the two-step tables (the owner gets an enrol-only challenge).
const TABLES = ['users', 'orgs', 'org_members', 'spaces', 'space_members', 'onboarding_state', 'web_sessions', 'user_two_step', 'two_step_challenges'];
const HOSTED = {
  DEFT_HOSTED: 'true',
  DEFT_CELL_ID: `cell-first-owner-${randomUUID().slice(0, 8)}`,
  DEFT_SEAT_PUBLIC_KEYS: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  DEFT_SEAT_STATEMENT_URL: 'https://control.test.invalid/v1/seat-statement',
  DEFT_SEAT_FETCH_TOKEN: 'test-fetch-token',
};
const TOKEN = randomBytes(32).toString('base64url');

test('hosted: the first owner signs up with no seat statement and takes one seat', { skip: !safe, timeout: 120_000 }, async (t) => {
  const schema = `seat_owner_${randomUUID().replaceAll('-', '')}`;
  await ensureTwoStepTables(target!);
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of TABLES) {
    await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  const savedEnv = { ...process.env };
  process.env.PGOPTIONS = `-c search_path=${schema},public`;
  Object.assign(process.env, HOSTED, {
    DEFT_SETUP_TOKEN_SHA256: createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
    DEFT_SETUP_TOKEN_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const { authRoutes } = await import('../src/routes/auth.js');
  const { closeDb, db } = await import('../src/lib/db.js');
  const seats = await import('../src/lib/seat-limit.js');
  // Keep the setup-token marker off the real uploads directory.
  const { setupTokenUseStore } = await import('../src/lib/setup-token-use.js');
  const volume = await mkdtemp(join(tmpdir(), 'deft-seat-owner-'));
  const savedMarkerDir = setupTokenUseStore.dir;
  setupTokenUseStore.dir = join(volume, '.setup-token-used');
  t.after(async () => {
    setupTokenUseStore.dir = savedMarkerDir;
    await rm(volume, { recursive: true, force: true });
    await closeDb();
    process.env = savedEnv;
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  seats._resetSeatProcessStateForTest();
  seats.seatFetchDeps.fetch = async () => { throw new Error('control plane unreachable'); };

  const app = new Hono().route('/api/auth', authRoutes);
  const res = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Owner', email: `owner-${schema}@signup.test`, password: 'correct-horse-battery-staple',
      org_name: 'Workspace', setup_token: TOKEN,
    }),
  });
  const body = await res.json() as { org?: { id: string } };
  assert.equal(res.status, 201, JSON.stringify(body));
  const orgId = body.org!.id;

  assert.equal(await seats.countSeatsInUse(db, orgId), 1, 'the owner is one used seat');
  const status = await seats.getSeatStatus(orgId);
  assert.deepEqual(
    [status.hosted, status.seats_in_use, status.seat_limit, status.growth_frozen],
    [true, 1, null, true],
    'with no statement the owner is in, and adding anyone else is frozen',
  );
});
