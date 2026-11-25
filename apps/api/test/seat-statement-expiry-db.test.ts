/**
 * Launch check 8.3, rows 8 and 7b, against a real database and the real
 * member routes (hosted design note section 9).
 *
 *   Row 8: a cell holds a valid seat statement, the statement then expires,
 *   and the control plane cannot be reached. Growth freezes at the current
 *   count: the eleventh person is refused by every path that adds one
 *   (invite, reactivating a former member, guest to member), nobody already
 *   in is removed, and inviting a guest still works. Checked just after the
 *   expiry, just past the five-minute clock-skew allowance, and long after,
 *   so a grace window wider than the skew fails this file.
 *
 *   Row 7b: while a valid statement is stored, the control plane serves one
 *   that has already expired (with more seats and a higher version). It is
 *   refused on time alone at each of the three fetch moments (start, timer,
 *   and the fetch made when an invitation hits the limit); the valid one is
 *   kept and no extra person is admitted.
 *
 * Each case starts from a valid baseline in which the eleventh person would
 * be admitted, so a refusal is never just "there was no statement at all".
 *
 * Run: pnpm --filter @deft/api test test/seat-statement-expiry-db.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { invites, orgMembers, orgs, spaceMembers, users } from '@deft/db/schema';
import { seatStatements } from '@deft/db/seat-statements';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';
import { db } from '../src/lib/db.js';
import {
  _resetSeatProcessStateForTest,
  acceptSeatStatementToken,
  countSeatsInUse,
  getSeatStatus,
  refreshSeatStatement,
  reserveSeat,
  seatFetchDeps,
  startSeatStatementRefresher,
  stopSeatStatementRefresher,
} from '../src/lib/seat-limit.js';
import { DEFAULT_SEAT_CLOCK_SKEW_SECONDS } from '../src/lib/seat-statement.js';

const s = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const CELL = `cell-expiry-${s}`;
const orgId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const createdUserIds = new Set<string>([ownerId]);
/** The clock-skew allowance launch check 8.3 accepts: minutes. Any grace on expiry beyond it fails this file. */
const SKEW_SECONDS = 300;
const PEOPLE = 10;

// Published test key from the deft-seat-v1 vectors; never trusted outside tests.
const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/seat-statement-v1.json'), 'utf8')) as {
  keys: { signing: { private_key: string; public_key: string } };
};
const signingKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.keys.signing.private_key, 'base64url')]),
  format: 'der',
  type: 'pkcs8',
});

function statementToken(opts: { seats: number; version: number; issuedAt: number; expiresAt: number }): string {
  const payload = `{"cell_id":"${CELL}","seats":${opts.seats},"version":${opts.version},"issued_at":${opts.issuedAt},"expires_at":${opts.expiresAt}}`;
  const input = `deft-seat-v1.${Buffer.from(payload, 'ascii').toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input, 'ascii'), signingKey).toString('base64url')}`;
}

let nowMs = Date.now();
const nowSeconds = () => Math.floor(nowMs / 1000);
let version = 1;
/** What the stand-in control plane answers with; null means it cannot be reached. */
let serve: (() => string) | null = null;
let fetchCalls = 0;

const realFetch = seatFetchDeps.fetch;
const realNow = seatFetchDeps.now;
const savedEnv = { ...process.env };

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

async function addMember(opts: { role?: 'member' | 'guest'; active?: boolean } = {}) {
  const id = crypto.randomUUID();
  createdUserIds.add(id);
  await db.insert(users).values({ id, email: `p-${id}@test.local`, name: 'P', kind: 'human' });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: id, role: opts.role ?? 'member', is_active: opts.active ?? true });
  return id;
}

let former = '';
let formerEmail = '';
let guest = '';

const used = () => countSeatsInUse(db, orgId);

async function storedStatement() {
  const [row] = await db.select().from(seatStatements).where(eq(seatStatements.cell_id, CELL));
  return row;
}

/** Everyone counted before: still active, same roles. */
async function activeCounted() {
  const rows = await db.select({ id: orgMembers.user_id }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true), eq(users.kind, 'human'), sql`${orgMembers.role} <> 'guest'`));
  return rows.map((row) => row.id).sort();
}

/**
 * A process that has just started and fetched a valid statement for `seats`
 * seats, valid for an hour from now. Returns the stored statement.
 */
async function validBaseline(seats: number) {
  _resetSeatProcessStateForTest();
  version += 1;
  const issuedAt = nowSeconds() - 10;
  const token = statementToken({ seats, version, issuedAt, expiresAt: issuedAt + 3600 });
  serve = () => token;
  const accepted = await refreshSeatStatement();
  assert.equal(accepted.ok, true, 'the baseline statement is accepted');
  const status = await getSeatStatus(orgId);
  assert.deepEqual([status.growth_frozen, status.seat_limit, status.seats_in_use], [false, seats, PEOPLE], 'baseline: not frozen');
  return (await storedStatement())!;
}

