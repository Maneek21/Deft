/**
 * Per-workspace limits on a hosted cell (launch check 6.6). A hosted cell is
 * one workspace served by one API process, so a count kept here is that
 * workspace's count. Self-hosted installs have no limits: every function here
 * does nothing unless DEFT_HOSTED is exactly "true".
 *
 * - Disk: a file write is refused once the files would use more than
 *   DEFT_HOSTED_LIMIT_STORAGE_PERCENT of the volume (default 90), or leave
 *   less than DEFT_HOSTED_LIMIT_STORAGE_FREE_MB free (default 200). The limit
 *   follows the volume's real size. Writes still in progress count (a
 *   reservation held until each write settles), so uploads arriving together
 *   cannot pass it between them. A volume that cannot be measured refuses the
 *   write. On a hosted cell a write the disk refuses (ENOSPC) is removed and
 *   gets the same message.
 * - Outgoing requests: the requests Deft makes to addresses people give it
 *   (link previews, calendar feeds), each hop of a redirect counted, at most
 *   DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE (60) a minute and
 *   DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR (1,000) an hour. Past that, a preview
 *   is skipped and a feed sync waits; owners and admins get one notice an hour.
 * - Scheduled items: at most DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES (500)
 *   scheduled messages and DEFT_HOSTED_LIMIT_REMINDERS (2,000) reminders
 *   waiting at once.
 *
 * Each setting is hosted-only (hosted-settings.ts) and strict: anything but a
 * whole number in range stops startup (validateWorkspaceLimitEnvironment).
 * It never opens a database connection itself.
 */
import { statfs } from 'node:fs/promises';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { reminders, scheduledMessages } from '@deft/db/schema';
import { isHostedMode } from './hosted-mode.js';

const SETTINGS = [
  { key: 'outgoingPerMinute', name: 'DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE', fallback: 60, min: 1, max: 10_000 },
  { key: 'outgoingPerHour', name: 'DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR', fallback: 1_000, min: 1, max: 100_000 },
  { key: 'scheduledMessages', name: 'DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES', fallback: 500, min: 1, max: 1_000_000 },
  { key: 'reminders', name: 'DEFT_HOSTED_LIMIT_REMINDERS', fallback: 2_000, min: 1, max: 1_000_000 },
  { key: 'storagePercent', name: 'DEFT_HOSTED_LIMIT_STORAGE_PERCENT', fallback: 90, min: 1, max: 99 },
  { key: 'storageFreeMb', name: 'DEFT_HOSTED_LIMIT_STORAGE_FREE_MB', fallback: 200, min: 1, max: 1_000_000 },
] as const;

export type WorkspaceLimits = { readonly [K in (typeof SETTINGS)[number]['key']]: number };

/** The settings' names, for the hosted-only list. */
export const WORKSPACE_LIMIT_SETTING_NAMES: readonly string[] = SETTINGS.map((setting) => setting.name);

/** The launch defaults (the orchestrator's, for the owner to review). */
export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = Object.freeze(
  Object.fromEntries(SETTINGS.map((setting) => [setting.key, setting.fallback])) as WorkspaceLimits,
);

/** The limits from the environment, or what is wrong with them. Problems name settings, never values. */
export function parseWorkspaceLimits(
  source: NodeJS.ProcessEnv = process.env,
): { ok: true; limits: WorkspaceLimits } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const limits: Record<string, number> = {};
  for (const setting of SETTINGS) {
    const raw = source[setting.name];
    if (raw === undefined) {
      limits[setting.key] = setting.fallback;
      continue;
    }
    const value = /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max) {
      problems.push(`${setting.name} must be a whole number from ${setting.min} to ${setting.max}`);
      continue;
    }
    limits[setting.key] = value;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, limits: limits as WorkspaceLimits };
}

