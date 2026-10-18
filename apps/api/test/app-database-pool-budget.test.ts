import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_DATABASE_POOL_BUDGET, APP_DATABASE_POOL_MAX_CONNECTIONS } from '../src/lib/app-database-pool-budget.js';

test('a fully enabled App Host retains recovery capacity on the supported 20-connection floor', () => {
  assert.equal(APP_DATABASE_POOL_MAX_CONNECTIONS, 18);
  assert.ok(APP_DATABASE_POOL_MAX_CONNECTIONS
    <= APP_DATABASE_POOL_BUDGET.minimum_server_connections - APP_DATABASE_POOL_BUDGET.reserved_connections);
  assert.equal(APP_DATABASE_POOL_BUDGET.private_search, 1);
  assert.equal(APP_DATABASE_POOL_BUDGET.experience_human_action, 2,
    'human review keeps its independent anti-starvation capacity');
});
