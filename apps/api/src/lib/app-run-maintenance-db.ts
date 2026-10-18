import { createBoundedAppRunDatabase, APP_RUN_TRANSACTION_LIMITS } from './app-run-bounded-db.js';
import { APP_DATABASE_POOL_BUDGET } from './app-database-pool-budget.js';

export const APP_RUN_MAINTENANCE_LIMITS = Object.freeze({ items: 20, ...APP_RUN_TRANSACTION_LIMITS });

/** Keep the one budgeted connection between 30-second recovery passes. pg's
 * default 10-second idle eviction otherwise forces a fresh handshake under the
 * 250ms acquisition bound on every pass. No transaction is retained. */
export function createAppRunMaintenanceDatabase(connectionString: string) {
  return createBoundedAppRunDatabase(connectionString, { max: APP_DATABASE_POOL_BUDGET.run_maintenance,
    min: 1, application_name: 'deft-app-run-maintenance' });
}
