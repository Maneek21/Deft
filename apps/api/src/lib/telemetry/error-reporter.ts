/**
 * Hosted error events (telemetry contract, section 1).
 *
 * What is captured: unhandled request errors, 5xx responses, failed
 * background jobs, uncaught process errors, and browser errors the web app
 * reports to its own cell (routes/telemetry.ts). Each is scrubbed here
 * (scrub.ts) the moment it is captured, and once more just before sending.
 * A message leaves only when the JavaScript engine or the browser wrote it;
 * otherwise an event carries a system or database error code, or no message.
 *
 * Events are aggregated in memory by fingerprint. At most one batch leaves
 * per 60 seconds, the last one before a fatal exit included: at most 50
 * events and 64 KB, to `<control plane>/v1/cells/telemetry/errors`,
 * authenticated like the seat statement fetch. Server and job errors go
 * first; browser reports fill what is left. Sending is fire-and-forget with a
 * short timeout. It never blocks a request or a job, and is never retried: a
 * failed batch is dropped and counted, and failures (or a 429) pause sending.
 *
 * Off unless the cell is hosted and has its control-plane settings
 * (settings.ts); off on a paused start; off with DEFT_TELEMETRY=off.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isPausedStart } from '../paused-start.js';
import { corsAllowedWebOrigins } from '../web-origins.js';
import {
  browserErrorClass,
  eventMessage,
  fingerprint,
  knownValuesPattern,
  parseStack,
  releaseLabel,
  recheckEventMessage,
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

/** The contract's floor between two batches. */
export const MIN_BATCH_GAP_MS = 60_000;
/** The timer runs a little slower than the floor, so timer drift never skips a batch. */
export const FLUSH_INTERVAL_MS = 61_000;
export const BATCH_MAX_EVENTS = 50;
export const BATCH_MAX_BYTES = 64 * 1024;
/** Batch places browser reports may take; the rest are kept for server and job errors. */
export const BATCH_MAX_CLIENT_EVENTS = 25;
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

/** Each part of each name ("Priya Raman" -> "Priya", "Raman"; "acme-robotics" -> "acme", "robotics"). */
export function nameParts(names: readonly string[]): string[] {
  return names.flatMap((name) => name.split(/[\s._-]+/u)).filter((part) => part.length > 0);
}

/**
 * The workspace's own names and its people's and agents' names, removed from
 * every message: whole names, and each part of a name as a whole word.
 */
async function defaultKnownValues(): Promise<{ whole: string[]; parts: string[] }> {
  const [{ db }, { orgs, users, agentEmployees }, { ne }] = await Promise.all([
    import('../db.js'),
    import('@deft/db/schema'),
    import('drizzle-orm'),
  ]);
  const [orgRows, people, agents] = await Promise.all([
    db.select({ name: orgs.name, slug: orgs.slug }).from(orgs).limit(100),
    db.select({ name: users.name }).from(users).where(ne(users.kind, 'system')).limit(20_000),
    // A cloned agent keeps its source's user row: its own name lives here.
    db.select({ name: agentEmployees.name }).from(agentEmployees).limit(20_000),
  ]);
  const whole = [
    ...orgRows.flatMap((row) => [row.name, row.slug, row.slug.replace(/-[a-z0-9]{8}$/, '')]),
    ...people.map((row) => row.name),
    ...agents.map((row) => row.name),
  ];
  return { whole, parts: nameParts(whole) };
}

/** The web app's own addresses: browser frames from anywhere else are dropped. */
function defaultWebOrigins(): string[] {
  const origins: string[] = [];
  for (const value of corsAllowedWebOrigins()) {
    try { origins.push(new URL(value).origin); } catch { /* not an address */ }
  }
  return origins;
}

