import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { messagesSearch } from '../src/lib/mcp-tools/reports.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = randomUUID();
const ORG_ID = randomUUID();
const OWNER_ID = `mcp-privacy-owner-${suffix}`;
const EMPLOYEE_USER_ID = `mcp-privacy-shadow-${suffix}`;
const EMPLOYEE_ID = `mcp-privacy-employee-${suffix}`;
const PUBLIC_SPACE_ID = `mcp-privacy-public-${suffix}`;
const JOINED_PRIVATE_SPACE_ID = `mcp-privacy-joined-${suffix}`;
const HIDDEN_PRIVATE_SPACE_ID = `mcp-privacy-hidden-${suffix}`;
const MARKER = `mcp-privacy-marker-${suffix}`;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

before(async () => {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'MCP Privacy Test', $2)`,
      [ORG_ID, `mcp-privacy-${suffix}`],
    );
    await client.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES
         ($1, $3, 'Privacy Owner', false),
         ($2, $4, 'Privacy Employee', true)`,
      [
        OWNER_ID,
        EMPLOYEE_USER_ID,
        `privacy-owner-${suffix}@test.local`,
        `privacy-agent-${suffix}@test.local`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES
         (gen_random_uuid()::text, $1, $2, 'owner', true),
         (gen_random_uuid()::text, $1, $3, 'member', true)`,
      [ORG_ID, OWNER_ID, EMPLOYEE_USER_ID],
    );
    await client.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Privacy Employee', $4, 'project_manager',
         'Privacy boundary test employee', 'standard', true, true, $5)`,
      [EMPLOYEE_ID, ORG_ID, EMPLOYEE_USER_ID, `privacy-${suffix}`, OWNER_ID],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES
         ($1, $4, 'privacy-public', 'public', $5),
         ($2, $4, 'privacy-joined', 'private', $5),
         ($3, $4, 'privacy-hidden', 'private', $5)`,
      [
        PUBLIC_SPACE_ID,
        JOINED_PRIVATE_SPACE_ID,
        HIDDEN_PRIVATE_SPACE_ID,
        ORG_ID,
        OWNER_ID,
      ],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES
         (gen_random_uuid()::text, $1, $3),
         (gen_random_uuid()::text, $2, $3),
         (gen_random_uuid()::text, $2, $4)`,
      [PUBLIC_SPACE_ID, JOINED_PRIVATE_SPACE_ID, OWNER_ID, EMPLOYEE_USER_ID],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)`,
      [HIDDEN_PRIVATE_SPACE_ID, OWNER_ID],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES
         (gen_random_uuid()::text, $1, $2, $5, $6),
         (gen_random_uuid()::text, $1, $3, $5, $7),
         (gen_random_uuid()::text, $1, $4, $5, $8)`,
      [
        ORG_ID,
        PUBLIC_SPACE_ID,
        JOINED_PRIVATE_SPACE_ID,
        HIDDEN_PRIVATE_SPACE_ID,
        OWNER_ID,
        `${MARKER} public`,
        `${MARKER} joined private`,
        `${MARKER} hidden private`,
      ],
    );
  });
});

after(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [ORG_ID]);
    await client.query(
      `DELETE FROM space_members WHERE space_id IN ($1, $2, $3)`,
      [PUBLIC_SPACE_ID, JOINED_PRIVATE_SPACE_ID, HIDDEN_PRIVATE_SPACE_ID],
    );
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM agent_employees WHERE id = $1`, [EMPLOYEE_ID]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [OWNER_ID, EMPLOYEE_USER_ID]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
});

test('messages_search hides private spaces the employee has not joined', async () => {
  const ctx: ToolContext = {
    org_id: ORG_ID,
    employee_id: EMPLOYEE_ID,
    employee_slug: `privacy-${suffix}`,
    trust_level: 'standard',
  };

  const result = await messagesSearch({ query: MARKER, limit: 10 }, ctx);
  assert.equal(result.isError, false, result.content[0]?.text);
  const rows = JSON.parse(result.content[0]!.text) as Array<{
    content: string;
    space_name: string;
  }>;

  assert.deepEqual(
    new Set(rows.map((row) => row.space_name)),
    new Set(['privacy-public', 'privacy-joined']),
  );
  assert.ok(rows.every((row) => !row.content.includes('hidden private')));

  const targeted = await messagesSearch(
    { query: MARKER, space_name: 'privacy-hidden', limit: 10 },
    ctx,
  );
  assert.equal(targeted.isError, false, targeted.content[0]?.text);
  assert.deepEqual(JSON.parse(targeted.content[0]!.text), []);
});
