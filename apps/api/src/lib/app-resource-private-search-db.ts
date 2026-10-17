import { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';
import { env } from './env.js';
import type { AppRunTransaction } from './app-run-repository.js';

function createPrivateSearchDatabase() {
  const bounded = createBoundedAppRunDatabase(env.DATABASE_URL, {
    max: APP_DATABASE_POOL_BUDGET.private_search,
    application_name: 'deft-private-search',
  });
  return {
    close: bounded.close,
    transaction<T>(work: (tx: AppRunTransaction) => Promise<T>, signal?: AbortSignal,
      deadline = performance.now() + 3_000) {
      return bounded.transaction(work, signal ?? new AbortController().signal, deadline);
    },
  };
}
let database: ReturnType<typeof createPrivateSearchDatabase> | undefined;
/** Separate single-slot search capacity. Private reads never need the separate
 * human-action pool owned by Experience review, so allocating that pair here
 * needlessly consumed scarce PostgreSQL connections. */
export function privateSearchDatabase() {
  return database ??= createPrivateSearchDatabase();
}
export async function closePrivateSearchDatabase(): Promise<void> {
  if (database) await database.close();
  database = undefined;
}