/** Whether the next counted person would be admitted right now (checked in a transaction that is then rolled back). */
async function wouldAdmitOneMore() {
  const rollback = new Error('rollback');
  let ok: boolean | undefined;
  await db.transaction(async (tx) => {
    ok = (await reserveSeat(tx, orgId)).ok;
    throw rollback;
  }).catch((error: unknown) => { if (error !== rollback) throw error; });
  return ok;
}

/** The three ways a counted person is added, each made by the owner through the real routes. */
async function threeAttempts(label: string) {
  const attempts = {
    invite: await invite(`new-${label.replace(/\W+/g, '-')}-${s}@test.local`),
    reactivate: await invite(formerEmail),
    promote: await setRole(guest, 'member'),
  };
  return attempts;
}

before(async () => {
  // A local database whose push-full stopped before the forward upgrades may
  // lack the table; create it from the upgrade file. In CI it must exist.
  const exists = await db.execute(sql`SELECT to_regclass('public.seat_statements') IS NOT NULL AS present`);
  if (!(exists.rows[0] as { present: boolean }).present && process.env.CI !== 'true') {
    await db.execute(sql.raw(readFileSync(resolve(import.meta.dirname, '../../../packages/db/upgrades/0.3.0-preview.144-seat-statements.sql'), 'utf8')));
  }
  await ensureTwoStepTables((process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL)!);
  await db.insert(orgs).values({ id: orgId, name: `Seat expiry ${s}`, slug: `seat-expiry-${s}` });
  await db.insert(users).values({ id: ownerId, email: `owner-${s}@test.local`, name: 'Owner' });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: ownerId, role: 'owner' });
  for (let i = 1; i < PEOPLE; i += 1) await addMember();
  former = await addMember({ active: false });
  formerEmail = (await db.select({ email: users.email }).from(users).where(eq(users.id, former)))[0]!.email!;
  guest = await addMember({ role: 'guest' });
  assert.equal(await used(), PEOPLE, 'ten people hold seats');

  const { memberRoutes } = await import('../src/routes/members.js');
  app.route('/api/members', memberRoutes);
  seatFetchDeps.now = () => nowMs;
  seatFetchDeps.fetch = async (_url, init) => {
    fetchCalls += 1;
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-fetch-token');
    if (!serve) throw new Error('control plane unreachable');
    return new Response(JSON.stringify({ statement: serve() }), { status: 200 });
  };
  process.env.DEFT_HOSTED = 'true';
  process.env.DEFT_CELL_ID = CELL;
  process.env.DEFT_SEAT_PUBLIC_KEYS = vectors.keys.signing.public_key;
  process.env.DEFT_SEAT_STATEMENT_URL = 'https://control.test.invalid/v1/seat-statement';
  process.env.DEFT_SEAT_FETCH_TOKEN = 'test-fetch-token';
});

