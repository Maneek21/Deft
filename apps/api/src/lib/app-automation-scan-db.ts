import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import { env } from './env.js';

export const APP_AUTOMATION_SCAN_DB_LIMITS = Object.freeze({
  connections: 2,
  acquisition_ms: 1_000,
  lock_ms: 250,
  statement_ms: 2_000,
  operation_ms: 3_000,
});

type ScanDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type AppAutomationScanTransaction = Parameters<Parameters<ScanDatabase['transaction']>[0]>[0];

/** Separate capacity and server-enforced SQL limits for scheduler reconciliation.
 * Cancellation waits for the bounded active statement and ROLLBACK; no rejected
 * client-side race may release a slot while database work is still running. */
export function createAppAutomationScanDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: APP_AUTOMATION_SCAN_DB_LIMITS.connections,
    connectionTimeoutMillis: APP_AUTOMATION_SCAN_DB_LIMITS.acquisition_ms,
    statement_timeout: APP_AUTOMATION_SCAN_DB_LIMITS.statement_ms,
    lock_timeout: APP_AUTOMATION_SCAN_DB_LIMITS.lock_ms,
    application_name: 'deft-app-automation-scanner',
  });
  return {
    close: () => pool.end(),
    async transaction<T>(
      run: (tx: AppAutomationScanTransaction) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const deadline = performance.now() + APP_AUTOMATION_SCAN_DB_LIMITS.operation_ms;
      const check = () => {
        signal?.throwIfAborted();
        if (performance.now() >= deadline) throw new Error('App automation database operation timed out');
      };
      check();
      // pg removes timed-out pending acquisitions from its queue. We always
      // await acquisition settlement, including cancellation while queued.
      const client = await pool.connect().catch((error: unknown) => {
        signal?.throwIfAborted();
        throw error;
      });
      let broken = false;
      let settled = false;
      try {
        check();
        const guarded = new Proxy(client, {
          get(target, property, receiver) {
            if (property !== 'query') return Reflect.get(target, property, receiver);
            return async (query: string | pg.QueryConfig, values?: unknown[]) => {
              const text = typeof query === 'string' ? query : query.text;
              // Rollback must remain possible after abort/deadline/SQL errors.
              if (text.toLowerCase() === 'rollback') {
                try { const result = await client.query(query, values); settled = true; return result; }
                catch (error) { broken = true; throw error; }
              }
              check();
              if (text.toLowerCase() !== 'begin') {
                const remaining = Math.max(1, Math.floor(deadline - performance.now()));
                await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
                  String(Math.min(APP_AUTOMATION_SCAN_DB_LIMITS.statement_ms, remaining)),
                  String(Math.min(APP_AUTOMATION_SCAN_DB_LIMITS.lock_ms, remaining)),
                ]);
                check();
              }
              const result = await client.query(query, values);
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
        throw error;
      } finally {
        // BEGIN can succeed immediately before cancellation, outside Drizzle's
        // transaction callback. Cover that path as well before reusing the slot.
        if (!settled) {
          try { await client.query('ROLLBACK'); }
          catch { broken = true; }
        }
        client.release(broken);
      }
    },
  };
}

let scanner: ReturnType<typeof createAppAutomationScanDatabase> | undefined;
export function appAutomationScanDatabase() {
  return scanner ??= createAppAutomationScanDatabase(env.DATABASE_URL);
}

export async function closeAppAutomationScanDatabase(): Promise<void> {
  if (scanner) await scanner.close();
  scanner = undefined;
}
