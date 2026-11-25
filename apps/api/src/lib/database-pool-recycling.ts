/**
 * How long a pooled PostgreSQL connection lives, for every pool the API opens
 * (db.ts, the App pools; see app-database-pool-budget.ts).
 *
 * A PostgreSQL backend keeps the memory it took to plan a statement until its
 * connection closes: its allocator does not hand freed memory back. A pooled
 * connection that once planned a large statement (the Inbox's approval check
 * took tens of MB) stays that large while it is reused, and a few such
 * connections ran a 512 MB database machine out of memory (release 149).
 *
 * - `DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS` (default 300): a connection
 *   this old is closed when it is next idle, never while a request, a
 *   transaction or an advisory lock holds it. A busy pool's connections are
 *   rarely idle long enough to time out, so this is what bounds how long one
 *   carries that memory. Five minutes with all 18 connections open replaces
 *   one about every 17 seconds, each a few milliseconds to open.
 * - `DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS` (default 10, what every pool
 *   had as node-postgres's default): a connection idle this long is closed.
 *
 * Neither changes how many connections a pool may open. Each setting is a
 * whole number in range, or the API does not start. A pool that keeps a
 * connection open on purpose (`min`: the App run maintenance pool) takes the
 * idle timeout only, since node-postgres would close that connection for age
 * and not reopen it (app-run-bounded-db.ts). The API holds no LISTEN
 * connection; one would need its own client, not a pooled connection, which
 * these settings close.
 */
const SETTINGS = {
  maxLifetimeSeconds: { name: 'DEFT_DATABASE_POOL_MAX_LIFETIME_SECONDS', fallback: 300, min: 30, max: 86_400 },
  idleTimeoutSeconds: { name: 'DEFT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS', fallback: 10, min: 1, max: 3_600 },
} as const;

/** The node-postgres pool options that retire connections. */
export type DatabasePoolRecycling = Readonly<{ maxLifetimeSeconds: number; idleTimeoutMillis: number }>;

function setting(source: NodeJS.ProcessEnv, spec: (typeof SETTINGS)[keyof typeof SETTINGS]): number {
  const raw = source[spec.name];
  if (raw === undefined || raw === '') return spec.fallback;
  const value = /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new Error(`${spec.name} must be a whole number of seconds from ${spec.min} to ${spec.max}`);
  }
  return value;
}

/** The recycling options from the environment; throws, naming the setting, on a value out of range. */
export function parseDatabasePoolRecycling(source: NodeJS.ProcessEnv = process.env): DatabasePoolRecycling {
  return Object.freeze({
    maxLifetimeSeconds: setting(source, SETTINGS.maxLifetimeSeconds),
    idleTimeoutMillis: setting(source, SETTINGS.idleTimeoutSeconds) * 1000,
  });
}

/** Spread into the options of every `pg.Pool` the API opens. */
export const DATABASE_POOL_RECYCLING: DatabasePoolRecycling = parseDatabasePoolRecycling();