/** Startup check, called from env.ts with isHostedMode(). */
export function validateWorkspaceLimitEnvironment(hostedMode: boolean, source: NodeJS.ProcessEnv = process.env): void {
  if (!hostedMode) return;
  const parsed = parseWorkspaceLimits(source);
  if (!parsed.ok) throw new Error(`Hosted workspace limits are invalid: ${parsed.problems.join('; ')}.`);
}

let current: WorkspaceLimits | null | undefined;

/** This cell's limits, read once; null on a self-hosted install. */
export function workspaceLimits(): WorkspaceLimits | null {
  if (current === undefined) {
    const parsed = isHostedMode() ? parseWorkspaceLimits() : null;
    current = parsed === null ? null : parsed.ok ? parsed.limits : DEFAULT_WORKSPACE_LIMITS;
  }
  return current;
}

/** A request refused at a workspace limit; routes answer it with `status` and `{ error: message, code }`. */
export class WorkspaceLimitError extends Error {
  constructor(
    readonly code: 'WORKSPACE_STORAGE_FULL' | 'WORKSPACE_STORAGE_UNAVAILABLE' | 'WORKSPACE_OUTGOING_LIMIT' | 'WORKSPACE_SCHEDULE_LIMIT',
    readonly status: 409 | 413 | 429 | 503,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'WorkspaceLimitError';
  }
}

/** The JSON body and status a route answers a WorkspaceLimitError with; sets Retry-After when the refusal has one. */
export function limitResponse(c: { json: (body: unknown, status: 409 | 413 | 429 | 503) => Response; header: (name: string, value: string) => void }, error: WorkspaceLimitError): Response {
  if (error.retryAfterSeconds !== null) c.header('Retry-After', String(error.retryAfterSeconds));
  return c.json({ error: error.message, code: error.code }, error.status);
}

const number = (value: number): string => value.toLocaleString('en-US');

// ---- the operator's log and the admins' notice ------------------------------------------------

type LimitKind = 'storage' | 'outgoing_requests' | 'scheduled_messages' | 'reminders';
type Notice = { title: string; body: string };
const LOG_EVERY_MS = 60_000;
const NOTICE_EVERY_MS = 60 * 60_000;
const lastLogAt = new Map<LimitKind, number>();
const lastNoticeAt = new Map<LimitKind, number>();

const realNotifier = (kind: LimitKind, notice: Notice): Promise<void> =>
  // Loaded only when needed: this module must not open the database on import.
  import('./workspace-limit-notice.js').then((module) => module.noticeWorkspaceAdmins(kind, notice));
let notifier: (kind: LimitKind, notice: Notice) => Promise<void> = realNotifier;

/** One log line a minute per limit, and one notice an hour to the workspace's owners and admins. Never throws. */
function reached(kind: LimitKind, notice: Notice | null, now: number): void {
  if (now - (lastLogAt.get(kind) ?? -Infinity) >= LOG_EVERY_MS) {
    lastLogAt.set(kind, now);
    console.warn(`[workspace-limit] workspace_limit_reached kind=${kind}`);
  }
  if (notice === null || now - (lastNoticeAt.get(kind) ?? -Infinity) < NOTICE_EVERY_MS) return;
  lastNoticeAt.set(kind, now);
  void notifier(kind, notice).catch(() => console.warn('[workspace-limit] admin notice failed'));
}

/** Test seam only: the limits to apply (null: none; undefined: read again), a recording notifier, and fresh counts. */
export function _setWorkspaceLimitsForTest(limits: WorkspaceLimits | null | undefined, notify?: (kind: string, notice: Notice) => void): void {
  current = limits;
  notifier = notify === undefined ? realNotifier : async (kind, notice) => notify(kind, notice);
  outgoing.length = 0;
  outgoingHead = 0;
  reservedBytes = 0;
  lastNoticeAt.clear();
  lastLogAt.clear();
}

// ---- outgoing requests -------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** When each request of the last hour was let through, oldest first, from `outgoingHead` on. */
const outgoing: number[] = [];
let outgoingHead = 0;