/** Test seams. */
export const errorReporterDeps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  now: (): number => Date.now(),
  env: process.env as NodeJS.ProcessEnv,
  release: defaultRelease,
  knownValues: defaultKnownValues as () => Promise<{ whole: string[]; parts: string[] }>,
  webOrigins: defaultWebOrigins,
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
let lastSendAt = -Infinity;
let pausedUntil = 0;
let consecutiveFailures = 0;
let known: { pattern: KnownValues | null; loadedAt: number } = { pattern: null, loadedAt: -Infinity };
/** False until the names have loaded once: until then no message leaves (fail closed). */
let knownLoadedOnce = false;
/** Set on a fatal exit: the last batch does not wait on the database. */
let exiting = false;
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
  try {
    return target() !== null;
  } catch {
    return false;
  }
}

function refreshKnownValues(force = false): Promise<void> {
  const now = errorReporterDeps.now();
  if (!force && now - known.loadedAt < KNOWN_VALUES_TTL_MS) return Promise.resolve();
  if (knownLoading) return knownLoading;
  knownLoading = (async () => {
    try {
      const values = await errorReporterDeps.knownValues();
      known = { pattern: knownValuesPattern(values.whole, values.parts), loadedAt: errorReporterDeps.now() };
      knownLoadedOnce = true;
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

type ErrorParts = { errorClass: unknown; message: unknown; stack: unknown; code: unknown };

/** What an event may use of a thrown value. Never throws: a hostile getter yields nothing. */
function errorParts(error: unknown): ErrorParts {
  const parts: ErrorParts = { errorClass: 'NonErrorThrown', message: '', stack: undefined, code: undefined };
  try {
    if (!(error instanceof Error)) return parts;
    const message = typeof error.message === 'string' ? error.message : '';
    let stack = typeof error.stack === 'string' ? error.stack : undefined;
    // The stack's first lines repeat the message: parse only the frames after it.
    if (stack && message) {
      const at = stack.indexOf(message);
      if (at >= 0) stack = stack.slice(at + message.length);
    }
    const own = (error as { code?: unknown }).code;
    const cause = (error as { cause?: unknown }).cause;
    const causeCode = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    return { errorClass: error.name || error.constructor?.name || 'Error', message, stack, code: typeof own === 'string' ? own : causeCode };
  } catch {
    return parts;
  }
}

type CaptureInput = ErrorParts & {
  kind: TelemetryKind;
  route?: unknown;
  method?: unknown;
  status?: unknown;
  job?: unknown;
  requestIds?: unknown;
};

function jobName(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-z0-9][a-z0-9:_.-]{0,79}$/i.test(raw) ? raw : null;
}

function countKind(kind: TelemetryKind): number {
  let n = 0;
  for (const event of buffer.values()) if (event.kind === kind) n += 1;
  return n;
}

function record(input: CaptureInput): void {
  ensureTimer();
  counters.captured += 1;
  const pattern = known.pattern;
  const browser = input.kind === 'client';
  const errorClass = browser ? browserErrorClass(input.errorClass) : scrubErrorClass(input.errorClass, pattern);
  const message = eventMessage({ message: input.message, code: input.code }, pattern);
  const frames = parseStack(input.stack, browser ? { webOrigins: errorReporterDeps.webOrigins() } : { appRoot: APP_ROOT }, pattern);
  const route = scrubRouteTemplate(input.route);
  const method = scrubMethod(input.method);
  const fallback = input.kind === 'job' ? `job:${jobName(input.job) ?? ''}` : `${method ?? ''} ${route ?? ''}`;
  const print = fingerprint(input.kind, errorClass, frames, fallback);
  const at = new Date(errorReporterDeps.now()).toISOString();
  const requestIds = scrubRequestIds(input.requestIds, errorReporterDeps.now());
  const existing = buffer.get(print);
  if (existing) {
    existing.count += 1;
    existing.last_seen_at = at;
    existing.message = message;
    existing.request_ids = [...existing.request_ids.filter((id) => !requestIds.includes(id)), ...requestIds].slice(-10);
    return;
  }
  if (buffer.size >= BUFFER_MAX_FINGERPRINTS || (browser && countKind('client') >= BUFFER_MAX_CLIENT_FINGERPRINTS)) {
    counters.dropped_buffer_full += 1;
    return;
  }
  buffer.set(print, {
    kind: input.kind,
    fingerprint: print,
    error_class: errorClass,
    message,
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
}

/** Every capture: off unless enabled, and nothing it meets can make it throw. */
function capture(build: () => CaptureInput): void {
  try {
    if (!target()) return;
    record(build());
  } catch {
    // Telemetry never gets in the way.
  }
}

/** An exception thrown while answering a request. */
export function captureRequestError(error: unknown, context: { route: string | null; method: string; status: number; requestId?: string }): void {
  capture(() => ({
    kind: 'server',
    ...errorParts(error),
    route: context.route,
    method: context.method,
    status: context.status,
    requestIds: context.requestId ? [context.requestId] : [],
  }));
}

/** A 5xx response that was not an exception (a route caught its own error). */
export function captureErrorResponse(context: { route: string | null; method: string; status: number }): void {
  capture(() => ({
    kind: 'server',
    errorClass: `HttpStatus${scrubStatus(context.status) ?? 500}`,
    message: '',
    stack: undefined,
    code: undefined,
    route: context.route,
    method: context.method,
    status: context.status,
  }));
}

/** A background job attempt that failed. */
export function captureJobError(job: string, error: unknown): void {
  capture(() => ({ kind: 'job', ...errorParts(error), job }));
}

/** An uncaught exception or unhandled rejection: the process is about to exit. */
export function captureProcessError(error: unknown): void {
  capture(() => ({ kind: 'server', ...errorParts(error) }));
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
  capture(() => ({ kind: 'client', code: undefined, ...input }));
}

function pause(ms: number): void {
  pausedUntil = errorReporterDeps.now() + Math.min(ms, PAUSE_MAX_MS);
}

/**
 * Re-apply the known-value rule with a fresh list, just before sending. Until
 * the names have loaded once, no message leaves at all. A message is fixed
 * text or a code (scrub.ts eventMessage), so it is never re-scrubbed: that
 * would only mangle a long code ("code ERR_STREAM_PREMATURE_CLOSE").
 */
function rescrub(event: TelemetryEvent, pattern: KnownValues | null): TelemetryEvent {
  if (!knownLoadedOnce) return { ...event, message: '' };
  if (!pattern) return event;
  return {
    ...event,
    error_class: event.kind === 'client' ? event.error_class : scrubErrorClass(event.error_class, pattern),
    message: recheckEventMessage(event.message, pattern),
    frames: event.frames.map((frame) => ({ ...frame, fn: event.kind === 'client' ? frame.fn : scrubFunctionName(frame.fn, pattern) })),
  };
}

/**
 * This batch: server and job errors first, then browser reports (at most
 * 25), oldest first within each, up to 50 events and 64 KB. What does not
 * fit stays for the next batch.
 */
function selectBatch(header: { cell_id: string; release: string }, pattern: KnownValues | null): TelemetryEvent[] {
  const byAge = (a: TelemetryEvent, b: TelemetryEvent) => a.first_seen_at.localeCompare(b.first_seen_at);
  const ordered = [
    ...[...buffer.values()].filter((event) => event.kind !== 'client').sort(byAge),
    ...[...buffer.values()].filter((event) => event.kind === 'client').sort(byAge),
  ];
  const chosen: TelemetryEvent[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ ...header, events: [] }));
  let clients = 0;
  for (const event of ordered) {
    if (chosen.length >= BATCH_MAX_EVENTS) break;
    if (event.kind === 'client' && clients >= BATCH_MAX_CLIENT_EVENTS) continue;
    const ready = rescrub(event, pattern);
    const size = Buffer.byteLength(JSON.stringify(ready)) + 1;
    if (bytes + size > BATCH_MAX_BYTES) continue;
    bytes += size;
    if (event.kind === 'client') clients += 1;
    chosen.push(ready);
    buffer.delete(event.fingerprint);
  }
  return chosen;
}

async function sendOnce(): Promise<void> {
  const destination = target();
  if (!destination) {
    buffer.clear();
    return;
  }
  const now = errorReporterDeps.now();
  // At most one batch per 60 seconds, whoever asks (the timer or a fatal exit).
  if (buffer.size === 0 || now < pausedUntil || now - lastSendAt < MIN_BATCH_GAP_MS) return;

  // On a fatal exit the database may be why: send with what is already known.
  if (!exiting) await refreshKnownValues();
  const header = { cell_id: destination.cellId, release: releaseLabel(await errorReporterDeps.release().catch(() => 'unknown')) };
  const events = selectBatch(header, known.pattern);
  if (events.length === 0) return;
  const body = JSON.stringify({ ...header, events });

  // The floor counts from the moment a batch goes, not from when preparing it began
  // (a slow names query must not let the next batch follow seconds behind).
  if (errorReporterDeps.now() - lastSendAt < MIN_BATCH_GAP_MS) {
    for (const event of events) if (buffer.size < BUFFER_MAX_FINGERPRINTS) buffer.set(event.fingerprint, event);
    return;
  }
  lastSendAt = errorReporterDeps.now();
  try {
    const res = await errorReporterDeps.fetch(`${destination.baseUrl}/v1/cells/telemetry/errors`, {
      method: 'POST',
      headers: { authorization: `Bearer ${destination.token}`, 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) {
      counters.batches_sent += 1;
      counters.events_sent += events.length;
      consecutiveFailures = 0;
      return;
    }
    counters.batches_failed += 1;
    counters.events_dropped += events.length;
    consecutiveFailures += 1;
    if (res.status === 429) pause(PAUSE_AFTER_REFUSAL_MS);
    else pause(MIN_BATCH_GAP_MS * 2 ** Math.min(consecutiveFailures - 1, 5));
  } catch {
    counters.batches_failed += 1;
    counters.events_dropped += events.length;
    consecutiveFailures += 1;
    pause(MIN_BATCH_GAP_MS * 2 ** Math.min(consecutiveFailures - 1, 5));
  }
}

/**
 * Send one batch now, if 60 seconds have passed since the last one and no
 * pause is on. The minute timer is the regular caller; concurrent calls
 * share one send.
 */
export function flushErrorTelemetry(): Promise<void> {
  if (!inFlight) {
    inFlight = sendOnce().catch(() => undefined).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * Before a fatal exit: one last batch, under the same 60-second floor and
 * pauses as any other, waiting at most `timeoutMs`.
 */
export async function flushErrorTelemetryBeforeExit(timeoutMs = 2_000): Promise<void> {
  exiting = true;
  if (buffer.size === 0 && !inFlight) return;
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
  lastSendAt = -Infinity;
  pausedUntil = 0;
  consecutiveFailures = 0;
  known = { pattern: null, loadedAt: -Infinity };
  knownLoading = null;
  knownLoadedOnce = false;
  exiting = false;
  cachedTarget = null;
  for (const key of Object.keys(counters) as (keyof TelemetryCounters)[]) counters[key] = 0;
}

/** Test helper: allow the next flush now, as if a minute had passed. */
export function allowNextBatchForTest(): void {
  lastSendAt = -Infinity;
}

/** Test helper: what is waiting to be sent. */
export function bufferedEventsForTest(): TelemetryEvent[] {
  return [...buffer.values()].map((event) => ({ ...event, frames: [...event.frames], request_ids: [...event.request_ids] }));
}

/** Test helper: load the known-value list now. */
export function loadKnownValuesForTest(): Promise<void> {
  return refreshKnownValues(true);
}
