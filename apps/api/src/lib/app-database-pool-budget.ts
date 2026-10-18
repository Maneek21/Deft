/**
 * Process-wide PostgreSQL connection budget for a fully enabled App Host.
 *
 * The bounded pools isolate slow or privileged App work, but isolation must
 * not let their combined maxima exhaust a small self-hosted PostgreSQL. Keep
 * the total at or below 18 so a 20-connection server retains two operator and
 * recovery slots even when every optional App plane is enabled at once.
 */
export const APP_DATABASE_POOL_BUDGET = Object.freeze({
  minimum_server_connections: 20,
  reserved_connections: 2,
  ordinary: 4,
  advisory: 2,
  automation_scan: 1,
  experience_read: 2,
  experience_human_action: 2,
  private_search: 1,
  attachment_runtime: 2,
  attachment_cleanup: 1,
  native_execution: 1,
  resource_sync_claim: 1,
  run_maintenance: 1,
});

const poolMaxima = [
  APP_DATABASE_POOL_BUDGET.ordinary,
  APP_DATABASE_POOL_BUDGET.advisory,
  APP_DATABASE_POOL_BUDGET.automation_scan,
  APP_DATABASE_POOL_BUDGET.experience_read,
  APP_DATABASE_POOL_BUDGET.experience_human_action,
  APP_DATABASE_POOL_BUDGET.private_search,
  APP_DATABASE_POOL_BUDGET.attachment_runtime,
  APP_DATABASE_POOL_BUDGET.attachment_cleanup,
  APP_DATABASE_POOL_BUDGET.native_execution,
  APP_DATABASE_POOL_BUDGET.resource_sync_claim,
  APP_DATABASE_POOL_BUDGET.run_maintenance,
] as const;

export const APP_DATABASE_POOL_MAX_CONNECTIONS = poolMaxima.reduce((sum, value) => sum + value, 0);

if (APP_DATABASE_POOL_MAX_CONNECTIONS
  > APP_DATABASE_POOL_BUDGET.minimum_server_connections - APP_DATABASE_POOL_BUDGET.reserved_connections) {
  throw new Error('App database pool budget exceeds the supported PostgreSQL connection floor');
}
