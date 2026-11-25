/**
 * The cell heartbeat (telemetry contract v1.1, section 1b). Hosted cells only.
 *
 *   POST <control plane>/v1/cells/telemetry/heartbeat
 *   { "cell_id", "release", "seats_used", "sent_at" }
 *
 * So the ops view can show seats used against seats paid, and when the cell
 * was last heard from. `seats_used` is counted by the very function the seat
 * limit uses (seat-limit.ts countSeatsInUse: active human members who are not
 * guests; agents and guests never count). Nothing else is sent.
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

async function defaultSeatsUsed(): Promise<number> {
  const [{ db }, { orgs }, { asc }, { countSeatsInUse }] = await Promise.all([
    import('../db.js'),
    import('@deft/db/schema'),
    import('drizzle-orm'),
    import('../seat-limit.js'),
  ]);
  // A hosted cell holds one workspace (seat-limit.ts); before setup there is none.
  const [org] = await db.select({ id: orgs.id }).from(orgs).orderBy(asc(orgs.created_at), asc(orgs.id)).limit(1);
  return org ? countSeatsInUse(db, org.id) : 0;
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
    if (!Number.isInteger(seats) || seats < 0) return;
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

function schedule(delay: number): void {
  timer = setTimeout(() => {
    void sendHeartbeat().finally(() => {
      if (timer) schedule(between(INTERVAL_MS));
    });
  }, delay);
  timer.unref?.();
}

/** Start the heartbeat (server.ts, after listening). A no-op where it is off, or already started. */
export function startCellHeartbeat(): void {
  if (timer || !target()) return;
  schedule(between(FIRST_DELAY_MS));
}

export function stopCellHeartbeat(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function resetHeartbeatForTest(): void {
  stopCellHeartbeat();
  counters.sent = 0;
  counters.failed = 0;
}
