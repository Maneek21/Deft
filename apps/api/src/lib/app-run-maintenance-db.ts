import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';

export const APP_RUN_MAINTENANCE_LIMITS = Object.freeze({ items: 20, budget_ms: 10_000,
  acquisition_ms: 250, lock_ms: 250, statement_ms: 2_000 });

/** Separate bounded maintenance capacity; ordinary workers keep their pool. */
export function createAppRunMaintenanceDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1,
    connectionTimeoutMillis: APP_RUN_MAINTENANCE_LIMITS.acquisition_ms,
    statement_timeout: APP_RUN_MAINTENANCE_LIMITS.statement_ms,
    query_timeout: APP_RUN_MAINTENANCE_LIMITS.statement_ms,
    lock_timeout: APP_RUN_MAINTENANCE_LIMITS.lock_ms,
    application_name: 'deft-app-run-maintenance' });
  return {
    close: () => pool.end(),
    async transaction<T>(work: (tx: AppRunTransaction) => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
      const check = () => { signal.throwIfAborted(); if (performance.now() >= deadline) throw new Error('App Run maintenance deadline'); };
      check(); const client = await pool.connect(); let settled = false; let broken = false; let released = false;
      const discard = () => { broken = true; if (!released) { released = true; client.release(true); } };
      const timer = setTimeout(discard, Math.max(1, deadline - performance.now()));
      signal.addEventListener('abort', discard, { once: true });
      let statementLimit: number = APP_RUN_MAINTENANCE_LIMITS.statement_ms;
      let lockLimit: number = APP_RUN_MAINTENANCE_LIMITS.lock_ms;
      try {
        check();
        const guarded = new Proxy(client, { get(target, property, receiver) {
          if (property !== 'query') return Reflect.get(target, property, receiver);
          return async (query: string | pg.QueryConfig, values?: unknown[]) => {
            const command = (typeof query === 'string' ? query : query.text).toLowerCase();
            if (command === 'rollback') {
              try { const result = await client.query(query, values); settled = true; return result; }
              catch (error) { broken = true; throw error; }
            }
            check();
            if (command !== 'begin') {
              const remaining = Math.max(1, Math.floor(deadline - performance.now()));
              const statement = Math.min(APP_RUN_MAINTENANCE_LIMITS.statement_ms, remaining);
              const lock = Math.min(APP_RUN_MAINTENANCE_LIMITS.lock_ms, remaining);
              if (statement < statementLimit || lock < lockLimit) {
                await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [String(statement), String(lock)]);
                statementLimit = statement; lockLimit = lock;
              }
              check();
            }
            let result;
            try { result = await client.query(query, values); }
            catch (error) { discard(); throw error; }
            if (command === 'commit') settled = true;
            else check();
            return result;
          };
        } });
        return await drizzle(guarded, { schema }).transaction(work);
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', discard);
        if (!settled && !released) { try { await client.query('ROLLBACK'); } catch { broken = true; } }
        if (!released) client.release(broken);
      }
    },
  };
}
