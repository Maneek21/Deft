/**
 * Defty internal employee identity reservation regressions.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api exec tsx --test test/defty-identity-boundary.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { getActiveAgentToolPolicy } from '../src/lib/agent-tool-policy.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const createOrgId = `defty-reservation-create-org-${suffix}`;
const cloneOrgId = `defty-reservation-clone-org-${suffix}`;
const createOwnerId = `defty-reservation-create-owner-${suffix}`;
const cloneOwnerId = `defty-reservation-clone-owner-${suffix}`;
const canonicalEmployeeId = `defty-reservation-canonical-${suffix}`;
const forgedRuntimeEmployeeId = `defty-reservation-forged-${suffix}`;
const externalEmployeeId = `defty-reservation-external-${suffix}`;

let client: pg.Client;

const app = new Hono();
app.use('*', async (c, next) => {
  const cloneOrg = c.req.header('x-test-org') === 'clone';
  c.set('user', {
    id: cloneOrg ? cloneOwnerId : createOwnerId,
    org_id: cloneOrg ? cloneOrgId : createOrgId,
    email: cloneOrg ? 'clone-owner@test.local' : 'create-owner@test.local',
  } as any);
  await next();
});
app.route('/api/agent-employees', agentEmployeeRoutes);

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES
       ($1, 'Defty reservation create', $2),
       ($3, 'Defty reservation clone', $4)`,
    [
      createOrgId,
      `defty-reservation-create-${suffix}`,
      cloneOrgId,
      `defty-reservation-clone-${suffix}`,
    ],
  );
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
     VALUES
       ($1, $2, 'Create Owner', 'human', false, true),
       ($3, $4, 'Clone Owner', 'human', false, true)`,
    [
      createOwnerId,
      `defty-create-owner-${suffix}@test.local`,
      cloneOwnerId,
      `defty-clone-owner-${suffix}@test.local`,
    ],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES
       ($1, $2, $3, 'owner', true),
       ($4, $5, $6, 'owner', true)`,
    [randomUUID(), createOrgId, createOwnerId, randomUUID(), cloneOrgId, cloneOwnerId],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, runtime_kind,
       trust_level, max_daily_actions, created_by, is_active, is_deleted, is_byoa)
     VALUES
       ($1, $2, $3, 'Defty', 'defty-system', 'superintendent', 'internal',
        'defty_system', 'conservative', 1000, $3, true, true, false),
       ($4, $2, $3, 'Forged Runtime', $5, 'custom', 'external spoof',
        'defty_system', 'standard', 50, $3, true, true, true),
       ($6, $2, $3, 'External Source', $7, 'custom', 'external',
        'custom_mcp', 'standard', 50, $3, true, false, true)`,
    [
      canonicalEmployeeId,
      cloneOrgId,
      cloneOwnerId,
      forgedRuntimeEmployeeId,
      `forged-defty-runtime-${suffix}`,
      externalEmployeeId,
      `external-clone-source-${suffix}`,
    ],
  );
});

after(async () => {
  if (!client) return;
  const orgIds = [createOrgId, cloneOrgId];
  const memberRows = await client.query<{ user_id: string }>(
    'SELECT user_id FROM org_members WHERE org_id = ANY($1::text[])',
    [orgIds],
  );
  const userIds = [...new Set(memberRows.rows.map((row) => row.user_id))];
  await client.query('DELETE FROM agent_channel_tokens WHERE org_id = ANY($1::text[])', [orgIds]);
  await client.query('DELETE FROM api_keys WHERE org_id = ANY($1::text[])', [orgIds]);
  await client.query(
    `DELETE FROM agent_employee_skills
     WHERE agent_employee_id IN (
       SELECT id FROM agent_employees WHERE org_id = ANY($1::text[])
     )`,
    [orgIds],
  );
  if (userIds.length > 0) {
    await client.query('UPDATE users SET agent_employee_id = NULL WHERE id = ANY($1::text[])', [userIds]);
  }
  await client.query('DELETE FROM agent_employees WHERE org_id = ANY($1::text[])', [orgIds]);
  await client.query('DELETE FROM org_members WHERE org_id = ANY($1::text[])', [orgIds]);
  if (userIds.length > 0) {
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds]);
  }
  await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [orgIds]);
  await client.end();
  await closeDb();
});

test('public employee create cannot claim the canonical Defty slug or runtime', async () => {
  const slugResponse = await app.request('/api/agent-employees', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Defty System',
      role: 'custom',
      system_prompt: 'external agent',
    }),
  });
  assert.equal(slugResponse.status, 400);

  const runtimeResponse = await app.request('/api/agent-employees', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'External Impostor',
      role: 'custom',
      runtime_kind: 'defty_system',
      system_prompt: 'external agent',
    }),
  });
  assert.equal(runtimeResponse.status, 400);

  const claimed = await client.query(
    `SELECT id FROM agent_employees
     WHERE org_id = $1 AND (slug = 'defty-system' OR runtime_kind = 'defty_system')`,
    [createOrgId],
  );
  assert.equal(claimed.rowCount, 0);
});

test('clone cannot source an internal or forged Defty runtime identity', async () => {
  for (const sourceId of [canonicalEmployeeId, forgedRuntimeEmployeeId]) {
    const response = await app.request(`/api/agent-employees/${sourceId}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-org': 'clone' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404, await response.text());
  }
});

test('clone cannot create the canonical Defty slug', async () => {
  const response = await app.request(`/api/agent-employees/${externalEmployeeId}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-org': 'clone' },
    body: JSON.stringify({ slug: 'defty-system' }),
  });
  assert.equal(response.status, 400, await response.text());
});

test('runtime_kind alone cannot activate a deleted external employee policy', async () => {
  const canonical = await getActiveAgentToolPolicy(cloneOrgId, canonicalEmployeeId);
  assert.ok(canonical);

  const forged = await getActiveAgentToolPolicy(cloneOrgId, forgedRuntimeEmployeeId);
  assert.equal(forged, null);
});
