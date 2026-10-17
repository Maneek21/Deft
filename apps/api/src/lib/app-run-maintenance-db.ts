import { createBoundedAppRunDatabase, APP_RUN_TRANSACTION_LIMITS } from './app-run-bounded-db.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';

export const APP_RUN_MAINTENANCE_LIMITS = Object.freeze({ items: 20, ...APP_RUN_TRANSACTION_LIMITS });

/** Existing maintenance capacity and bounds remain unchanged. */
export function createAppRunMaintenanceDatabase(connectionString: string) {
  return createBoundedAppRunDatabase(connectionString, { max: APP_DATABASE_POOL_BUDGET.run_maintenance, application_name: 'deft-app-run-maintenance' });
}
