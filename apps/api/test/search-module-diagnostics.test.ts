import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { retrieveContextWithDiagnostics } from '../src/lib/retrieve-context.js';
import { searchRoutes } from '../src/routes/search.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL?.trim();
const runtimeDatabaseUrl = process.env.DATABASE_URL?.trim();
const canRun = Boolean(databaseUrl && runtimeDatabaseUrl === databaseUrl && /(?:test|ci|acceptance)/i.test(new URL(databaseUrl).pathname));

function testSearchApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: 'module-search-diagnostic-user',
      org_id: 'module-search-diagnostic-org',
      role: 'guest',
      email: 'module-search-diagnostic@example.test',
    } as any);
    await next();
  });
  app.route('/api/search', searchRoutes);
  return app;
}

test('global search reports a safe Module-read denial instead of an empty module group', { skip: !canRun }, async () => {
  assert.equal(runtimeDatabaseUrl, databaseUrl, 'DATABASE_URL and DEFT_TEST_DATABASE_URL must identify the same database');
  const response = await testSearchApp().request('/api/search?q=diagnostic');
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body.modules, []);
  assert.deepEqual((body.search_diagnostics as Record<string, unknown>).modules, {
    source: 'modules',
    status: 'forbidden',
    code: 'MODULE_READ_FORBIDDEN',
    message: 'Module search is not permitted for this actor.',
  });
});

test('detailed retrieval reports an unavailable Module branch without records', { skip: !canRun }, async () => {
  assert.equal(runtimeDatabaseUrl, databaseUrl, 'DATABASE_URL and DEFT_TEST_DATABASE_URL must identify the same database');
  const outcome = await retrieveContextWithDiagnostics({
    query: 'diagnostic',
    org_id: 'module-search-diagnostic-org',
    agent_employee_id: 'missing-module-reader',
    types: ['modules'],
    hybrid: false,
  });

  assert.deepEqual(outcome.results, []);
  assert.deepEqual(outcome.diagnostics, [{
    source: 'modules',
    status: 'unavailable',
    code: 'MODULE_READ_UNAVAILABLE',
    message: 'Module search is temporarily unavailable. Retry the search.',
  }]);
});

test('detailed retrieval treats a missing membership as forbidden, not retryable', { skip: !canRun }, async () => {
  assert.equal(runtimeDatabaseUrl, databaseUrl, 'DATABASE_URL and DEFT_TEST_DATABASE_URL must identify the same database');
  const outcome = await retrieveContextWithDiagnostics({
    query: 'diagnostic',
    org_id: 'module-search-diagnostic-org',
    user_id: 'missing-module-reader-user',
    types: ['modules'],
    hybrid: false,
  });

  assert.deepEqual(outcome.results, []);
  assert.deepEqual(outcome.diagnostics, [{
    source: 'modules',
    status: 'forbidden',
    code: 'MODULE_READ_FORBIDDEN',
    message: 'Module search is not permitted for this actor.',
  }]);
});

test('detailed retrieval treats a disabled module search tool as forbidden', { skip: !canRun }, async () => {
  assert.equal(runtimeDatabaseUrl, databaseUrl, 'DATABASE_URL and DEFT_TEST_DATABASE_URL must identify the same database');
  const client = new pg.Client({ connectionString: databaseUrl });
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const userId = randomUUID();
  const employeeId = randomUUID();
  await client.connect();
  try {
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [orgId, 'Module diagnostic', `module-diagnostic-${suffix}`]);
    await client.query('INSERT INTO users (id, name, email) VALUES ($1, $2, $3)', [userId, 'Module diagnostic user', `module-diagnostic-${suffix}@example.test`]);
    await client.query("INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')", [randomUUID(), orgId, userId]);
    await client.query(`INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, trust_level, created_by, disabled_tools)
      VALUES ($1, $2, $3, 'Module diagnostic employee', $4, 'custom', 'Test', 'standard', $3, $5)`,
    [employeeId, orgId, userId, `module-diagnostic-${suffix}`, ['module_record_search']]);

    const outcome = await retrieveContextWithDiagnostics({
      query: 'diagnostic', org_id: orgId, agent_employee_id: employeeId, types: ['modules'], hybrid: false,
    });
    assert.deepEqual(outcome.results, []);
    assert.deepEqual(outcome.diagnostics, [{
      source: 'modules', status: 'forbidden', code: 'MODULE_READ_FORBIDDEN',
      message: 'Module search is not permitted for this actor.',
    }]);
  } finally {
    await client.query('DELETE FROM agent_employees WHERE id = $1', [employeeId]);
    await client.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.end();
  }
});
