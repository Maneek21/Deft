import { createBoundedAppRunDatabase, APP_RUN_TRANSACTION_LIMITS } from './app-run-bounded-db.js';

export const APP_RUN_MAINTENANCE_LIMITS = Object.freeze({ items: 20, ...APP_RUN_TRANSACTION_LIMITS });

/** Existing maintenance capacity and bounds remain unchanged. */
export function createAppRunMaintenanceDatabase(connectionString: string) {
  return createBoundedAppRunDatabase(connectionString, { max: 1, application_name: 'deft-app-run-maintenance' });
}
