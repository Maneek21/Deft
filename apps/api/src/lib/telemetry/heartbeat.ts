/**
 * The cell heartbeat (telemetry contract v1.1, section 1b). Hosted cells only.
 *
 *   POST <control plane>/v1/cells/telemetry/heartbeat
 *   { "cell_id", "release", "seats_used", "sent_at" }
 *
 * So the ops view can show seats used against seats paid, and when the cell
 * was last heard from. `seats_used` is counted by the very function the seat
 * limit uses (seat-limit.ts countSeatsInUse: active human members who are not
 * guests; agents and guests never count). Nothing else is sent. With no
 * single workspace to count (two, after a database restored over another),
 * nothing is sent at all.
 *
 * Once shortly after start (30 to 90 seconds, so a restart storm does not
 * arrive all at once), then about hourly (55 to 65 minutes). Fire-and-forget:
 * a short timeout, no retry; a failure is dropped and counted, and the next
 * heartbeat is simply the next one.
 *
 * Off unless the cell is hosted with its control-plane settings, the build is
 * a production one, and DEFT_TELEMETRY is not off (settings.ts); off on a
 * paused start.
 */
import { isPausedStart } from '../paused-start.js';
import { releaseLabel } from './scrub.js';
import { errorTelemetryTarget, type ControlPlaneTarget } from './settings.js';

const SEND_TIMEOUT_MS = 5_000;
export const FIRST_DELAY_MS = { min: 30_000, max: 90_000 };
export const INTERVAL_MS = { min: 55 * 60_000, max: 65 * 60_000 };

/** How long the seat count may wait or run in the database. */
const SEAT_QUERY_TIMEOUT = '3s';
/** After this long with a connection out, the heartbeat gives it up, whatever the database is doing. */
export const SEAT_DEADLINE_MS = 4_000;

/** Set while a seat count holds a connection: gives it up at once (stopCellHeartbeat). */
let giveUpConnection: (() => void) | null = null;

/**
 * The seat count, or null when there is no single workspace to count. A
 * hosted cell holds one workspace (seat-limit.ts); before setup there is none
 * (0). Two or more (a database restored over another, say) is ambiguous:
 * nothing is sent rather than one workspace's count under the cell's name.
 *
 * It never holds a database connection through a shutdown. It checks one out
 * of the shared pool (at most 5 seconds: db.ts connectionTimeoutMillis, which
 * pg-pool applies to queued checkouts too) and runs one read-only transaction
 * on it, which the database ends after 3 seconds. Stopping the heartbeat, or
 * 4 seconds with the connection out (a stalled network, say), gives the
 * connection up: it is released with an error, which takes it out of the
 * pool at once (so closing the pool never waits for it), and its socket is
 * destroyed. The pending query then fails, and the heartbeat sends nothing.
 * A stop that comes while the count is still waiting for its connection
 * counts too: the connection it then gets is given up, never handed back.
 */