/**
 * Refuse with a WorkspaceLimitError when the workspace is at its minute or
 * hour limit of outside requests; otherwise count one request, unless `peek`
 * (a look before a lookup, which sends nothing). A refused request is not
 * counted. Call it right before each request to an address a person supplied.
 */
export function takeOutgoingRequest(now = Date.now(), options: { readonly peek?: boolean } = {}): void {
  const limits = workspaceLimits();
  if (limits === null) return;
  while (outgoingHead < outgoing.length && (outgoing[outgoingHead] ?? 0) <= now - HOUR) outgoingHead += 1;
  if (outgoingHead > 1024 && outgoingHead * 2 > outgoing.length) {
    outgoing.splice(0, outgoingHead);
    outgoingHead = 0;
  }
  const inHour = outgoing.length - outgoingHead;
  let inMinute = 0;
  for (let i = outgoing.length - 1; i >= outgoingHead && (outgoing[i] ?? 0) > now - MINUTE; i -= 1) inMinute += 1;
  const minuteFull = inMinute >= limits.outgoingPerMinute;
  const hourFull = inHour >= limits.outgoingPerHour;
  if (minuteFull || hourFull) {
    // The window that frees a place last decides when to try again.
    const minuteFrees = minuteFull ? (outgoing[outgoing.length - inMinute] ?? now) + MINUTE : now;
    const hourFrees = hourFull ? (outgoing[outgoingHead] ?? now) + HOUR : now;
    const retryAfterSeconds = Math.max(1, Math.ceil((Math.max(minuteFrees, hourFrees) - now) / 1000));
    const byHour = hourFull && hourFrees >= minuteFrees;
    reached('outgoing_requests', {
      title: 'Link previews and calendar feeds paused for a moment',
      body: `This workspace reached its limit of ${byHour ? `${number(limits.outgoingPerHour)} outside requests an hour` : `${number(limits.outgoingPerMinute)} outside requests a minute`}. ` +
        'Link previews are skipped and calendar feeds sync later until it is under the limit again. Chat and everything else work as usual.',
    }, now);
    throw new WorkspaceLimitError(
      'WORKSPACE_OUTGOING_LIMIT',
      429,
      byHour
        ? `This workspace has made ${number(limits.outgoingPerHour)} outside requests in the last hour, its limit. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes.`
        : `This workspace has made ${number(limits.outgoingPerMinute)} outside requests in the last minute, its limit. Try again in a minute.`,
      retryAfterSeconds,
    );
  }
  if (options.peek !== true) outgoing.push(now);
}

// ---- disk ---------------------------------------------------------------------------------------

type VolumeStats = { bsize: number; blocks: number; bfree: number; bavail: number };
let readVolume: (dir: string) => Promise<VolumeStats> = (dir) => statfs(dir);
/** Bytes of writes let through and not yet settled (one process per cell: this is the workspace's). */
let reservedBytes = 0;

/** Test seam only: what the volume reports (null: the real `statfs`). */
export function _setVolumeStatsForTest(read: ((dir: string) => Promise<VolumeStats>) | null): void {
  readVolume = read ?? ((dir) => statfs(dir));
}

/** Whether an error is the disk refusing a write (full, or over a quota). */
export function isDiskFullError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return value >= 10 ? `${Math.round(value)} GB` : `${Math.round(value * 10) / 10} GB`;
}

/** The refusal people see when the workspace's file storage is full. `capacityBytes` null: the size is not known. */
export function storageFullError(capacityBytes: number | null): WorkspaceLimitError {
  const size = capacityBytes !== null && capacityBytes > 0 ? ` (${gigabytes(capacityBytes)})` : '';
  return new WorkspaceLimitError(
    'WORKSPACE_STORAGE_FULL',
    413,
    `This workspace has used its file storage${size}, so this file was not saved. Ask the workspace owner about more space. Everything else works as usual.`,
  );
}