after(async () => {
  stopSeatStatementRefresher();
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

test('the cell allows a clock-skew of minutes, not hours', () => {
  assert.ok(DEFAULT_SEAT_CLOCK_SKEW_SECONDS <= SKEW_SECONDS, `skew is ${DEFAULT_SEAT_CLOCK_SKEW_SECONDS}s`);
});

const AFTER_EXPIRY: Array<[string, number]> = [
  ['one second after expiry', 1],
  ['just past the five-minute clock-skew allowance', SKEW_SECONDS + 1],
  ['an hour after expiry', 3600],
  ['thirty days after expiry', 30 * 86_400],
];

for (const [when, seconds] of AFTER_EXPIRY) {
  test(`row 8: the statement expired (${when}) and the control plane is unreachable: growth freezes, the eleventh person is refused`, async () => {
    nowMs = Date.now();
    const baseline = await validBaseline(PEOPLE + 1);
    assert.equal(await wouldAdmitOneMore(), true, 'baseline: the eleventh person would be admitted');
    const counted = await activeCounted();

    // The statement expires, and the control plane cannot be reached.
    serve = null;
    nowMs = (baseline.expires_at + seconds) * 1000;
    fetchCalls = 0;
    const status = await getSeatStatus(orgId);
    assert.deepEqual([status.growth_frozen, status.frozen_reason], [true, 'expired'], `${when}: growth is frozen`);
    assert.equal(await wouldAdmitOneMore(), false, `${when}: the eleventh person would not be admitted`);

    const attempts = await threeAttempts(when);
    for (const [path, result] of Object.entries(attempts)) {
      assert.equal(result.status, 409, `${when}: ${path} is refused: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, 'SEAT_GROWTH_FROZEN', `${when}: ${path}`);
      assert.equal(result.body.frozen_reason, 'expired', `${when}: ${path}`);
      assert.equal(typeof result.body.error, 'string', `${when}: ${path} says why`);
    }
    assert.ok(fetchCalls >= 1, `${when}: the refusal tried to fetch a fresh statement`);
    assert.equal(await used(), PEOPLE, `${when}: growth frozen at the current count`);
    assert.deepEqual(await activeCounted(), counted, `${when}: nobody already in is removed`);
    const [formerRow] = await db.select({ active: orgMembers.is_active }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, former)));
    assert.equal(formerRow!.active, false, `${when}: the former member stays out`);
    const [guestRow] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, guest)));
    assert.equal(guestRow!.role, 'guest', `${when}: the guest stays a guest`);
    const kept = await storedStatement();
    assert.deepEqual([kept!.token, kept!.seats], [baseline.token, PEOPLE + 1], `${when}: the last accepted statement is kept`);

    // Guests take no seat: inviting one still works, and existing people keep working.
    assert.equal((await invite(`guest-${seconds}-${s}@test.local`, 'guest')).status, 201, `${when}: a guest can still be invited`);
    assert.equal((await app.request('/api/members/seats')).status, 200, `${when}: the owner keeps working`);
  });
}

const EXPIRED_BY: Array<[string, number]> = [
  ['expired one second ago', 1],
  ['expired just past the clock-skew allowance', SKEW_SECONDS + 1],
  ['expired thirty days ago', 30 * 86_400],
];

for (const [when, seconds] of EXPIRED_BY) {
  test(`row 7b: a statement ${when}, offered while a valid one is stored, is refused at start, on the timer and on the on-limit fetch`, async (t) => {
    nowMs = Date.now();
    // The valid baseline is at its limit: ten seats, ten people.
    const baseline = await validBaseline(PEOPLE);
    assert.equal(await wouldAdmitOneMore(), false, 'baseline: at the limit');
    // From now on the stand-in serves an expired statement with a higher version and more seats.
    serve = () => {
      const expiresAt = nowSeconds() - seconds;
      return statementToken({ seats: PEOPLE + 50, version: baseline.version + 1, issuedAt: expiresAt - 3600, expiresAt });
    };

    const expectKept = async (moment: string) => {
      const kept = await storedStatement();
      assert.deepEqual(
        [kept!.token, kept!.seats, Number(kept!.version), Number(kept!.highest_version)],
        [baseline.token, PEOPLE, Number(baseline.version), Number(baseline.version)],
        `${when}, ${moment}: the valid statement is kept`,
      );
      const status = await getSeatStatus(orgId);
      assert.deepEqual([status.seat_limit, status.growth_frozen], [PEOPLE, false], `${when}, ${moment}: the limit is still the valid one`);
      assert.equal(await used(), PEOPLE, `${when}, ${moment}: no extra person`);
    };

    // At start, and on the refresher's own timer: each fetch is the refresher's, observed as it is made. Awaiting
    // refreshSeatStatement() then joins that fetch (it makes no fetch of its own while one is in flight).
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      stopSeatStatementRefresher();
      fetchCalls = 0;
      startSeatStatementRefresher();
      assert.equal(fetchCalls, 1, `${when}: the refresher fetched at start`);
      assert.deepEqual(await refreshSeatStatement(), { ok: false, reason: 'expired' }, `${when}: refused at start`);
      assert.equal(fetchCalls, 1, `${when}: the start fetch was the refresher's own`);
      await expectKept('at start');

      nowMs += 15 * 60 * 1000;
      t.mock.timers.tick(15 * 60 * 1000);
      assert.equal(fetchCalls, 2, `${when}: the refresher fetched on its timer`);
      assert.deepEqual(await refreshSeatStatement(), { ok: false, reason: 'expired' }, `${when}: refused on the timer`);
      assert.equal(fetchCalls, 2, `${when}: the timer fetch was the refresher's own`);
      await expectKept('on the timer');
    } finally {
      stopSeatStatementRefresher();
      t.mock.timers.reset();
    }

    // Handed to intake directly.
    assert.deepEqual(await acceptSeatStatementToken(serve()), { ok: false, reason: 'expired' }, `${when}: intake refuses it on time alone`);

    // On the on-limit fetch: each attempt to add the eleventh person fetches, gets the expired statement, and is refused.
    for (const [path, attempt] of [
      ['invite', () => invite(`limit-${seconds}-${s}@test.local`)],
      ['reactivate', () => invite(formerEmail)],
      ['promote', () => setRole(guest, 'member')],
    ] as const) {
      nowMs += 11_000; // past the spacing between on-demand fetches
      fetchCalls = 0;
      const refused = await attempt();
      assert.equal(fetchCalls, 1, `${when}, ${path}: the on-limit fetch was made`);
      assert.equal(refused.status, 409, `${when}, ${path}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, 'SEAT_LIMIT_REACHED', `${when}, ${path}`);
      assert.equal(refused.body.seat_limit, PEOPLE, `${when}, ${path}: judged on the valid statement`);
      await expectKept(`on-limit fetch (${path})`);
    }
  });
}

test('row 7b canary: the same on-limit fetch serving a valid statement with more seats admits the eleventh person', async () => {
  nowMs = Date.now();
  const baseline = await validBaseline(PEOPLE);
  serve = () => statementToken({ seats: PEOPLE + 1, version: baseline.version + 1, issuedAt: nowSeconds() - 10, expiresAt: nowSeconds() + 3600 });
  nowMs += 11_000;
  fetchCalls = 0;
  const admitted = await invite(`canary-${s}@test.local`);
  assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
  assert.equal(fetchCalls, 1);
  assert.equal(await used(), PEOPLE + 1);
});
