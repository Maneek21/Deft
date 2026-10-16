import { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import { env } from './env.js';

let database: ReturnType<typeof createBoundedAppRunDatabase> | undefined;
export function resourceSyncClaimDatabase() {
  return database ??= createBoundedAppRunDatabase(env.DATABASE_URL, { max: 2, application_name: 'deft-resource-sync-claim' });
}
export async function closeResourceSyncClaimDatabase() {
  const previous = database; database = undefined;
  await previous?.close();
}
