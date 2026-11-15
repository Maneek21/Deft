import { sql } from 'drizzle-orm';
import { db } from './db.js';

/**
 * The database version actually applied, read from the upgrade ledger
 * (`deft_schema_migrations`, written by packages/db/scripts/upgrade.ts), so
 * a half-upgraded install is visible on /health beside the release's
 * expected `schema_head`.
 *
 * /health must stay cheap and must not fail when the database is down: the
 * value is cached, a read is bounded by a short timeout, and any failure
 * reports null (the ledger missing also reports null).
 */
export type LedgerRow = { version: string; applied_at: Date | string | null };
export type LedgerReader = () => Promise<LedgerRow[] | null>;

const CACHE_MS = 30_000;
const FAILURE_CACHE_MS = 5_000;
const READ_TIMEOUT_MS = 1_000;

function parseVersion(version: string): { core: number[]; pre: number[] | null } {
  const [core, pre] = version.split('-', 2) as [string, string | undefined];
  const numbers = (part: string) => (part.match(/\d+/g) ?? []).map(Number);
  return { core: numbers(core), pre: pre === undefined ? null : numbers(pre) };
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Release order, numeric per segment (preview.37 < preview.137); a release follows its previews. */
export function compareSchemaVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const core = compareNumbers(x.core, y.core);
  if (core !== 0) return core;
  if (x.pre === null || y.pre === null) return (x.pre === null ? 1 : 0) - (y.pre === null ? 1 : 0);
  return compareNumbers(x.pre, y.pre);
}

/**
 * The newest ledger row. A fresh install records the whole manifest in one
 * transaction, so applied_at can tie: ties are broken by release order.
 */
export function newestLedgerVersion(rows: readonly LedgerRow[]): string | null {
  let best: { version: string; at: number } | null = null;
  for (const row of rows) {
    const at = row.applied_at === null ? 0 : new Date(row.applied_at).getTime() || 0;
    if (!best || at > best.at || (at === best.at && compareSchemaVersions(row.version, best.version) > 0)) {
      best = { version: row.version, at };
    }
  }
  return best?.version ?? null;
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

/** Null when the ledger table does not exist. */
export const readLedgerFromDatabase: LedgerReader = async () => {
  const exists = resultRows(await db.execute(sql`
    SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS exists
  `))[0]?.exists === true;
  if (!exists) return null;
  return resultRows(await db.execute(sql`SELECT version, applied_at FROM deft_schema_migrations`))
    .map((row) => ({ version: String(row.version), applied_at: row.applied_at as Date | string | null }));
};

export function createSchemaAppliedCache(read: LedgerReader, now: () => number = Date.now) {
  let cached: { value: string | null; until: number } | null = null;
  let inFlight: Promise<string | null> | null = null;

  const refresh = (): Promise<string | null> => {
    inFlight ??= read()
      .then((rows) => {
        const value = rows ? newestLedgerVersion(rows) : null;
        cached = { value, until: now() + CACHE_MS };
        return value;
      }, () => {
        cached = { value: null, until: now() + FAILURE_CACHE_MS };
        return null;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return async function getSchemaApplied(): Promise<string | null> {
    if (cached && now() < cached.until) return cached.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); timer.unref?.(); });
    try {
      return await Promise.race([refresh(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const getSchemaApplied = createSchemaAppliedCache(readLedgerFromDatabase);
