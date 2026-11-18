/**
 * Seat limit for hosted cells (hosted design note section 9).
 *
 * Who counts: active members who are people and not guests
 * (`org_members.is_active`, `users.kind = 'human'`, `role <> 'guest'`).
 * Agents, the system user and guests never count.
 *
 * How the cell learns its limit: it fetches a signed `deft-seat-v1` statement
 * from the control plane with its own fetch token (at start, on a timer, and
 * when adding a person is refused), checks it (lib/seat-statement.ts) and
 * stores the newest in `seat_statements`. Nothing is pushed into the cell and
 * the cell reports nothing.
 *
 * Self-hosted (hosted mode off): no limit, no fetch, no lock.
 *
 * Hosted with no valid statement - settings missing, never fetched since this
 * process started (for example after a restore), nothing stored, expired, or
 * failing verification - growth is frozen at the current count: nobody new
 * can be added. Nothing here ever removes, deactivates or locks out anyone.
 *
 * The first owner is the one exception: signup with the setup token
 * (routes/auth.ts) is never refused for want of seats, so claiming a cell
 * never waits on the control plane, and the owner then counts as one used
 * seat (owner's decision, 16 Nov 2026; test/seat-first-owner-db.test.ts).
 *
 * Every other path that adds a counted person calls `reserveSeat` inside the same
 * transaction as its write. `reserveSeat` and taking in a new statement both
 * hold one transaction-scoped advisory lock, so two requests can never both
 * take the last seat. A hosted cell holds one workspace, so the lock is
 * cell-wide.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { orgMembers, users } from '@deft/db/schema';
import { seatStatements } from '@deft/db/seat-statements';
import { db } from './db.js';
import { isHostedMode } from './hosted-mode.js';
import { assertNotPaused, isPausedStart } from './paused-start.js';
import { parseSeatSettings, type SeatSettings } from './seat-settings.js';
import {
  SEAT_STATEMENT_PREFIX,
  verifySeatStatement,
  type SeatRefusalReason,
  type SeatStatement,
} from './seat-statement.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const SEAT_LOCK_KEY = 'deft:seat-limit';
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_MAX_BYTES = 8 * 1024;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** On-demand refreshes (after a refusal) are coalesced and spaced at least this far apart. */
const ON_DEMAND_MIN_INTERVAL_MS = 10_000;

export type SeatFrozenReason =
  /** Hosted mode is on but the cell ID, public key or control-plane address is missing or unusable. */
  | 'not_configured'
  /** No statement has been accepted since this process started (for example after a restore). */
  | 'not_fetched_since_start'
  /** No statement has ever been stored for this cell. */
  | 'no_statement'
  /** The stored statement has expired. */
  | 'expired'
  /** The stored statement no longer verifies (for example its key was removed). */
  | 'statement_invalid';

export type SeatStatus = {
  hosted: boolean;
  seats_in_use: number;
  /** The paid seat count from the newest accepted statement; null when there is none or not hosted. */
  seat_limit: number | null;
  growth_frozen: boolean;
  frozen_reason: SeatFrozenReason | null;
};

export type SeatReservation =
  | { ok: true }
  | {
    ok: false;
    code: 'SEAT_LIMIT_REACHED' | 'SEAT_GROWTH_FROZEN';
    error: string;
    seat_limit: number | null;
    seats_in_use: number;
    frozen_reason: SeatFrozenReason | null;
  };

type SeatPolicy = { limit: number | null; frozen: SeatFrozenReason | null };

/** Network seam; tests replace this field. */
export const seatFetchDeps: { fetch: typeof fetch; now: () => number } = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

/** Test seam: runs inside `reserveSeat` after counting, before deciding. */
export const seatTestHooks: { afterCount: (() => Promise<void>) | null } = { afterCount: null };

let acceptedSinceStart = false;
let inFlight: Promise<SeatIntakeResult> | null = null;
let lastOnDemandAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Test-only: forget per-process state, as a restart would. */
export function _resetSeatProcessStateForTest(): void {
  acceptedSinceStart = false;
  inFlight = null;
  lastOnDemandAt = 0;
}

