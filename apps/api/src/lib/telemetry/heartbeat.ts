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

/** How long the seat count may take in the database: well inside the server's shutdown deadline. */
const SEAT_QUERY_TIMEOUT = '3s';

/**
 * The seat count, or null when there is no single workspace to count. A
 * hosted cell holds one workspace (seat-limit.ts); before setup there is none
 * (0). Two or more (a database restored over another, say) is ambiguous:
 * nothing is sent rather than one workspace's count under the cell's name.
 * The queries run in one read transaction that the database ends after 3
 * seconds, so a heartbeat never holds a connection through a shutdown.
 */
async function defaultSeatsUsed(): Promise<number | null> {
  const [{ db }, { orgs }, { sql }, { countSeatsInUse }] = await Promise.all([
    import('../db.js'),
    import('@deft/db/schema'),
    import('drizzle-orm'),
    import('../seat-limit.js'),
  ]);
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${SEAT_QUERY_TIMEOUT}'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${SEAT_QUERY_TIMEOUT}'`));
    const workspaces = await tx.select({ id: orgs.id }).from(orgs).limit(2);
    if (workspaces.length === 0) return 0;
    if (workspaces.length > 1) return null;
    return countSeatsInUse(tx, workspaces[0]!.id);
  }, { accessMode: 'read only' });
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
}

export function resetHeartbeatForTest(): void {
  stopCellHeartbeat();
  counters.sent = 0;
  counters.failed = 0;
}
