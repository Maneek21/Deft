/**
 * Hosted error events (telemetry contract, section 1).
 *
 * What is captured: unhandled request errors, 5xx responses, failed
 * background jobs, uncaught process errors, and browser errors the web app
 * reports to its own cell (routes/telemetry.ts). Each is scrubbed here
 * (scrub.ts) the moment it is captured, and once more just before sending.
 *
 * Events are aggregated in memory by fingerprint. At most one batch leaves
 * per minute: at most 50 events and 64 KB, to
 * `<control plane>/v1/cells/telemetry/errors`, authenticated like the seat
 * statement fetch. Sending is fire-and-forget with a short timeout. It never
 * blocks a request or a job, and is never retried: a failed batch is dropped
 * and counted, and repeated failures (or a 429) pause sending for a while.
 *
 * Off unless the cell is hosted and has its control-plane settings
 * (settings.ts); off on a paused start; off with DEFT_TELEMETRY=off.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isPausedStart } from '../paused-start.js';
import {
  containsKnownValue,
  fingerprint,
  knownValuesPattern,
  parseStack,
  scrubErrorClass,
  scrubFunctionName,
  scrubMessage,
  scrubMethod,
  scrubRequestIds,
  scrubRouteTemplate,
  scrubStatus,
  type KnownValues,
  type TelemetryFrame,
  type TelemetryMethod,
} from './scrub.js';
import { errorTelemetryTarget, type ControlPlaneTarget } from './settings.js';

export type TelemetryKind = 'server' | 'job' | 'client';

export type TelemetryEvent = {
  kind: TelemetryKind;
  fingerprint: string;
  error_class: string;
  message: string;
  frames: TelemetryFrame[];
  route: string | null;
  method: TelemetryMethod | null;
  status: number | null;
  job: string | null;
  request_ids: string[];
  first_seen_at: string;
  last_seen_at: string;
  count: number;
};

export const FLUSH_INTERVAL_MS = 60_000;
export const BATCH_MAX_EVENTS = 50;
export const BATCH_MAX_BYTES = 64 * 1024;
/** Distinct fingerprints held between batches; new ones beyond this are dropped and counted. */
export const BUFFER_MAX_FINGERPRINTS = 200;
/**
 * Of those, browser reports may hold at most half. The browser route is open
 * to anyone (signed in or not), so junk sent there can never crowd out the
 * server's own errors.
 */
export const BUFFER_MAX_CLIENT_FINGERPRINTS = 100;
const SEND_TIMEOUT_MS = 5_000;
const KNOWN_VALUES_TTL_MS = 10 * 60 * 1000;
const PAUSE_AFTER_REFUSAL_MS = 5 * 60 * 1000;
const PAUSE_MAX_MS = 30 * 60 * 1000;
const TARGET_TTL_MS = 30_000;

/** The repository root: frames are reported relative to it. */
export const APP_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');

async function defaultRelease(): Promise<string> {
  const { DEFT_RELEASE_VERSION } = await import('../agent-channel.js');
  return DEFT_RELEASE_VERSION;
}

/** The workspace's own names and its people's names, removed from every message. */
async function defaultKnownValues(): Promise<string[]> {
  const [{ db }, { orgs, users }, { eq }] = await Promise.all([
    import('../db.js'),
    import('@deft/db/schema'),
    import('drizzle-orm'),
  ]);
  const [orgRows, people] = await Promise.all([
    db.select({ name: orgs.name, slug: orgs.slug }).from(orgs).limit(100),
    db.select({ name: users.name }).from(users).where(eq(users.kind, 'human')).limit(5000),
  ]);
  return [
    ...orgRows.flatMap((row) => [row.name, row.slug, row.slug.replace(/-[a-z0-9]{8}$/, '')]),
    ...people.map((row) => row.name),
  ];
}

/** Test seams. */
export const errorReporterDeps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  now: (): number => Date.now(),
  env: process.env as NodeJS.ProcessEnv,
  release: defaultRelease,
  knownValues: defaultKnownValues,
  isPaused: (): boolean => isPausedStart(),
};

export type TelemetryCounters = {
  captured: number;
  dropped_buffer_full: number;
  batches_sent: number;
  batches_failed: number;
  events_sent: number;
  events_dropped: number;
};

const counters: TelemetryCounters = {
  captured: 0,
  dropped_buffer_full: 0,
  batches_sent: 0,
  batches_failed: 0,
  events_sent: 0,
  events_dropped: 0,
};

const buffer = new Map<string, TelemetryEvent>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let pausedUntil = 0;
let consecutiveFailures = 0;
let known: { pattern: KnownValues | null; loadedAt: number } = { pattern: null, loadedAt: -Infinity };
let knownLoading: Promise<void> | null = null;
let cachedTarget: { value: ControlPlaneTarget | null; at: number } | null = null;

