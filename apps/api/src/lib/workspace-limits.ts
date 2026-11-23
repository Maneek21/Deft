/**
 * Per-workspace limits on a hosted cell (launch check 6.6). A hosted cell is
 * one workspace served by one API process, so a count kept here is that
 * workspace's count. Self-hosted installs have no limits: every function here
 * does nothing unless DEFT_HOSTED is exactly "true".
 *
 * - Disk: an upload is refused once files would use more than
 *   DEFT_HOSTED_LIMIT_STORAGE_PERCENT of the uploads volume (default 90), or
 *   leave less than 200 MB free. The limit follows the volume's real size, so
 *   a larger volume needs no new number. A write the disk refuses (ENOSPC) is
 *   removed and gets the same message, hosted or not.
 * - Outgoing requests: the addresses people make Deft fetch (link previews,
 *   calendar feeds) at most DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE (60) a
 *   minute and DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR (1,000) an hour. Past
 *   that, a preview is skipped and a feed sync waits for its next turn; the
 *   workspace's owners and admins get one notice an hour.
 * - Scheduled items: at most DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES (500)
 *   scheduled messages and DEFT_HOSTED_LIMIT_REMINDERS (2,000) reminders
 *   waiting at once.
 *
 * Each setting is hosted-only (hosted-settings.ts) and strict: anything but a
 * whole number in range stops startup (validateWorkspaceLimitEnvironment).
 * Pure apart from the file-system and database calls named below; it never
 * opens a database connection itself.
 */
import { statfs } from 'node:fs/promises';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { reminders, scheduledMessages } from '@deft/db/schema';
import { isHostedMode } from './hosted-mode.js';

const SETTINGS = [
  { key: 'outgoingPerMinute', name: 'DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE', fallback: 60, min: 1, max: 100_000 },
  { key: 'outgoingPerHour', name: 'DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR', fallback: 1_000, min: 1, max: 1_000_000 },
  { key: 'scheduledMessages', name: 'DEFT_HOSTED_LIMIT_SCHEDULED_MESSAGES', fallback: 500, min: 1, max: 1_000_000 },
  { key: 'reminders', name: 'DEFT_HOSTED_LIMIT_REMINDERS', fallback: 2_000, min: 1, max: 1_000_000 },
  { key: 'storagePercent', name: 'DEFT_HOSTED_LIMIT_STORAGE_PERCENT', fallback: 90, min: 1, max: 99 },
] as const;

export type WorkspaceLimits = { readonly [K in (typeof SETTINGS)[number]['key']]: number };

/** The settings' names, for the hosted-only list. */
export const WORKSPACE_LIMIT_SETTING_NAMES: readonly string[] = SETTINGS.map((setting) => setting.name);

/** The launch defaults (the orchestrator's, for the owner to review). */
export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = Object.freeze(
  Object.fromEntries(SETTINGS.map((setting) => [setting.key, setting.fallback])) as WorkspaceLimits,
);