/** Whether a disk-full error from a write is to be answered as the workspace's storage limit (hosted cells only). */
export function storageLimitApplies(): boolean {
  return workspaceLimits() !== null;
}

/**
 * Reserve room for a write of `incomingBytes` into `dir`, or refuse it when it
 * would take the volume past the hosted storage limit (or the volume cannot be
 * measured). Returns the release to call once the write has settled, whatever
 * its outcome. On a self-hosted install: nothing is checked or reserved.
 */
export async function reserveStorage(dir: string, incomingBytes: number, now = Date.now()): Promise<() => void> {
  const limits = workspaceLimits();
  if (limits === null) return () => undefined;
  let stats: VolumeStats;
  try {
    stats = await readVolume(dir);
  } catch {
    console.warn('[workspace-limit] the file storage could not be measured');
    throw new WorkspaceLimitError('WORKSPACE_STORAGE_UNAVAILABLE', 503, 'The file could not be saved because the file storage could not be checked. Try again in a moment.', 30);
  }
  // As `df` counts it: what is used, and what the volume can hold for Deft (root's reserve left out). A write takes whole blocks.
  const bsize = Math.max(1, stats.bsize);
  const incoming = Math.ceil(Math.max(0, incomingBytes) / bsize) * bsize;
  const used = (stats.blocks - stats.bfree) * bsize + reservedBytes;
  const capacity = (stats.blocks - stats.bfree + stats.bavail) * bsize;
  const free = stats.bavail * bsize - reservedBytes;
  if (capacity <= 0 || used + incoming > capacity * (limits.storagePercent / 100) || free - incoming < limits.storageFreeMb * 1024 * 1024) {
    reached('storage', {
      title: 'File storage is full',
      body: `This workspace's file storage (${gigabytes(capacity)}) is full, so new files are refused. Ask the workspace owner about more space. Everything else works as usual.`,
    }, now);
    throw storageFullError(capacity);
  }
  reservedBytes += incoming;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedBytes = Math.max(0, reservedBytes - incoming);
  };
}

// ---- scheduled items ----------------------------------------------------------------------------

/** A transaction (or the database) that can run one statement. */
export type LimitExecutor = { execute(query: SQL): Promise<unknown> };

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * Refuse a new scheduled message or reminder when the workspace already has
 * its limit of them waiting. Call inside the transaction that inserts it: the
 * check is serialised per workspace (an advisory lock held to commit), so two
 * requests cannot both take the last place.
 */
export async function assertScheduleRoom(tx: LimitExecutor, orgId: string, kind: 'scheduled_messages' | 'reminders', now = Date.now()): Promise<void> {
  const limits = workspaceLimits();
  if (limits === null) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`deft:workspace-limit:${kind}:${orgId}`}, 0))`);
  const waiting = kind === 'scheduled_messages'
    ? sql`SELECT count(*)::int AS n FROM ${scheduledMessages} WHERE ${and(eq(scheduledMessages.org_id, orgId), inArray(scheduledMessages.status, ['pending', 'sending']))}`
    : sql`SELECT count(*)::int AS n FROM ${reminders} WHERE ${and(eq(reminders.org_id, orgId), eq(reminders.is_sent, false))}`;
  const count = Number(rowsOf(await tx.execute(waiting))[0]?.n ?? 0);
  const limit = kind === 'scheduled_messages' ? limits.scheduledMessages : limits.reminders;
  if (count < limit) return;
  reached(kind, null, now);
  throw new WorkspaceLimitError(
    'WORKSPACE_SCHEDULE_LIMIT',
    409,
    kind === 'scheduled_messages'
      ? `This workspace already has ${number(limit)} scheduled messages waiting to be sent, its limit. More can be scheduled once some have been sent or cancelled.`
      : `This workspace already has ${number(limit)} reminders waiting, its limit. More can be set once some have gone off or been removed.`,
  );
}