function target(): ControlPlaneTarget | null {
  const now = errorReporterDeps.now();
  if (cachedTarget && now - cachedTarget.at < TARGET_TTL_MS) return cachedTarget.value;
  const value = errorReporterDeps.isPaused() ? null : errorTelemetryTarget(errorReporterDeps.env);
  cachedTarget = { value, at: now };
  return value;
}

/** True when this cell sends error events. */
export function isErrorTelemetryEnabled(): boolean {
  return target() !== null;
}

function refreshKnownValues(force = false): Promise<void> {
  const now = errorReporterDeps.now();
  if (!force && now - known.loadedAt < KNOWN_VALUES_TTL_MS) return Promise.resolve();
  if (knownLoading) return knownLoading;
  knownLoading = (async () => {
    try {
      known = { pattern: knownValuesPattern(await errorReporterDeps.knownValues()), loadedAt: errorReporterDeps.now() };
    } catch {
      // Keep the last list; the regular-expression rules still apply.
      known = { ...known, loadedAt: errorReporterDeps.now() };
    } finally {
      knownLoading = null;
    }
  })();
  return knownLoading;
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => { void flushErrorTelemetry(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  void refreshKnownValues();
}

type CaptureInput = {
  kind: TelemetryKind;
  errorClass: unknown;
  message: unknown;
  stack?: unknown;
  route?: unknown;
  method?: unknown;
  status?: unknown;
  job?: unknown;
  requestIds?: unknown;
};

function firstLine(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  // A database driver's message ends with the query's parameters: customer data.
  const cut = text.search(/\bparams:|\bparameters:|\bdetail:/i);
  return (cut >= 0 ? text.slice(0, cut) : text).split('\n', 1)[0] ?? '';
}

function jobName(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-z0-9][a-z0-9:_.-]{0,79}$/i.test(raw) ? raw : null;
}

function record(input: CaptureInput): void {
  try {
    if (!target()) return;
    ensureTimer();
    counters.captured += 1;
    const pattern = known.pattern;
    const errorClass = scrubErrorClass(input.errorClass, pattern);
    const frames = parseStack(input.stack, input.kind === 'client' ? null : APP_ROOT, pattern);
    const route = scrubRouteTemplate(input.route);
    const method = scrubMethod(input.method);
    const fallback = input.kind === 'job' ? `job:${jobName(input.job) ?? ''}` : `${method ?? ''} ${route ?? ''}`;
    const print = fingerprint(input.kind, errorClass, frames, fallback);
    const at = new Date(errorReporterDeps.now()).toISOString();
    const requestIds = scrubRequestIds(input.requestIds);
    const existing = buffer.get(print);
    if (existing) {
      existing.count += 1;
      existing.last_seen_at = at;
      existing.message = scrubMessage(firstLine(input.message), pattern);
      existing.request_ids = [...existing.request_ids.filter((id) => !requestIds.includes(id)), ...requestIds].slice(-10);
      return;
    }
    const clientHeld = input.kind === 'client' ? [...buffer.values()].filter((event) => event.kind === 'client').length : 0;
    if (buffer.size >= BUFFER_MAX_FINGERPRINTS || clientHeld >= BUFFER_MAX_CLIENT_FINGERPRINTS) {
      counters.dropped_buffer_full += 1;
      return;
    }
    buffer.set(print, {
      kind: input.kind,
      fingerprint: print,
      error_class: errorClass,
      message: scrubMessage(firstLine(input.message), pattern),
      frames,
      route,
      method,
      status: scrubStatus(input.status),
      job: input.kind === 'job' ? jobName(input.job) : null,
      request_ids: requestIds,
      first_seen_at: at,
      last_seen_at: at,
      count: 1,
    });
  } catch {
    // Telemetry never gets in the way.
  }
}

function errorParts(error: unknown): { errorClass: string; message: string; stack: string | undefined } {
  if (error instanceof Error) {
    const message = typeof error.message === 'string' ? error.message : '';
    let stack = typeof error.stack === 'string' ? error.stack : undefined;
    // The stack's first lines repeat the message: parse only the frames after it.
    if (stack && message) {
      const at = stack.indexOf(message);
      if (at >= 0) stack = stack.slice(at + message.length);
    }
    return { errorClass: error.name || error.constructor?.name || 'Error', message, stack };
  }
  return { errorClass: 'NonErrorThrown', message: '', stack: undefined };
}

/** An exception thrown while answering a request. */
export function captureRequestError(error: unknown, context: { route: string | null; method: string; status: number; requestId?: string }): void {
  const parts = errorParts(error);
  record({
    kind: 'server',
    ...parts,
    route: context.route,
    method: context.method,
    status: context.status,
    requestIds: context.requestId ? [context.requestId] : [],
  });
}

/** A 5xx response that was not an exception (a route caught its own error). */
export function captureErrorResponse(context: { route: string | null; method: string; status: number }): void {
  record({
    kind: 'server',
    errorClass: `HttpStatus${scrubStatus(context.status) ?? 500}`,
    message: '',
    route: context.route,
    method: context.method,
    status: context.status,
  });
}

/** A background job attempt that failed. */
export function captureJobError(job: string, error: unknown): void {
  record({ kind: 'job', ...errorParts(error), job });
}

/** An uncaught exception or unhandled rejection: the process is about to exit. */
export function captureProcessError(error: unknown): void {
  record({ kind: 'server', ...errorParts(error) });
}

/** A browser error the web app reported to its own cell. Every field is untrusted. */
export function captureClientError(input: {
  errorClass: unknown;
  message: unknown;
  stack: unknown;
  route: string | null;
  method?: unknown;
  status?: unknown;
  requestIds?: unknown;
}): void {
  record({ kind: 'client', ...input });
}

function pause(ms: number): void {
  pausedUntil = errorReporterDeps.now() + Math.min(ms, PAUSE_MAX_MS);
}

/** Re-apply the known-value rule with a fresh list, just before sending. */
function rescrub(event: TelemetryEvent, pattern: KnownValues | null): TelemetryEvent {
  if (!pattern) return event;
  return {
    ...event,
    error_class: scrubErrorClass(event.error_class, pattern),
    message: scrubMessage(event.message, pattern),
    frames: event.frames
      .filter((frame) => !containsKnownValue(frame.file, pattern))
      .map((frame) => ({ ...frame, fn: scrubFunctionName(frame.fn, pattern) })),
  };
}

async function sendOnce(): Promise<void> {
  const destination = target();
  if (!destination) {
    buffer.clear();
    return;
  }
  if (buffer.size === 0 || errorReporterDeps.now() < pausedUntil) return;
  const taken = [...buffer.values()]
    .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at))
    .slice(0, BATCH_MAX_EVENTS);
  for (const event of taken) buffer.delete(event.fingerprint);

  await refreshKnownValues();
  const events = taken.map((event) => rescrub(event, known.pattern));
  const release = await errorReporterDeps.release().catch(() => 'unknown');
  const body = { cell_id: destination.cellId, release, events };
  let serialized = JSON.stringify(body);
  while (Buffer.byteLength(serialized) > BATCH_MAX_BYTES && body.events.length > 0) {
    body.events.pop();
    counters.events_dropped += 1;
    serialized = JSON.stringify(body);
  }
  if (body.events.length === 0) return;

  try {
    const res = await errorReporterDeps.fetch(`${destination.baseUrl}/v1/cells/telemetry/errors`, {
      method: 'POST',
      headers: { authorization: `Bearer ${destination.token}`, 'content-type': 'application/json' },
      body: serialized,
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) {
      counters.batches_sent += 1;
      counters.events_sent += body.events.length;
      consecutiveFailures = 0;
      return;
    }
    counters.batches_failed += 1;
    counters.events_dropped += body.events.length;
    consecutiveFailures += 1;
    if (res.status === 429) pause(PAUSE_AFTER_REFUSAL_MS);
    else pause(FLUSH_INTERVAL_MS * 2 ** Math.min(consecutiveFailures - 1, 5));
  } catch {
    counters.batches_failed += 1;
    counters.events_dropped += body.events.length;
    consecutiveFailures += 1;
    pause(FLUSH_INTERVAL_MS * 2 ** Math.min(consecutiveFailures - 1, 5));
  }
}

