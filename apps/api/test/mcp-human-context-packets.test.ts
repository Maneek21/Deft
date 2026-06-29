import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const orgId = randomUUID();
const userId = randomUUID();
const spaceId = randomUUID();
const messageId = randomUUID();
const pageIds = {
  company: randomUUID(),
  channelOrigin: randomUUID(),
  citationOnly: randomUUID(),
  personal: randomUUID(),
};
const tokenIds: string[] = [];
const queryTerm = `humanctx${Date.now()}`;

let rawToken = '';
let app: Hono;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const response = await app.request('/api/mcp/v1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${rawToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, `${name} should return 200`);
  const body = (await response.json()) as any;
  assert.ok(!body.error, `${name} should not return JSON-RPC error: ${JSON.stringify(body)}`);
  assert.ok(!body.result?.isError, `${name} should not return tool error: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0].text);
}

before(async () => {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug, timezone)
       VALUES ($1, 'Human MCP Context Packets Org', $2, 'UTC')`,
      [orgId, `human-mcp-context-${Date.now()}`],
    );
    await client.query(
      `INSERT INTO users (id, email, name, kind, email_verified)
       VALUES ($1, $2, 'Human MCP Tester', 'human', true)`,
      [userId, `human-mcp-context-${Date.now()}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [randomUUID(), orgId, userId],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'human-mcp-channel', 'public', $3)`,
      [spaceId, orgId, userId],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3)`,
      [randomUUID(), spaceId, userId],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, orgId, spaceId, userId, `Human MCP ${queryTerm} source message`],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, type, scope, title, slug, summary, content, confidence, is_deleted)
       VALUES
        ($1, $2, 'fact', 'org', $3, $4, $5, $6, 0.81, false)`,
      [
        pageIds.company,
        orgId,
        `Company ${queryTerm} Memory`,
        `company-${queryTerm}`,
        `Company summary ${queryTerm}`,
        `Company body ${queryTerm}`,
      ],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, type, scope, title, slug, summary, content, confidence, origin_space_id, created_via, is_deleted)
       VALUES
        ($1, $2, 'procedure', 'org', $3, $4, $5, $6, 0.99, $7, 'test_channel_origin', false)`,
      [
        pageIds.channelOrigin,
        orgId,
        `Channel Origin ${queryTerm} Memory`,
        `channel-origin-${queryTerm}`,
        `Channel origin summary ${queryTerm}`,
        `Channel origin body ${queryTerm}`,
        spaceId,
      ],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, type, scope, title, slug, summary, content, confidence, is_deleted)
       VALUES
        ($1, $2, 'resource', 'org', $3, $4, $5, $6, 0.98, false)`,
      [
        pageIds.citationOnly,
        orgId,
        `Citation Linked ${queryTerm} Memory`,
        `citation-linked-${queryTerm}`,
        `Citation linked summary ${queryTerm}`,
        `Citation linked body ${queryTerm}`,
      ],
    );
    await client.query(
      `INSERT INTO wiki_citations
        (id, org_id, page_id, source_type, source_id, source_space_id, source_user_id, excerpt)
       VALUES ($1, $2, $3, 'message', $4, $5, $6, $7)`,
      [
        randomUUID(),
        orgId,
        pageIds.citationOnly,
        messageId,
        spaceId,
        userId,
        `Citation excerpt ${queryTerm}`,
      ],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, user_id, type, scope, title, slug, summary, content, confidence, is_deleted)
       VALUES
        ($1, $2, $3, 'fact', 'user', $4, $5, $6, $7, 0.97, false)`,
      [
        pageIds.personal,
        orgId,
        userId,
        `Personal ${queryTerm} Memory`,
        `personal-${queryTerm}`,
        `Personal summary ${queryTerm}`,
        `Personal body ${queryTerm}`,
      ],
    );
    await client.query(
      `UPDATE wiki_pages
       SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = ANY($1::text[])`,
      [Object.values(pageIds)],
    );
  });

  const issued = await issuePersonalMcpToken({
    orgId,
    userId,
    createdBy: userId,
    name: 'Human MCP context packet regression',
    scopes: ['read:workspace', 'read:wiki', 'read:messages', 'write:tasks', 'write:messages'],
  });
  rawToken = issued.raw;
  tokenIds.push(issued.tokenId);

  app = new Hono();
  app.route('/api/mcp/v1', mcpServerV1Routes);
});

after(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM oauth_audit_events WHERE org_id = $1`, [orgId]);
    if (tokenIds.length > 0) {
      await client.query(`DELETE FROM mcp_tokens WHERE id = ANY($1::text[])`, [tokenIds]);
    }
    await client.query(`DELETE FROM wiki_pages WHERE id = ANY($1::text[])`, [Object.values(pageIds)]);
    await client.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
    await client.query(`DELETE FROM space_members WHERE space_id = $1`, [spaceId]);
    await client.query(`DELETE FROM spaces WHERE id = $1`, [spaceId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('personal MCP platform_context returns company, channel, and personal packets', async () => {
  const payload = await mcpCall('platform_context', {
    trigger: {
      kind: 'channel_wake',
      space_id: spaceId,
    },
  });

  assert.equal(payload.mcp_principal, 'human');
  assert.equal(payload.trigger_context.space_id, spaceId);
  assert.ok(Array.isArray(payload.context_packets), 'context_packets should be present');

  const company = payload.context_packets.find((packet: any) => packet.id === 'company_memory');
  const channel = payload.context_packets.find((packet: any) => packet.id === `space:${spaceId}:memory`);
  const personal = payload.context_packets.find((packet: any) => packet.id === 'personal_memory');

  assert.ok(company, 'company packet exists');
  assert.ok(channel, 'channel packet exists');
  assert.ok(personal, 'personal packet exists');
  assert.ok(company.items.some((item: any) => item.title === `Company ${queryTerm} Memory`), 'company packet contains company memory');
  assert.ok(channel.items.some((item: any) => item.title === `Channel Origin ${queryTerm} Memory`), 'channel packet contains origin-space memory');
  assert.ok(channel.items.some((item: any) => item.title === `Citation Linked ${queryTerm} Memory`), 'channel packet contains citation-linked memory');
  assert.ok(personal.items.some((item: any) => item.title === `Personal ${queryTerm} Memory`), 'personal packet contains user memory');
});

test('personal MCP memory_recall can request channel-only context', async () => {
  const channelOnly = await mcpCall('memory_recall', {
    query: queryTerm,
    space_id: spaceId,
    include_org: false,
    limit: 10,
  });
  const titles = channelOnly.map((item: any) => item.title);

  assert.ok(titles.includes(`Channel Origin ${queryTerm} Memory`), 'channel-only recall includes origin-space memory');
  assert.ok(titles.includes(`Citation Linked ${queryTerm} Memory`), 'channel-only recall includes citation-linked memory');
  assert.ok(!titles.includes(`Company ${queryTerm} Memory`), 'channel-only recall excludes unrelated company memory');
});
