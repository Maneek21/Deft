/**
 * Seat limit on hosted cells (hosted design note section 9), against a real
 * database: who counts, every path that adds a counted person, two invites
 * racing for the last seat, frozen growth in each of its causes, a stale
 * stored statement after a restart, and hosted mode off unchanged.
 *
 * Run: pnpm --filter @deft/api test test/seat-limit-db.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { orgMembers, orgs, invites, spaceMembers, users } from '@deft/db/schema';
import { seatStatements } from '@deft/db/seat-statements';
import { userTwoStep } from '@deft/db/two-step';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';
import { db } from '../src/lib/db.js';
import {
  _resetSeatProcessStateForTest,
  acceptSeatStatementToken,
  countSeatsInUse,
  getSeatStatus,
  refreshSeatStatement,
  seatFetchDeps,
  seatTestHooks,
} from '../src/lib/seat-limit.js';

const s = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const CELL = `cell-test-${s}`;
const orgId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const createdUserIds = new Set<string>([ownerId]);

// Published test key from the deft-seat-v1 vectors; never trusted outside tests.
const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/seat-statement-v1.json'), 'utf8')) as {
  keys: { signing: { private_key: string; public_key: string } };
};
const signingKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.keys.signing.private_key, 'base64url')]),
  format: 'der',
  type: 'pkcs8',
});

let version = 1;
let statementSeats = 10;
let fetchCalls = 0;
let fetchFails = false;
let nowMs = Date.now();

function statementToken(opts: { seats: number; version: number; cell?: string; issuedAt?: number; ttl?: number }): string {
  const issued = opts.issuedAt ?? Math.floor(nowMs / 1000) - 10;
  const payload = `{"cell_id":"${opts.cell ?? CELL}","seats":${opts.seats},"version":${opts.version},"issued_at":${issued},"expires_at":${issued + (opts.ttl ?? 3600)}}`;
  const input = `deft-seat-v1.${Buffer.from(payload, 'ascii').toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input, 'ascii'), signingKey).toString('base64url')}`;
}

const realFetch = seatFetchDeps.fetch;
const realNow = seatFetchDeps.now;
const savedEnv = { ...process.env };

function hostedEnv() {
  process.env.DEFT_HOSTED = 'true';
  process.env.DEFT_CELL_ID = CELL;
  process.env.DEFT_SEAT_PUBLIC_KEYS = vectors.keys.signing.public_key;
  process.env.DEFT_SEAT_STATEMENT_URL = 'https://control.test.invalid/v1/seat-statement';
  process.env.DEFT_SEAT_FETCH_TOKEN = 'test-fetch-token';
}

function selfHostedEnv() {
  for (const key of ['DEFT_HOSTED', 'DEFT_CELL_ID', 'DEFT_SEAT_PUBLIC_KEYS', 'DEFT_SEAT_STATEMENT_URL', 'DEFT_SEAT_FETCH_TOKEN']) {
    delete process.env[key];
  }
}

/** Hosted, with a fresh accepted statement for `seats` seats. */
async function hostedWithSeats(seats: number) {
  hostedEnv();
  _resetSeatProcessStateForTest();
  statementSeats = seats;
  version += 1;
  const result = await refreshSeatStatement();
  assert.equal(result.ok, true, `statement for ${seats} seats accepted`);
}

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user' as never, { id: ownerId, email: `owner-${s}@test.local`, org_id: orgId } as never);
  await next();
});

