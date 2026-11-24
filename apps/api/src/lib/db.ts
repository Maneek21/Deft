import { handleDatabaseConnectionErrors, connectionFailure } from './database-connection-errors.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';
import { closeAppAutomationScanDatabase } from './app-automation-scan-db.js';
import { closeExperienceExposureDatabase } from './app-experience-exposure-db.js';
import { closePrivateSearchDatabase } from './app-resource-private-search-db.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: APP_DATABASE_POOL_BUDGET.ordinary,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// No JIT: these are short OLTP statements. The review gate's estimated cost
// (subplans per row) passes jit_above_cost, and Postgres then spends seconds
// compiling a statement that runs in milliseconds (the Inbox approval count:
// 2-28 s with JIT, 5 ms without), up to statement_timeout. Set per
// connection, not as a startup `options`: that would replace PGOPTIONS, and a
// pooler may refuse a startup parameter it does not know. The client runs
// its queries in order, so this precedes the connection's first query.
pool.on('connect', (client) => {
  client.query('SET jit = off').catch(() => undefined);
});

// Session-scoped advisory locks must not consume the ordinary query pool;
// otherwise enough concurrent long-running workflows could hold every query
// connection while each waits for another query connection.
const advisoryPool = new Pool({
  connectionString: env.DATABASE_URL,
  application_name: 'deft-advisory',
  max: APP_DATABASE_POOL_BUDGET.advisory,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

handleDatabaseConnectionErrors(pool);
handleDatabaseConnectionErrors(advisoryPool);

export const db = drizzle(pool, { schema });

/**
 * Serialize a crash-resumable workflow across processes while allowing the
 * workflow itself to use ordinary Drizzle transactions. PostgreSQL releases
 * the session lock automatically if the process/connection dies.
 */
export async function withDbAdvisoryLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = await advisoryPool.connect();
  let operationError: Error | undefined;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    const result = await run();
    if (connectionFailure(client)) throw connectionFailure(client);
    return result;
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    try {
      if (!operationError && !connectionFailure(client)) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    } catch (error) {
      operationError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(operationError ?? connectionFailure(client));
    }
  }
}

export type DbAdvisoryLease = { readonly lost: boolean };

/**
 * How long a non-waiting lease may wait for an advisory-pool connection.
 * The pool is small (two connections) and plans hold one for a whole plan,
 * so a caller that only wants to *try* the lock answers "busy" after a short
 * wait instead of queueing behind long-running work. Three seconds covers
 * ordinary contention from other approvals (a few database round trips each)
 * while keeping an HTTP request well inside client timeouts.
 */
export const ADVISORY_LEASE_ACQUIRE_TIMEOUT_MS = 3_000;

export type DbAdvisoryLeaseResult<T> =
  | { acquired: true; value: T }
  /** `held`: another session holds the lock. `pool_busy`: no advisory
   *  connection became free in time. Nothing was run in either case. */
  | { acquired: false; reason: 'held' | 'pool_busy' };

async function connectAdvisoryWithin(timeoutMs: number): Promise<pg.PoolClient | null> {
  const pending = advisoryPool.connect();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  let winner: pg.PoolClient | null;
  try {
    winner = await Promise.race([pending, timedOut]);
  } finally {
    // Also when the connect itself rejects.
    clearTimeout(timer);
  }
  if (winner) return winner;
  // The queued connect may still be granted later: hand it straight back so
  // a timed-out caller never keeps a connection.
  pending.then((late) => late.release(), () => undefined);
  return null;
}

/**
 * Hold a session advisory lock on a dedicated advisory-pool connection for
 * the whole of `run`, so another process can tell with
 * `pg_try_advisory_lock` whether the holder is still alive. With
 * `wait: false` the call returns `{ acquired: false }` promptly when the
 * lock is held elsewhere or no advisory connection frees up within
 * `acquireTimeoutMs`. If the holder connection fails, `lease.lost` turns
 * true and the broken connection is discarded instead of reused.
 */
export async function withDbAdvisoryLease<T>(
  key: string,
  options: { wait: boolean; acquireTimeoutMs?: number },
  run: (lease: DbAdvisoryLease) => Promise<T>,
): Promise<DbAdvisoryLeaseResult<T>> {
  const client = options.wait
    ? await advisoryPool.connect()
    : await connectAdvisoryWithin(options.acquireTimeoutMs ?? ADVISORY_LEASE_ACQUIRE_TIMEOUT_MS);
  if (!client) return { acquired: false, reason: 'pool_busy' };
  let lostError: Error | null = null;
  const onError = (error: Error) => { lostError = error; };
  const onEnd = () => { lostError ??= new Error('advisory lease connection ended'); };
  client.on('error', onError);
  client.on('end', onEnd);
  let acquired = false;
  try {
    if (options.wait) {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      acquired = true;
    } else {
      const locked = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [key],
      );
      acquired = locked.rows[0]?.acquired === true;
    }
    if (!acquired) return { acquired: false, reason: 'held' };
    const lease: DbAdvisoryLease = { get lost() { return lostError !== null; } };
    return { acquired: true, value: await run(lease) };
  } catch (error) {
    lostError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    let releaseError: Error | undefined = lostError ?? undefined;
    if (acquired && !releaseError) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.off('error', onError);
    client.off('end', onEnd);
    client.release(releaseError);
  }
}

/** Drain the shared PostgreSQL pool during process shutdown. */
export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), advisoryPool.end(), closeAppAutomationScanDatabase(), closeExperienceExposureDatabase(), closePrivateSearchDatabase()]);
}
