import { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import { env } from './env.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';

let database: ReturnType<typeof createBoundedAppRunDatabase> | undefined;
export function resourceSyncClaimDatabase() {
  return database ??= createBoundedAppRunDatabase(env.DATABASE_URL, { max: APP_DATABASE_POOL_BUDGET.resource_sync_claim, application_name: 'deft-resource-sync-claim' });
}
export async function closeResourceSyncClaimDatabase() {
  const previous = database; database = undefined;
  await previous?.close();
}