/** Below this much free space an upload is refused whatever the percentage. */
export const STORAGE_FREE_FLOOR_BYTES = 200 * 1024 * 1024;

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
  if (problems.length === 0 && (limits.outgoingPerHour ?? 0) < (limits.outgoingPerMinute ?? 0)) {
    problems.push('DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR must be at least DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE');
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

/** Test seam only: the limits to apply (null: none), and a fresh outgoing count. */
export function _setWorkspaceLimitsForTest(limits: WorkspaceLimits | null | undefined): void {
  current = limits;
  outgoing.length = 0;
  lastNoticeAt.clear();
  lastLogAt.clear();
}

/** A request refused at a workspace limit; routes answer it with `status` and `{ error: message, code }`. */
export class WorkspaceLimitError extends Error {
  constructor(
    readonly code: 'WORKSPACE_STORAGE_FULL' | 'WORKSPACE_OUTGOING_LIMIT' | 'WORKSPACE_SCHEDULE_LIMIT',
    readonly status: 409 | 413 | 429,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'WorkspaceLimitError';
  }
}

const number = (value: number): string => value.toLocaleString('en-US');

// ---- the operator's log and the admins' notice ------------------------------------------------

type LimitKind = 'storage' | 'outgoing_requests' | 'scheduled_messages' | 'reminders';
const LOG_EVERY_MS = 60_000;
const NOTICE_EVERY_MS = 60 * 60_000;
const lastLogAt = new Map<LimitKind, number>();
const lastNoticeAt = new Map<LimitKind, number>();

/** One log line a minute per limit, and one notice an hour to the workspace's owners and admins. Never throws. */
function reached(kind: LimitKind, notice: { title: string; body: string } | null, now: number): void {
  if (now - (lastLogAt.get(kind) ?? -Infinity) >= LOG_EVERY_MS) {
    lastLogAt.set(kind, now);
    console.warn(`[workspace-limit] workspace_limit_reached kind=${kind}`);
  }
  if (notice === null || now - (lastNoticeAt.get(kind) ?? -Infinity) < NOTICE_EVERY_MS) return;
  lastNoticeAt.set(kind, now);
  // Loaded only when needed: this module must not open the database on import.
  void import('./workspace-limit-notice.js')
    .then((module) => module.noticeWorkspaceAdmins(kind, notice))
    .catch(() => console.warn('[workspace-limit] admin notice failed'));
}

// ---- outgoing requests -------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** When each fetch of the last hour was let through, oldest first. */
const outgoing: number[] = [];

/**
 * Count one fetch of an address a person supplied (a link preview, a calendar
 * feed), or refuse it with a WorkspaceLimitError when the workspace is at its
 * minute or hour limit. A refused fetch is not counted.
 */
export function takeOutgoingRequest(now = Date.now()): void {
  const limits = workspaceLimits();
  if (limits === null) return;
  while (outgoing.length > 0 && (outgoing[0] ?? 0) <= now - HOUR) outgoing.shift();
  let inMinute = 0;
  for (let i = outgoing.length - 1; i >= 0 && (outgoing[i] ?? 0) > now - MINUTE; i -= 1) inMinute += 1;
  if (inMinute >= limits.outgoingPerMinute || outgoing.length >= limits.outgoingPerHour) {
    const perMinute = inMinute >= limits.outgoingPerMinute;
    const frees = perMinute ? (outgoing[outgoing.length - inMinute] ?? now) + MINUTE : (outgoing[0] ?? now) + HOUR;
    const retryAfterSeconds = Math.max(1, Math.ceil((frees - now) / 1000));
    reached('outgoing_requests', {
      title: 'Link previews and calendar feeds paused for a moment',
      body: `This workspace reached its limit of ${perMinute ? `${number(limits.outgoingPerMinute)} outside requests a minute` : `${number(limits.outgoingPerHour)} outside requests an hour`}. ` +
        'Link previews are skipped and calendar feeds sync later until it is under the limit again. Chat and everything else work as usual.',
    }, now);
    throw new WorkspaceLimitError(
      'WORKSPACE_OUTGOING_LIMIT',
      429,
      perMinute
        ? `This workspace has made ${number(limits.outgoingPerMinute)} outside requests in the last minute, its limit. Try again in a minute.`
        : `This workspace has made ${number(limits.outgoingPerHour)} outside requests in the last hour, its limit. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minutes.`,
      retryAfterSeconds,
    );
  }
  outgoing.push(now);
}

// ---- disk ---------------------------------------------------------------------------------------

type VolumeStats = { bsize: number; blocks: number; bfree: number; bavail: number };
let readVolume: (dir: string) => Promise<VolumeStats> = (dir) => statfs(dir);

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
    `This workspace has used its file storage${size}. Delete files you no longer need, or ask the workspace owner about more space. Nothing else is affected.`,
  );
}

/**
 * Refuse a write of `incomingBytes` into `dir` when it would take the volume
 * past the hosted storage limit. Does nothing on a self-hosted install, or when
 * the volume cannot be read (the write itself then decides).
 */
export async function assertStorageRoom(dir: string, incomingBytes: number, now = Date.now()): Promise<void> {
  const limits = workspaceLimits();
  if (limits === null) return;
  let stats: VolumeStats;
  try {
    stats = await readVolume(dir);
  } catch {
    return;
  }
  // As `df` counts it: what is used, and what the volume can hold for Deft (root's reserve left out).
  const used = (stats.blocks - stats.bfree) * stats.bsize;
  const capacity = used + stats.bavail * stats.bsize;
  const free = stats.bavail * stats.bsize;
  if (capacity <= 0) return;
  if (used + incomingBytes > capacity * (limits.storagePercent / 100) || free - incomingBytes < STORAGE_FREE_FLOOR_BYTES) {
    reached('storage', {
      title: 'File storage is full',
      body: `This workspace has used ${limits.storagePercent}% of its file storage (${gigabytes(capacity)}). New uploads are refused until files are deleted. Everything else works as usual.`,
    }, now);
    throw storageFullError(capacity);
  }
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
      ? `This workspace already has ${number(limit)} scheduled messages waiting to be sent, its limit. Send or cancel some before scheduling more.`
      : `This workspace already has ${number(limit)} reminders waiting, its limit. Remove some before adding more.`,
  );
}
