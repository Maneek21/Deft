import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import pg from 'pg';
import { mcpServerRoutes } from '../src/routes/mcp-server.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const apiKeyId = randomUUID();
const token = `deft_legacy_${randomBytes(24).toString('hex')}`;
const tokenWithWrongSecret = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
const app = new Hono().route('/mcp', mcpServerRoutes);

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function listTools(bearer: string): Promise<Response> {
  return app.request('/mcp/tools', { headers: { Authorization: `Bearer ${bearer}` } });
}

before(async () => {
  const actor = await withClient(async (client) => (await client.query<{ org_id: string; user_id: string }>(
    `SELECT org_id, user_id
     FROM org_members
     WHERE is_active = true
     ORDER BY created_at
     LIMIT 1`,
  )).rows[0]);
  assert.ok(actor, 'an active seeded member is required');
  const keyHash = await bcrypt.hash(token, 4);
  await withClient((client) => client.query(
    `INSERT INTO api_keys (
       id, org_id, name, key_hash, key_prefix, permissions,
       rate_limit_per_minute, rate_limit_per_day, is_active, created_by
     ) VALUES ($1, $2, 'Legacy auth boundary test', $3, $4, ARRAY['read'], 60, 1000, true, $5)`,
    [apiKeyId, actor.org_id, keyHash, token.slice(0, 12), actor.user_id],
  ));
});

after(async () => {
  await withClient((client) => client.query('DELETE FROM api_keys WHERE id = $1', [apiKeyId]));
});

test('legacy API-key auth returns only active non-secret identity metadata', async () => {
  const valid = await listTools(token);
  const validText = await valid.text();
  assert.equal(valid.status, 200, validText);
  assert.equal(valid.headers.get('deprecation'), 'true');
  const validBody = JSON.parse(validText) as { tools: Array<{ name: string }> };
  assert.ok(validBody.tools.some((tool) => tool.name === 'deft_search_tasks'));

  const wrongSecret = await listTools(tokenWithWrongSecret);
  assert.equal(wrongSecret.status, 401);

  await withClient((client) => client.query('UPDATE api_keys SET is_active = false WHERE id = $1', [apiKeyId]));
  const inactive = await listTools(token);
  assert.equal(inactive.status, 401);

  await withClient((client) => client.query(
    `UPDATE api_keys SET is_active = true, expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [apiKeyId],
  ));
  const expired = await listTools(token);
  assert.equal(expired.status, 401);
});
