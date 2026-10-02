import { createExperienceExposureDatabase } from './app-experience-exposure-db.js';
import { env } from './env.js';
let database: ReturnType<typeof createExperienceExposureDatabase> | undefined;
/** Separate search capacity; reuse the tested acquisition/SQL/rollback limits. */
export function privateSearchDatabase() {
  return database ??= createExperienceExposureDatabase(env.DATABASE_URL);
}
export async function closePrivateSearchDatabase(): Promise<void> {
  if (database) await database.close();
  database = undefined;
}