/** Startup refuses a hosted cell without these (env.ts); checked again here, fail closed. */
function readSeatSettings(): SeatSettings | null {
  const parsed = parseSeatSettings(process.env);
  return parsed.ok ? parsed.settings : null;
}

const nowSeconds = () => Math.floor(seatFetchDeps.now() / 1000);

async function takeSeatLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${SEAT_LOCK_KEY}, 0))`);
}

/** Active, human, non-guest members of a workspace. */
export async function countSeatsInUse(executor: Executor, orgId: string): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.is_active, true),
      eq(users.kind, 'human'),
      ne(orgMembers.role, 'guest'),
    ));
  return row?.n ?? 0;
}

async function readPolicy(executor: Executor): Promise<SeatPolicy> {
  const settings = readSeatSettings();
  if (!settings) return { limit: null, frozen: 'not_configured' };
  const [row] = await executor.select().from(seatStatements).where(eq(seatStatements.cell_id, settings.cellId)).limit(1);
  if (!row) return { limit: null, frozen: acceptedSinceStart ? 'no_statement' : 'not_fetched_since_start' };
  // Re-check the stored token each time: it may have expired, or its key may
  // have been removed from the settings since it was accepted.
  const verified = verifySeatStatement({
    token: row.token,
    publicKeys: settings.publicKeys,
    expectedCellId: settings.cellId,
    nowSeconds: nowSeconds(),
    versionFloor: 0,
  });
  if (!verified.ok) {
    return { limit: null, frozen: verified.reason === 'expired' ? 'expired' : 'statement_invalid' };
  }
  const limit = verified.statement.seats;
  if (!acceptedSinceStart) return { limit, frozen: 'not_fetched_since_start' };
  return { limit, frozen: null };
}

/** What the members page shows. */
export async function getSeatStatus(orgId: string): Promise<SeatStatus> {
  const seatsInUse = await countSeatsInUse(db, orgId);
  if (!isHostedMode()) {
    return { hosted: false, seats_in_use: seatsInUse, seat_limit: null, growth_frozen: false, frozen_reason: null };
  }
  const policy = await readPolicy(db);
  return {
    hosted: true,
    seats_in_use: seatsInUse,
    seat_limit: policy.limit,
    growth_frozen: policy.frozen !== null,
    frozen_reason: policy.frozen,
  };
}

/**
 * Call inside the transaction that adds one counted person, before the write.
 * Hosted: takes the seat lock (held until the transaction ends), counts, and
 * refuses when the workspace is full or growth is frozen. Self-hosted: always
 * allowed, no lock.
 */
export async function reserveSeat(tx: Tx, orgId: string): Promise<SeatReservation> {
  if (!isHostedMode()) return { ok: true };
  await takeSeatLock(tx);
  const policy = await readPolicy(tx);
  const seatsInUse = await countSeatsInUse(tx, orgId);
  if (seatTestHooks.afterCount) await seatTestHooks.afterCount();
  if (policy.frozen) {
    return {
      ok: false,
      code: 'SEAT_GROWTH_FROZEN',
      error: 'This workspace cannot add people right now because its seat limit could not be confirmed. Nobody already in the workspace is affected.',
      seat_limit: policy.limit,
      seats_in_use: seatsInUse,
      frozen_reason: policy.frozen,
    };
  }
  const limit = policy.limit ?? 0;
  if (seatsInUse + 1 > limit) {
    return {
      ok: false,
      code: 'SEAT_LIMIT_REACHED',
      error: `All ${limit} paid seats are in use (${seatsInUse} people). Buy more seats to add someone.`,
      seat_limit: limit,
      seats_in_use: seatsInUse,
      frozen_reason: null,
    };
  }
  return { ok: true };
}

export type SeatIntakeResult =
  | { ok: true; statement: SeatStatement }
  | { ok: false; reason: SeatRefusalReason | 'not_hosted' | 'not_configured' | 'fetch_failed' };

/**
 * Check a statement and, if it is accepted, store it as the newest, under
 * the seat lock. A refused statement changes nothing.
 */
export async function acceptSeatStatementToken(token: unknown): Promise<SeatIntakeResult> {
  assertNotPaused('seat statement storage');
  if (!isHostedMode()) return { ok: false, reason: 'not_hosted' };
  const settings = readSeatSettings();
  if (!settings) return { ok: false, reason: 'not_configured' };
  const result = await db.transaction(async (tx): Promise<SeatIntakeResult> => {
    await takeSeatLock(tx);
    const [current] = await tx.select({ highest_version: seatStatements.highest_version })
      .from(seatStatements).where(eq(seatStatements.cell_id, settings.cellId)).limit(1);
    const verified = verifySeatStatement({
      token,
      publicKeys: settings.publicKeys,
      expectedCellId: settings.cellId,
      nowSeconds: nowSeconds(),
      versionFloor: current?.highest_version ?? 0,
    });
    if (!verified.ok) return verified;
    const s = verified.statement;
    const values = {
      token: token as string,
      seats: s.seats,
      version: s.version,
      issued_at: s.issued_at,
      expires_at: s.expires_at,
      highest_version: Math.max(s.version, current?.highest_version ?? 0),
      accepted_at: new Date(),
    };
    await tx.insert(seatStatements).values({ cell_id: settings.cellId, ...values })
      .onConflictDoUpdate({ target: seatStatements.cell_id, set: { ...values, updated_at: new Date() } });
    return verified;
  });
  if (result.ok) acceptedSinceStart = true;
  return result;
}

/** The body is the token itself, or JSON carrying it as `statement` or `token`. */
function tokenFromBody(body: string): unknown {
  const text = body.trim();
  if (text.startsWith(`${SEAT_STATEMENT_PREFIX}.`)) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      return record.statement ?? record.token;
    }
  } catch {
    // fall through
  }
  return null;
}

async function readCappedBody(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > FETCH_MAX_BYTES) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchAndAccept(): Promise<SeatIntakeResult> {
  assertNotPaused('the seat statement service');
  if (!isHostedMode()) return { ok: false, reason: 'not_hosted' };
  const settings = readSeatSettings();
  if (!settings) return { ok: false, reason: 'not_configured' };
  let body: string | null;
  try {
    const res = await seatFetchDeps.fetch(settings.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${settings.fetchToken}`, accept: 'application/json, text/plain' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'fetch_failed' };
    }
    body = await readCappedBody(res);
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
  if (body === null) return { ok: false, reason: 'fetch_failed' };
  try {
    return await acceptSeatStatementToken(tokenFromBody(body));
  } catch {
    // A database error keeps the last accepted statement.
    return { ok: false, reason: 'fetch_failed' };
  }
}

