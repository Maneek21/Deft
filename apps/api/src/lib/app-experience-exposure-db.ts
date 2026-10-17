import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';
import { ExperienceExposureBusyError } from './app-experience-exposure-db-error.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';

export const APP_EXPERIENCE_EXPOSURE_DB_LIMITS = Object.freeze({
  connections: APP_DATABASE_POOL_BUDGET.experience_read,
  human_action_connections: APP_DATABASE_POOL_BUDGET.experience_human_action,
  acquisition_ms: 1_000,
  lock_ms: 250,
  statement_ms: 2_000,
  operation_ms: 3_000,
  confirmation_operation_ms: 15_000,
});

type ExposureDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type ExperienceExposureTransaction = Parameters<Parameters<ExposureDatabase['transaction']>[0]>[0];

/** Separate capacity and server-enforced SQL limits for Experience exposure.
 * Cancellation waits for the bounded active statement and ROLLBACK; no rejected
 * client-side race may release a slot while database work is still running. */
export function createExperienceExposureDatabase(connectionString: string) {
  const poolOptions = {
    connectionString,
    pipeline: false,
    connectionTimeoutMillis: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.acquisition_ms,
    statement_timeout: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.statement_ms,
    // Give the server statement timeout time to reach the client. Equal
    // client/server timers can reject locally while SQL is still running.
    query_timeout: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.statement_ms + APP_EXPERIENCE_EXPOSURE_DB_LIMITS.acquisition_ms,
    lock_timeout: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.lock_ms,
  };
  const pool = new pg.Pool({
    ...poolOptions,
    max: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.connections,
    application_name: 'deft-experience-exposure',
  });
  // Reads can hold both ordinary slots longer than the acquisition timeout.
  // Reserve two slots only for explicit review preparation/confirmation so
  // status polling cannot starve concurrent reviews. SQL/abort guards are shared.
  const humanActionPool = new pg.Pool({
    ...poolOptions,
    max: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.human_action_connections,
    application_name: 'deft-experience-human-action',
  });
  return {
    close: async () => { await Promise.all([pool.end(), humanActionPool.end()]); },
    async transaction<T>(
      run: (tx: ExperienceExposureTransaction) => Promise<T>,
      signal?: AbortSignal,
      sliceDeadline?: number,
      observeQuery?: (sample: Readonly<{ kind: 'query' | 'acquisition'; elapsed_ms: number }>) => void,
      purpose?: 'human_action_preparation' | 'human_action_confirmation',
    ): Promise<T> {
      const operationLimit = purpose === 'human_action_confirmation'
        ? APP_EXPERIENCE_EXPOSURE_DB_LIMITS.confirmation_operation_ms
        : APP_EXPERIENCE_EXPOSURE_DB_LIMITS.operation_ms;
      const deadline = Math.min(performance.now() + operationLimit,
        sliceDeadline ?? Infinity);
      const check = () => {
        signal?.throwIfAborted();
        if (performance.now() >= deadline) throw new ExperienceExposureBusyError('deadline');
      };
      check();
      // Queued cancellation must settle promptly. A late checkout belongs only
      // to this acquisition continuation: release it without starting any SQL.
      // Active transactions below still settle SQL/rollback before release.
      const observe = (kind: 'query' | 'acquisition', elapsed_ms: number) => {
        try { observeQuery?.({ kind, elapsed_ms: Math.max(0, elapsed_ms) }); } catch { /* Diagnostics never affect SQL authority. */ }
      };
      const acquisitionAt = performance.now();
      const selectedPool = purpose ? humanActionPool : pool;
      const client = await new Promise<pg.PoolClient>((resolve, reject) => {
        let finished = false;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        const fail = (error: unknown) => {
          if (finished) return;
          finished = true; cleanup(); reject(error);
        };
        const abort = () => fail(signal!.reason);
        const timer = setTimeout(() => fail(new ExperienceExposureBusyError('deadline')), Math.max(1, deadline - performance.now()));
        signal?.addEventListener('abort', abort, { once: true });
        selectedPool.connect().then(checkedOut => {
          if (finished) { checkedOut.release(); return; }
          finished = true; cleanup(); resolve(checkedOut);
        }, (error: unknown) => {
          const timeout = error instanceof Error && /^(?:timeout exceeded when trying to connect|Connection terminated due to connection timeout)$/.test(error.message);
          fail(timeout ? new ExperienceExposureBusyError('acquisition', { cause: error }) : error);
        });
      }).finally(() => observe('acquisition', performance.now() - acquisitionAt));
      const activeQueries = new Set<Promise<unknown>>();
      const observedQuery = async (query: string | pg.QueryConfig, values?: unknown[]) => {
        const at = performance.now();
        const pending = client.query(query, values);
        activeQueries.add(pending);
        try {
          return await pending;
        } finally { activeQueries.delete(pending); observe('query', performance.now() - at); }
      };
      let broken = false;
      let settled = false;
      let discarded: Promise<void> | undefined;
      let statementFailure: unknown;
      // Closing the socket alone does not stop an active PostgreSQL statement.
      // Keep the checked-out slot until the server-bounded query has settled,
      // then close the transaction's socket before releasing the broken slot.
      const discard = () => {
        if (broken) return;
        broken = true;
        discarded = Promise.allSettled([...activeQueries])
          .then(() => client.end()).catch(() => undefined);
      };
      // Abort/deadline checks at SQL boundaries prevent new work, while the
      // active statement settles under its server timeout before ROLLBACK.
      // Destroying a socket at the deadline would not cancel server-side SQL.
      let statementLimit: number = APP_EXPERIENCE_EXPOSURE_DB_LIMITS.statement_ms;
      let lockLimit: number = APP_EXPERIENCE_EXPOSURE_DB_LIMITS.lock_ms;
      try {
        check();
        const guarded = new Proxy(client, {
          get(target, property, receiver) {
            if (property !== 'query') return Reflect.get(target, property, receiver);
            return async (query: string | pg.QueryConfig, values?: unknown[]) => {
              const text = typeof query === 'string' ? query : query.text;
              // Rollback must remain possible after abort/deadline/SQL errors.
              if (text.toLowerCase() === 'rollback') {
                if (broken) throw new Error('Experience exposure database connection discarded');
                try { const result = await observedQuery(query, values); settled = true; return result; }
                catch (error) { discard(); throw error; }
              }
              check();
              if (text.toLowerCase() !== 'begin') {
                const remaining = Math.max(1, Math.floor(deadline - performance.now()));
                const statement = Math.min(APP_EXPERIENCE_EXPOSURE_DB_LIMITS.statement_ms, remaining);
                const lock = Math.min(APP_EXPERIENCE_EXPOSURE_DB_LIMITS.lock_ms, remaining);
                // Pool defaults already enforce these limits. Avoid a second
                // round trip at every SQL boundary until the deadline actually
                // requires a stricter transaction-local server limit.
                if (statement < statementLimit || lock < lockLimit) {
                  await observedQuery("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
                    String(statement), String(lock),
                  ]);
                  statementLimit = statement; lockLimit = lock;
                }
                check();
              }
              let result;
              try { result = await observedQuery(query, values); }
              catch (error) { statementFailure = error; discard(); throw error; }
              if (text.toLowerCase() === 'commit') settled = true;
              // COMMIT has already settled and cannot be undone. All earlier
              // boundaries, including immediately before COMMIT, check abort.
              if (text.toLowerCase() !== 'commit') check();
              return result;
            };
          },
        });
        return await drizzle(guarded, { schema }).transaction(run);
      } catch (error) {
        signal?.throwIfAborted();
        for (let cause: unknown = statementFailure ?? error, depth = 0; cause instanceof Error && depth < 8; cause = cause.cause, depth++) {
          if (cause instanceof ExperienceExposureBusyError) throw cause;
          if ('code' in cause && (cause.code === '57014' || cause.code === '55P03')) {
            throw new ExperienceExposureBusyError('deadline', { cause });
          }
        }
        throw error;
      } finally {
        // BEGIN can succeed immediately before cancellation, outside Drizzle's
        // transaction callback. Cover that path as well before reusing the slot.
        if (!settled && !broken) {
          try { await observedQuery('ROLLBACK'); }
          catch { discard(); }
        }
        await discarded;
        client.release(broken);
      }
    },
  };
}

let exposureDatabase: ReturnType<typeof createExperienceExposureDatabase> | undefined;
export function experienceExposureDatabase() {
  return exposureDatabase ??= createExperienceExposureDatabase(env.DATABASE_URL);
}

export async function closeExperienceExposureDatabase(): Promise<void> {
  if (exposureDatabase) await exposureDatabase.close();
  exposureDatabase = undefined;
}
