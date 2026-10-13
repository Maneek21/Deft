import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';

export const APP_EXPERIENCE_EXPOSURE_DB_LIMITS = Object.freeze({
  connections: 2,
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
  const pool = new pg.Pool({
    connectionString,
    pipeline: false,
    max: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.connections,
    connectionTimeoutMillis: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.acquisition_ms,
    statement_timeout: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.statement_ms,
    query_timeout: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.statement_ms,
    lock_timeout: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.lock_ms,
    application_name: 'deft-experience-exposure',
  });
  return {
    close: () => pool.end(),
    async transaction<T>(
      run: (tx: ExperienceExposureTransaction) => Promise<T>,
      signal?: AbortSignal,
      sliceDeadline?: number,
      observeQuery?: (sample: Readonly<{ kind: 'query' | 'acquisition'; elapsed_ms: number }>) => void,
      purpose?: 'human_action_confirmation',
    ): Promise<T> {
      const operationLimit = purpose === 'human_action_confirmation'
        ? APP_EXPERIENCE_EXPOSURE_DB_LIMITS.confirmation_operation_ms
        : APP_EXPERIENCE_EXPOSURE_DB_LIMITS.operation_ms;
      const deadline = Math.min(performance.now() + operationLimit,
        sliceDeadline ?? Infinity);
      const check = () => {
        signal?.throwIfAborted();
        if (performance.now() >= deadline) throw new Error('Experience exposure database operation timed out');
      };
      check();
      // pg removes timed-out pending acquisitions from its queue. We always
      // await acquisition settlement, including cancellation while queued.
      const observe = (kind: 'query' | 'acquisition', elapsed_ms: number) => {
        try { observeQuery?.({ kind, elapsed_ms: Math.max(0, elapsed_ms) }); } catch { /* Diagnostics never affect SQL authority. */ }
      };
      const acquisitionAt = performance.now();
      const client = await pool.connect().catch((error: unknown) => {
        observe('acquisition', performance.now() - acquisitionAt);
        signal?.throwIfAborted();
        throw error;
      });
      observe('acquisition', performance.now() - acquisitionAt);
      const observedQuery = async (query: string | pg.QueryConfig, values?: unknown[]) => {
        const at = performance.now();
        try { return await client.query(query, values); }
        finally { observe('query', performance.now() - at); }
      };
      let broken = false;
      let settled = false;
      let discarded: Promise<void> | undefined;
      // pg Client.end destroys an active non-pipelined query socket. Keep its
      // checked-out pool slot until the query and socket have actually settled.
      const discard = () => {
        if (broken) return;
        broken = true;
        discarded = client.end().catch(() => undefined);
      };
      const timer = setTimeout(discard, Math.max(1, deadline - performance.now()));
      signal?.addEventListener('abort', discard, { once: true });
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
              catch (error) { discard(); throw error; }
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
        if (!settled) discard();
        signal?.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', discard);
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
