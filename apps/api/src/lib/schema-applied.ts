import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { Socket } from 'node:net';
import { env } from './env.js';

/**
 * The database version actually applied, read from the upgrade ledger
 * (`deft_schema_migrations`, written by packages/db/scripts/upgrade.ts), so
 * a half-upgraded install is visible on /health beside the release's
 * expected `schema_head`.
 *
 * /health must stay cheap and must not fail when the database is down: the
 * value is cached (30s; 5s after a failure), a read is bounded by a short
 * timeout and abandoned when stuck, and the state says which case applies.
 */
export type LedgerRow = { version: string; applied_at: Date | string | null };
export type LedgerReader = () => Promise<LedgerRow[] | null>;

const CACHE_MS = 30_000;
const FAILURE_CACHE_MS = 5_000;
const READ_TIMEOUT_MS = 1_000;
const DATABASE_BUDGET_MS = 800;

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
 * The newest ledger row, by release order alone. applied_at is not used: a
 * fresh install records the whole manifest in one transaction (ties), and a
 * restore host whose clock is behind would pick the wrong row.
 */
export function newestLedgerVersion(rows: readonly LedgerRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (best === null || compareSchemaVersions(row.version, best) > 0) best = row.version;
  }
  return best;
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

/**
 * Use at most one short-lived recovery connection, never the ordinary pool.
 * Its deadline includes startup, queries and transport stalls. Destroying our
 * socket closes the database session even when PostgreSQL cannot respond.
 * The existing two reserved recovery/operator slots cover this one reader.
 */
async function readLedgerOnce(): Promise<LedgerRow[] | null> {
  const socket = new Socket();
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const client = new pg.Client({ connectionString: env.DATABASE_URL, stream: () => socket,
    connectionTimeoutMillis: DATABASE_BUDGET_MS, query_timeout: DATABASE_BUDGET_MS,
    statement_timeout: DATABASE_BUDGET_MS, application_name: 'deft-schema-health' });
  // Errors between queries must not become uncaught EventEmitter errors.
  client.on('error', () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { socket.destroy(); reject(new Error('Schema ledger read deadline')); }, DATABASE_BUDGET_MS);
  });
  const read = async () => {
    await client.connect();
    const reader = drizzle(client);
    const exists = resultRows(await reader.execute(sql`
      SELECT to_regclass('public.deft_schema_migrations') IS NOT NULL AS exists
    `))[0]?.exists === true;
    if (!exists) return null;
    return resultRows(await reader.execute(sql`SELECT version, applied_at FROM deft_schema_migrations`))
      .map((row) => ({ version: String(row.version), applied_at: row.applied_at as Date | string | null }));
  };
  try {
    return await Promise.race([read(), timedOut]);
  } finally {
    clearTimeout(timer);
    void client.end().catch(() => {});
    socket.destroy();
    await closed;
  }
}

let activeRead: ReturnType<typeof readLedgerOnce> | null = null;
export const readLedgerFromDatabase: LedgerReader = () => {
  // Keep the slot until local socket cleanup completes, even if the HTTP cache
  // has already answered unavailable. Concurrent probes cannot pile up work.
  activeRead ??= readLedgerOnce().finally(() => { activeRead = null; });
  return activeRead;
};

/**
 * `ok`: read from the ledger. `no_ledger`: the ledger table is missing (or
 * empty). `unavailable`: the database could not be read in time; the value is
 * then the last one read, or null.
 */
export type SchemaAppliedState = 'ok' | 'no_ledger' | 'unavailable';
export type SchemaApplied = { value: string | null; state: SchemaAppliedState };

export function createSchemaAppliedCache(read: LedgerReader, now: () => number = Date.now) {
  let cached: { result: SchemaApplied; until: number } | null = null;
  let lastRead: SchemaApplied | null = null;
  let inFlight: Promise<SchemaApplied> | null = null;
  const unavailable = (): SchemaApplied => ({ value: lastRead?.value ?? null, state: 'unavailable' });

  const refresh = (): Promise<SchemaApplied> => {
    if (inFlight) return inFlight;
    const attempt: Promise<SchemaApplied> = read().then((rows) => {
      const value = rows ? newestLedgerVersion(rows) : null;
      const result: SchemaApplied = { value, state: value === null ? 'no_ledger' : 'ok' };
      // An abandoned read must not overwrite a newer result after recovery.
      if (inFlight === attempt) {
        lastRead = result;
        cached = { result, until: now() + CACHE_MS };
      }
      return result;
    }, () => {
      if (inFlight === attempt) cached = { result: unavailable(), until: now() + FAILURE_CACHE_MS };
      return unavailable();
    }).finally(() => { if (inFlight === attempt) inFlight = null; });
    inFlight = attempt;
    return attempt;
  };

  return async function getSchemaApplied(): Promise<SchemaApplied> {
    if (cached && now() < cached.until) return cached.result;
    const attempt = refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); timer.unref?.(); });
    try {
      const result = await Promise.race([attempt, timedOut]);
      if (result) return result;
      // Stuck read: abandon it, so the next check after the short cache starts
      // a fresh one, and serve the last known value meanwhile.
      if (inFlight === attempt) inFlight = null;
      cached = { result: unavailable(), until: now() + FAILURE_CACHE_MS };
      return cached.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

export const getSchemaApplied = createSchemaAppliedCache(readLedgerFromDatabase);