/**
 * Send one batch now. The minute timer is the only regular caller, so at
 * most one batch leaves per minute; concurrent calls share one send.
 */
export function flushErrorTelemetry(): Promise<void> {
  if (!inFlight) {
    inFlight = sendOnce().catch(() => undefined).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Before a fatal exit: one last batch, waiting at most `timeoutMs`. */
export async function flushErrorTelemetryBeforeExit(timeoutMs = 2_000): Promise<void> {
  if (buffer.size === 0 && !inFlight) return;
  pausedUntil = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flushErrorTelemetry(),
    new Promise<void>((done) => { timeout = setTimeout(done, timeoutMs); timeout.unref?.(); }),
  ]);
  if (timeout) clearTimeout(timeout);
}

/** Local counters: what was captured, sent and dropped. Numbers only. */
export function errorTelemetryCounters(): TelemetryCounters & { buffered: number } {
  return { ...counters, buffered: buffer.size };
}

/** Test helper: forget everything. */
export function resetErrorTelemetryForTest(): void {
  buffer.clear();
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = null;
  pausedUntil = 0;
  consecutiveFailures = 0;
  known = { pattern: null, loadedAt: -Infinity };
  knownLoading = null;
  cachedTarget = null;
  for (const key of Object.keys(counters) as (keyof TelemetryCounters)[]) counters[key] = 0;
}

/** Test helper: what is waiting to be sent. */
export function bufferedEventsForTest(): TelemetryEvent[] {
  return [...buffer.values()].map((event) => ({ ...event, frames: [...event.frames], request_ids: [...event.request_ids] }));
}

/** Test helper: load the known-value list now. */
export function loadKnownValuesForTest(): Promise<void> {
  return refreshKnownValues(true);
}