async function defaultSeatsUsed(): Promise<number | null> {
  // Taken before anything is awaited: a stop at any point after this call
  // began counts (see `stopped` below).
  const owner = generation;
  const stopped = () => owner !== generation;
  const [{ db }, schema, { sql }, { drizzle }, { countSeatsInUse }] = await Promise.all([
    import('../db.js'),
    import('@deft/db/schema'),
    import('drizzle-orm'),
    import('drizzle-orm/node-postgres'),
    import('../seat-limit.js'),
  ]);
  // A stop while this count is anywhere in flight (even still waiting for
  // its connection) means its connection is given up, never handed back.
  if (stopped()) throw new Error('heartbeat stopped');
  const client = await db.$client.connect();
  let given = false;
  const giveUp = (error?: Error) => {
    if (given) return;
    given = true;
    client.release(error);
    if (error) {
      try { (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy(); } catch { /* already closed */ }
    }
  };
  if (stopped()) {
    giveUp(new Error('heartbeat stopped'));
    throw new Error('heartbeat stopped');
  }
  const deadline = setTimeout(() => giveUp(new Error('heartbeat seat count deadline')), SEAT_DEADLINE_MS);
  deadline.unref?.();
  giveUpConnection = () => giveUp(new Error('heartbeat stopped'));
  try {
    const reader = drizzle(client, { schema });
    const seats = await reader.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${SEAT_QUERY_TIMEOUT}'`));
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${SEAT_QUERY_TIMEOUT}'`));
      const workspaces = await tx.select({ id: schema.orgs.id }).from(schema.orgs).limit(2);
      if (workspaces.length === 0) return 0;
      if (workspaces.length > 1) return null;
      return countSeatsInUse(tx as unknown as Parameters<typeof countSeatsInUse>[0], workspaces[0]!.id);
    }, { accessMode: 'read only' });
    // Stopped while counting: nothing is sent.
    if (stopped()) throw new Error('heartbeat stopped');
    return seats;
  } finally {
    clearTimeout(deadline);
    giveUpConnection = null;
    // Handed back to the pool only if the heartbeat is still running.
    giveUp(stopped() ? new Error('heartbeat stopped') : undefined);
  }
}

async function defaultRelease(): Promise<string> {
  const { DEFT_RELEASE_VERSION } = await import('../agent-channel.js');
  return DEFT_RELEASE_VERSION;
}

/** Test seams. */
export const heartbeatDeps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  now: (): number => Date.now(),
  random: (): number => Math.random(),
  env: process.env as NodeJS.ProcessEnv,
  seatsUsed: defaultSeatsUsed,
  release: defaultRelease,
  isPaused: (): boolean => isPausedStart(),
};

const counters = { sent: 0, failed: 0 };
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every stop: a send that began under an older generation never schedules another. */
let generation = 0;

export function heartbeatCounters(): { sent: number; failed: number } {
  return { ...counters };
}

function target(): ControlPlaneTarget | null {
  return heartbeatDeps.isPaused() ? null : errorTelemetryTarget(heartbeatDeps.env);
}

function between(range: { min: number; max: number }): number {
  return Math.round(range.min + (range.max - range.min) * heartbeatDeps.random());
}

/** Send one heartbeat now. Never throws; resolves when it has been sent or dropped. */
export async function sendHeartbeat(): Promise<void> {
  try {
    const destination = target();
    if (!destination) return;
    const seats = await heartbeatDeps.seatsUsed();
    if (seats === null || !Number.isInteger(seats) || seats < 0) return;
    const body = JSON.stringify({
      cell_id: destination.cellId,
      release: releaseLabel(await heartbeatDeps.release().catch(() => 'unknown')),
      seats_used: seats,
      sent_at: new Date(heartbeatDeps.now()).toISOString(),
    });
    const res = await heartbeatDeps.fetch(`${destination.baseUrl}/v1/cells/telemetry/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${destination.token}`, 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) counters.sent += 1;
    else counters.failed += 1;
  } catch {
    counters.failed += 1;
  }
}

function schedule(delay: number, owner: number): void {
  timer = setTimeout(() => {
    void sendHeartbeat().finally(() => {
      // Only the run that is still current schedules the next one: a stop (and
      // any restart) while this send was out leaves the newer timer alone.
      if (owner === generation && timer) schedule(between(INTERVAL_MS), owner);
    });
  }, delay);
  timer.unref?.();
}

/** Start the heartbeat (server.ts, after listening). A no-op where it is off, or already started. */
export function startCellHeartbeat(): void {
  if (timer || !target()) return;
  schedule(between(FIRST_DELAY_MS), generation);
}

export function stopCellHeartbeat(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  // A seat count still holding a connection gives it up now (see defaultSeatsUsed).
  giveUpConnection?.();
}

export function resetHeartbeatForTest(): void {
  stopCellHeartbeat();
  counters.sent = 0;
  counters.failed = 0;
}