/**
 * Fetch the current statement and take it in. A failed fetch or a refused
 * statement keeps the last accepted one. Concurrent callers share one fetch.
 */
export function refreshSeatStatement(): Promise<SeatIntakeResult> {
  if (!inFlight) {
    inFlight = fetchAndAccept().finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** After a refusal for lack of seats: refresh, at most once per short interval. */
async function refreshAfterRefusal(): Promise<boolean> {
  if (inFlight) return (await inFlight).ok;
  const now = seatFetchDeps.now();
  if (now - lastOnDemandAt < ON_DEMAND_MIN_INTERVAL_MS) return false;
  lastOnDemandAt = now;
  return (await refreshSeatStatement()).ok;
}

/**
 * Run `attempt` (one transaction that may call `reserveSeat`). If it is
 * refused for lack of seats on a hosted cell, fetch a fresh statement and,
 * if one was accepted, run it once more.
 */
export async function withSeatRetry<T>(
  attempt: () => Promise<T>,
  refusal: (result: T) => SeatReservation | null,
): Promise<T> {
  const first = await attempt();
  if (!isHostedMode() || !refusal(first)) return first;
  if (!(await refreshAfterRefusal())) return first;
  return attempt();
}

/** Start-of-process fetch plus a timer. No-op when paused or hosted mode is off. */
export function startSeatStatementRefresher(): void {
  if (isPausedStart() || !isHostedMode() || refreshTimer) return;
  const run = () => {
    void refreshSeatStatement().then((result) => {
      if (!result.ok) console.warn("[seats] Seat statement not refreshed: <redacted>");
    });
  };
  run();
  refreshTimer = setInterval(run, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

export function stopSeatStatementRefresher(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