async function invite(email: string, role = 'member') {
  const res = await app.request('/api/members/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  const body = await res.json() as Record<string, unknown>;
  if (typeof body.user_id === 'string') createdUserIds.add(body.user_id);
  return { status: res.status, body };
}

async function setRole(userId: string, role: string) {
  const res = await app.request(`/api/members/${userId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function addMember(opts: { kind?: 'human' | 'agent'; role?: 'admin' | 'member' | 'guest'; active?: boolean } = {}) {
  const id = crypto.randomUUID();
  createdUserIds.add(id);
  await db.insert(users).values({ id, email: `m-${id}@test.local`, name: 'M', kind: opts.kind ?? 'human' });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: id, role: opts.role ?? 'member', is_active: opts.active ?? true });
  return id;
}

async function used() {
  return countSeatsInUse(db, orgId);
}

before(async () => {
  // A local database made before this change, or by a push-full that stopped
  // before the forward upgrades, may lack the table; create it from the upgrade
  // file. In CI the fresh install must already have it.
  const exists = await db.execute(sql`SELECT to_regclass('public.seat_statements') IS NOT NULL AS present`);
  if (!(exists.rows[0] as { present: boolean }).present && process.env.CI !== 'true') {
    await db.execute(sql.raw(readFileSync(resolve(import.meta.dirname, '../../../packages/db/upgrades/0.3.0-preview.144-seat-statements.sql'), 'utf8')));
  }
  // A hosted admin must have two-step verification on before promotion.
  await ensureTwoStepTables((process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL)!);
  await db.insert(orgs).values({ id: orgId, name: `Seats ${s}`, slug: `seats-${s}` });
  await db.insert(users).values({ id: ownerId, email: `owner-${s}@test.local`, name: 'Owner' });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: ownerId, role: 'owner' });
  const { memberRoutes } = await import('../src/routes/members.js');
  app.route('/api/members', memberRoutes);
  seatFetchDeps.now = () => nowMs;
  seatFetchDeps.fetch = async (_url, init) => {
    fetchCalls += 1;
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-fetch-token');
    if (fetchFails) throw new Error('control plane unreachable');
    return new Response(JSON.stringify({ statement: statementToken({ seats: statementSeats, version }) }), { status: 200 });
  };
});

beforeEach(() => {
  nowMs = Date.now();
  fetchFails = false;
  fetchCalls = 0;
});

after(async () => {
  seatFetchDeps.fetch = realFetch;
  seatFetchDeps.now = realNow;
  process.env = savedEnv;
  const ids = [...createdUserIds];
  await db.delete(seatStatements).where(eq(seatStatements.cell_id, CELL));
  await db.delete(invites).where(eq(invites.org_id, orgId));
  await db.delete(spaceMembers).where(inArray(spaceMembers.user_id, ids));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(inArray(users.id, ids));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

test('the seat statement table matches the upgrade file', async () => {
  // Same definitions as the Versioned Upgrade job checks after db:upgrade.
  const columns = await db.execute(sql`SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position) AS v
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'seat_statements'`);
  const checks = await db.execute(sql`SELECT string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) AS v
    FROM pg_constraint WHERE conrelid = 'public.seat_statements'::regclass AND contype = 'c'`);
  assert.equal(columns.rows[0]?.v, 'cell_id:text:NO,token:text:NO,seats:integer:NO,version:bigint:NO,issued_at:bigint:NO,expires_at:bigint:NO,highest_version:bigint:NO,accepted_at:timestamp without time zone:NO,created_at:timestamp without time zone:NO,updated_at:timestamp without time zone:NO');
  assert.equal(checks.rows[0]?.v, 'seat_statements_seats_check: CHECK ((seats >= 0)) | seat_statements_version_check: CHECK (((version >= 1) AND (highest_version >= version)))');
});

test('only active human non-guest members count', async () => {
  const before = await used();
  await addMember({ kind: 'agent' });
  await addMember({ role: 'guest' });
  await addMember({ active: false });
  assert.equal(await used(), before, 'agents, guests and inactive members take no seat');
  await addMember({ role: 'admin' });
  assert.equal(await used(), before + 1);
});

test('self-hosted: no limit, no fetch, invites and promotions work as today', async () => {
  selfHostedEnv();
  _resetSeatProcessStateForTest();
  const status = await getSeatStatus(orgId);
  assert.equal(status.hosted, false);
  assert.equal(status.growth_frozen, false);
  assert.equal(status.seat_limit, null);
  assert.equal((await refreshSeatStatement()).ok, false);
  assert.equal((await invite(`self-${s}@test.local`)).status, 201);
  const guest = await addMember({ role: 'guest' });
  assert.equal((await setRole(guest, 'member')).status, 200);
  assert.equal(fetchCalls, 0, 'nothing is fetched when hosted mode is off');
});

test('invite: allowed one below the limit, refused at it with the limit and count', async () => {
  await hostedWithSeats(10);
  const inUse = await used();
  await hostedWithSeats(inUse + 1);
  assert.equal((await invite(`below-${s}@test.local`)).status, 201);
  const refused = await invite(`at-${s}@test.local`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'SEAT_LIMIT_REACHED');
  assert.equal(refused.body.seat_limit, inUse + 1);
  assert.equal(refused.body.seats_in_use, inUse + 1);
  assert.match(String(refused.body.error), /seats/);
  const [created] = await db.select().from(users).where(eq(users.email, `at-${s}@test.local`));
  assert.equal(created, undefined, 'a refused invite creates no account');
  assert.equal(fetchCalls >= 1, true, 'a refusal fetches a fresh statement');
  // Guests never need a seat.
  assert.equal((await invite(`guest-${s}@test.local`, 'guest')).status, 201);
});

test('a refused invite fetches once and succeeds if more seats were bought', async () => {
  const inUse = await used();
  await hostedWithSeats(inUse);
  statementSeats = inUse + 1;
  version += 1;
  fetchCalls = 0;
  const res = await invite(`bought-${s}@test.local`);
  assert.equal(res.status, 201);
  assert.equal(fetchCalls, 1);
});

test('reactivating a former member: one below the limit and at it', async () => {
  const formerA = await addMember({ active: false });
  const formerB = await addMember({ active: false });
  const [a] = await db.select({ email: users.email }).from(users).where(eq(users.id, formerA));
  const [b] = await db.select({ email: users.email }).from(users).where(eq(users.id, formerB));
  const inUse = await used();
  await hostedWithSeats(inUse + 1);
  assert.equal((await invite(a!.email!)).status, 201);
  const refused = await invite(b!.email!);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'SEAT_LIMIT_REACHED');
  const [row] = await db.select({ active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, formerB)));
  assert.equal(row!.active, false);
});

test('guest to member or admin: one below the limit and at it; demotion and agents are free', async () => {
  const g1 = await addMember({ role: 'guest' });
  const g2 = await addMember({ role: 'guest' });
  const inUse = await used();
  await hostedWithSeats(inUse + 1);
  // On a hosted cell only someone with two-step verification on can be made an admin.
  await db.insert(userTwoStep).values({ user_id: g1, secret_encrypted: 'not-a-real-secret', confirmed_at: new Date() });
  assert.equal((await setRole(g1, 'admin')).status, 200);
  const refused = await setRole(g2, 'member');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'SEAT_LIMIT_REACHED');
  const [row] = await db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, g2)));
  assert.equal(row!.role, 'guest');
  // Member to admin does not add a seat; member to guest frees one.
  assert.equal((await setRole(g1, 'member')).status, 200);
  assert.equal((await setRole(g1, 'guest')).status, 200);
  assert.equal((await setRole(g2, 'member')).status, 200);
  const agentGuest = await addMember({ kind: 'agent', role: 'guest' });
  assert.equal((await setRole(agentGuest, 'member')).status, 200, 'an agent takes no seat');
});

test('two invites at the same instant for the last seat: exactly one succeeds', async () => {
  const inUse = await used();
  await hostedWithSeats(inUse + 1);
  // Each request, once it has counted, waits (up to 500 ms) for the other to
  // count too. Without the seat lock both count the same free seat and both
  // insert; with it the second cannot count until the first has committed.
  let counted = 0;
  let release: () => void = () => {};
  const bothCounted = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
  seatTestHooks.afterCount = async () => {
    counted += 1;
    if (counted >= 2) release();
    await Promise.race([bothCounted, new Promise((r) => setTimeout(r, 500))]);
  };
  try {
    const results = await Promise.all([invite(`race-a-${s}@test.local`), invite(`race-b-${s}@test.local`)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(await used(), inUse + 1);
  } finally {
    seatTestHooks.afterCount = null;
  }
});

test('a paid re-invite, a guest re-invite and a promotion of one person at once: no deadlock', async () => {
  // Both routes must take the person's membership row before the seat lock.
  // With the opposite order, the paid re-invite (holding the seat lock) waits
  // for the row the promotion holds, while the promotion waits for the seat
  // lock: PostgreSQL kills one of them and the request returns a 500.
  const former = await addMember({ active: false });
  const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, former));
  await hostedWithSeats((await used()) + 5);
  let first = true;
  let releaseFirst: () => void = () => {};
  const firstMayFinish = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  let others: Promise<{ status: number }>[] = [];
  seatTestHooks.afterCount = async () => {
    if (!first) return;
    first = false;
    // The paid re-invite holds the seat lock here. Meanwhile the same person is
    // re-invited as a guest and then promoted.
    const guest = invite(person!.email!, 'guest');
    await Promise.race([guest, new Promise((r) => setTimeout(r, 1_000))]);
    const promote = setRole(former, 'member');
    others = [guest, promote];
    await new Promise((r) => setTimeout(r, 500));
    releaseFirst();
  };
  try {
    const paid = invite(person!.email!, 'member');
    await firstMayFinish;
    const statuses = [(await paid).status, ...(await Promise.all(others)).map((r) => r.status)];
    assert.ok(!statuses.includes(500), `no request fails with a deadlock: ${statuses.join(', ')}`);
    const [row] = await db.select({ active: orgMembers.is_active, role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, former)));
    assert.equal(row!.active, true);
  } finally {
    seatTestHooks.afterCount = null;
  }
});

test('frozen growth: settings missing in hosted mode', async () => {
  hostedEnv();
  _resetSeatProcessStateForTest();
  delete process.env.DEFT_SEAT_PUBLIC_KEYS;
  const status = await getSeatStatus(orgId);
  assert.deepEqual([status.growth_frozen, status.frozen_reason], [true, 'not_configured']);
  const refused = await invite(`nocfg-${s}@test.local`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'SEAT_GROWTH_FROZEN');
  assert.equal(refused.body.frozen_reason, 'not_configured');
  hostedEnv();
  process.env.DEFT_SEAT_STATEMENT_URL = 'http://control.test.invalid/seat';
  assert.equal((await getSeatStatus(orgId)).frozen_reason, 'not_configured', 'the fetch token is never sent in clear text');
  hostedEnv();
  process.env.DEFT_CELL_ID = '';
  assert.equal((await getSeatStatus(orgId)).frozen_reason, 'not_configured');
});

test('frozen growth: no statement ever stored, and the control plane unreachable', async () => {
  hostedEnv();
  _resetSeatProcessStateForTest();
  process.env.DEFT_CELL_ID = `${CELL}-empty`;
  fetchFails = true;
  assert.equal((await getSeatStatus(orgId)).frozen_reason, 'not_fetched_since_start');
  const refused = await invite(`nostmt-${s}@test.local`);
  assert.equal(refused.body.code, 'SEAT_GROWTH_FROZEN');
  assert.equal(fetchCalls, 1, 'the refusal tried one fetch');
  process.env.DEFT_CELL_ID = CELL;
});

test('frozen growth: the stored statement expired; a failed fetch keeps it and nobody is removed', async () => {
  await hostedWithSeats(1000);
  const inUse = await used();
  nowMs += 2 * 3600 * 1000; // past the statement's expiry
  fetchFails = true;
  const status = await getSeatStatus(orgId);
  assert.deepEqual([status.growth_frozen, status.frozen_reason], [true, 'expired']);
  const refused = await invite(`expired-${s}@test.local`);
  assert.equal(refused.body.code, 'SEAT_GROWTH_FROZEN');
  assert.equal(refused.body.frozen_reason, 'expired');
  assert.equal(await used(), inUse, 'frozen growth removes nobody');
  const [row] = await db.select().from(seatStatements).where(eq(seatStatements.cell_id, CELL));
  assert.equal(row!.seats, 1000, 'the last accepted statement is kept');
});

test('frozen growth: the stored statement no longer verifies (its key was removed)', async () => {
  await hostedWithSeats(1000);
  process.env.DEFT_SEAT_PUBLIC_KEYS = 'Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc';
  assert.equal((await getSeatStatus(orgId)).frozen_reason, 'statement_invalid');
});

test('restart with a stale stored statement: frozen until a fetch succeeds', async () => {
  await hostedWithSeats(1000);
  _resetSeatProcessStateForTest(); // the process restarts; the stored row survives
  fetchFails = true;
  const status = await getSeatStatus(orgId);
  assert.deepEqual([status.growth_frozen, status.frozen_reason, status.seat_limit], [true, 'not_fetched_since_start', 1000]);
  assert.equal((await invite(`restart-${s}@test.local`)).body.code, 'SEAT_GROWTH_FROZEN');
  fetchFails = false;
  nowMs += 11_000; // past the on-demand spacing
  assert.equal((await invite(`restart-${s}@test.local`)).status, 201, 'after a successful fetch, growth resumes');
});

test('intake refuses lower versions, other cells and bad tokens, keeping the stored one', async () => {
  await hostedWithSeats(50);
  const [row] = await db.select().from(seatStatements).where(eq(seatStatements.cell_id, CELL));
  assert.equal((await acceptSeatStatementToken(statementToken({ seats: 999, version: row!.version - 1 }))).ok, false);
  assert.deepEqual(await acceptSeatStatementToken(statementToken({ seats: 999, version: row!.version + 1, cell: 'cell-other' })), { ok: false, reason: 'wrong_cell' });
  assert.deepEqual(await acceptSeatStatementToken('deft-seat-v1.garbage'), { ok: false, reason: 'malformed' });
  assert.deepEqual(await acceptSeatStatementToken(42), { ok: false, reason: 'malformed' });
  assert.equal((await acceptSeatStatementToken(statementToken({ seats: 50, version: row!.version }))).ok, true, 'the same version re-fetched is accepted');
  const [after] = await db.select().from(seatStatements).where(eq(seatStatements.cell_id, CELL));
  assert.equal(after!.seats, 50);
  assert.equal(after!.highest_version, row!.version);
});

test('seat status route reports in use, the limit and frozen state', async () => {
  await hostedWithSeats(40);
  const res = await app.request('/api/members/seats');
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.hosted, true);
  assert.equal(body.seat_limit, 40);
  assert.equal(body.seats_in_use, await used());
  assert.equal(body.growth_frozen, false);
});
