import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { messagesSearch } from '../src/lib/mcp-tools/reports.js';
import {
  _clearPlatformContextCache,
  platformContext,
} from '../src/lib/mcp-tools/context.js';
import { spaceMemoryGet, spaceMemorySet } from '../src/lib/mcp-tools/space-memory.js';
import { executeSendMessage, sendMessage } from '../src/lib/mcp-tools/writes.js';
import { executeWikiCreate, executeWikiUpdate } from '../src/lib/mcp-tools/wiki-create.js';
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
const PUBLIC_MESSAGE_ID = `mcp-privacy-public-message-${suffix}`;
const JOINED_PRIVATE_MESSAGE_ID = `mcp-privacy-joined-message-${suffix}`;
const HIDDEN_PRIVATE_MESSAGE_ID = `mcp-privacy-hidden-message-${suffix}`;
const HIDDEN_WIKI_PAGE_ID = `mcp-privacy-hidden-wiki-${suffix}`;
const MARKER = `mcp-privacy-marker-${suffix}`;

const ctx: ToolContext = {
  org_id: ORG_ID,
  employee_id: EMPLOYEE_ID,
  employee_slug: `privacy-${suffix}`,
  trust_level: 'standard',
};

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
         ($6, $1, $2, $5, $9),
         ($7, $1, $3, $5, $10),
         ($8, $1, $4, $5, $11)`,
      [
        ORG_ID,
        PUBLIC_SPACE_ID,
        JOINED_PRIVATE_SPACE_ID,
        HIDDEN_PRIVATE_SPACE_ID,
        OWNER_ID,
        PUBLIC_MESSAGE_ID,
        JOINED_PRIVATE_MESSAGE_ID,
        HIDDEN_PRIVATE_MESSAGE_ID,
        `${MARKER} public`,
        `${MARKER} joined private`,
        `${MARKER} hidden private`,
      ],
    );
    await client.query(
      `INSERT INTO space_memory
         (id, org_id, space_id, key, value, updated_by_employee_id)
       VALUES (gen_random_uuid()::text, $1, $2, 'hidden-key', $3::jsonb, $4)`,
      [ORG_ID, HIDDEN_PRIVATE_SPACE_ID, JSON.stringify({ secret: MARKER }), EMPLOYEE_ID],
    );
    await client.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, content, space_id, is_deleted)
       VALUES ($1, $2, 'fact', 'space', 'Hidden privacy page', $3, $4, $5, false)`,
      [
        HIDDEN_WIKI_PAGE_ID,
        ORG_ID,
        `hidden-privacy-page-${suffix}`,
        `${MARKER} hidden wiki content`,
        HIDDEN_PRIVATE_SPACE_ID,
      ],
    );
  });
});

after(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM wiki_pages WHERE id = $1`, [HIDDEN_WIKI_PAGE_ID]);
    await client.query(`DELETE FROM space_memory WHERE org_id = $1`, [ORG_ID]);
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

test('platform_context accepts public and joined-private trigger context', async () => {
  _clearPlatformContextCache();
  const publicResult = await platformContext(
    {
      caller_employee_slug: ctx.employee_slug,
      trigger: {
        kind: 'message',
        space_id: PUBLIC_SPACE_ID,
        triggering_message_id: PUBLIC_MESSAGE_ID,
      },
    },
    ctx,
  );
  assert.equal(publicResult.isError, false, publicResult.content[0]?.text);

  _clearPlatformContextCache();
  const privateResult = await platformContext(
    {
      caller_employee_slug: ctx.employee_slug,
      trigger: {
        kind: 'message',
        space_id: JOINED_PRIVATE_SPACE_ID,
        triggering_message_id: JOINED_PRIVATE_MESSAGE_ID,
      },
    },
    ctx,
  );
  assert.equal(privateResult.isError, false, privateResult.content[0]?.text);
});

test('platform_context rejects hidden private trigger context by space or message id', async () => {
  _clearPlatformContextCache();
  const hiddenSpaceResult = await platformContext(
    {
      caller_employee_slug: ctx.employee_slug,
      trigger: { kind: 'channel_wake', space_id: HIDDEN_PRIVATE_SPACE_ID },
    },
    ctx,
  );
  assert.equal(hiddenSpaceResult.isError, true);
  assert.match(hiddenSpaceResult.content[0]!.text, /do not have access/i);

  _clearPlatformContextCache();
  const hiddenMessageResult = await platformContext(
    {
      caller_employee_slug: ctx.employee_slug,
      trigger: { kind: 'message', triggering_message_id: HIDDEN_PRIVATE_MESSAGE_ID },
    },
    ctx,
  );
  assert.equal(hiddenMessageResult.isError, true);
  assert.match(hiddenMessageResult.content[0]!.text, /do not have access/i);
});

test('platform_context rejects a message and space pair that do not match', async () => {
  _clearPlatformContextCache();
  const result = await platformContext(
    {
      caller_employee_slug: ctx.employee_slug,
      trigger: {
        kind: 'message',
        space_id: JOINED_PRIVATE_SPACE_ID,
        triggering_message_id: PUBLIC_MESSAGE_ID,
      },
    },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /does not belong/i);
});

test('space memory cannot be read or written in an unjoined private space', async () => {
  const getResult = await spaceMemoryGet(
    {
      caller_employee_slug: ctx.employee_slug,
      space_id: HIDDEN_PRIVATE_SPACE_ID,
      key: 'hidden-key',
    },
    ctx,
  );
  assert.equal(getResult.isError, true);
  assert.doesNotMatch(getResult.content[0]!.text, new RegExp(MARKER));

  const setResult = await spaceMemorySet(
    {
      caller_employee_slug: ctx.employee_slug,
      space_id: HIDDEN_PRIVATE_SPACE_ID,
      key: 'injected-key',
      value: { injected: true },
    },
    ctx,
  );
  assert.equal(setResult.isError, true);
});

test('message proposals and approved execution cannot target an unjoined private space', async () => {
  const proposed = await sendMessage(
    {
      caller_employee_slug: ctx.employee_slug,
      target: { space_id: HIDDEN_PRIVATE_SPACE_ID },
      content: 'This must not be queued or posted.',
    },
    ctx,
  );
  assert.equal(proposed.isError, true);

  const executed = await executeSendMessage({
    orgId: ORG_ID,
    spaceId: HIDDEN_PRIVATE_SPACE_ID,
    content: 'This must not be posted by an old approval row.',
    parentId: null,
    ctx,
  });
  assert.equal(executed.isError, true);

  const hiddenMessageCount = await withClient(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM messages
       WHERE org_id = $1 AND space_id = $2 AND user_id = $3`,
      [ORG_ID, HIDDEN_PRIVATE_SPACE_ID, EMPLOYEE_USER_ID],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
  assert.equal(hiddenMessageCount, 0);
});

test('space-scoped wiki writes cannot target an unjoined private space', async () => {
  const createResult = await executeWikiCreate(
    {
      caller_employee_slug: ctx.employee_slug,
      title: 'Attempted hidden page',
      content: 'This should never be written.',
      scope: 'space',
      space_id: HIDDEN_PRIVATE_SPACE_ID,
    },
    ctx,
  );
  assert.equal(createResult.isError, true);

  const updateResult = await executeWikiUpdate(
    {
      caller_employee_slug: ctx.employee_slug,
      page_id: HIDDEN_WIKI_PAGE_ID,
      patch: { summary: 'This should never be written.' },
    },
    ctx,
  );
  assert.equal(updateResult.isError, true);
  assert.match(updateResult.content[0]!.text, /page not found/i);
});
