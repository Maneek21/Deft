import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import dotenv from 'dotenv';
import { mcpAccessRoutes } from '../src/routes/mcp-access.js';

dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const TEST_ID = randomUUID();
const ORG_ID = `mcp-access-history-org-${TEST_ID}`;
const USER_ID = `mcp-access-history-user-${TEST_ID}`;
const ORG_SLUG = `mcp-access-history-${TEST_ID.slice(0, 8)}`;
const PROJECT_ID = `mcp-access-history-project-${TEST_ID}`;
const TASK_ID = `mcp-access-history-task-${TEST_ID}`;
const SPACE_ID = `mcp-access-history-space-${TEST_ID}`;
const MESSAGE_ID = `mcp-access-history-message-${TEST_ID}`;
const ACTIVE_TOKEN_ID = `mcp-access-history-active-token-${TEST_ID}`;
const REVOKED_TOKEN_ID = `mcp-access-history-revoked-token-${TEST_ID}`;
const GRANT_ID = `mcp-access-history-grant-${TEST_ID}`;
const CLIENT_ID = `mcp-access-history-client-${TEST_ID}`;

let testApp: Hono;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function toolResult(content: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(content) }],
  };
}

async function cleanup() {
  await withClient(async (client) => {
    await client.query(`DELETE FROM oauth_audit_events WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM oauth_access_tokens WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM oauth_grants WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM mcp_tokens WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM space_members WHERE space_id = $1`, [SPACE_ID]);
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM task_activity WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
}

async function seedWorkspace() {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'MCP Access History Test Org', $2)`,
      [ORG_ID, ORG_SLUG],
    );
    await client.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'MCP Access History User', true)`,
      [USER_ID, `mcp-access-history-${TEST_ID}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [`mcp-access-history-member-${TEST_ID}`, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'Launch Proof Project', 'MKT', $3, 7)`,
      [PROJECT_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO tasks
        (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
       VALUES
        ($1, $2, $3, 7, 'Receipt polish launch blocker', 'done', 'p1', $4, $4, false)`,
      [TASK_ID, ORG_ID, PROJECT_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'launch', 'public', $3)`,
      [SPACE_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3)`,
      [`mcp-access-history-space-member-${TEST_ID}`, SPACE_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, 'Receipt polish dogfood complete from MCP history test')`,
      [MESSAGE_ID, ORG_ID, SPACE_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO mcp_tokens
        (id, org_id, user_id, principal_kind, name, token_hash, token_prefix, scopes, last_used_at, created_by)
       VALUES
        ($1, $2, $3, 'human', 'Active MCP app', 'active-hash-$1', 'dft_active', ARRAY['read:workspace','write:tasks','write:messages'], now(), $3),
        ($4, $2, $3, 'human', 'Revoked MCP app', 'revoked-hash-$4', 'dft_revoked', ARRAY['read:workspace','write:tasks','write:messages'], now(), $3)`,
      [ACTIVE_TOKEN_ID, ORG_ID, USER_ID, REVOKED_TOKEN_ID],
    );
    await client.query(
      `UPDATE mcp_tokens SET revoked_at = now() WHERE id = $1`,
      [REVOKED_TOKEN_ID],
    );
    await client.query(
      `INSERT INTO oauth_grants
        (id, org_id, user_id, client_id, app_name, connector_profile, scopes, revoked_at)
       VALUES
        ($1, $2, $3, $4, 'Codex Test Client', 'agentic-work', ARRAY['read:workspace','write:tasks'], now())`,
      [GRANT_ID, ORG_ID, USER_ID, CLIENT_ID],
    );
    await client.query(
      `INSERT INTO oauth_access_tokens
        (id, token_hash, grant_id, org_id, user_id, client_id, resource, scopes, expires_at, last_used_at, revoked_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, 'http://localhost:3301/api/mcp/v1', ARRAY['read:workspace','write:tasks'], now() + interval '1 hour', now(), now())`,
      [`mcp-access-history-access-token-${TEST_ID}`, `access-token-hash-${TEST_ID}`, GRANT_ID, ORG_ID, USER_ID, CLIENT_ID],
    );

    const activeTaskMetadata = {
      tool_name: 'task_create',
      result: toolResult({ id: TASK_ID, title: 'Receipt polish launch blocker' }),
    };
    const activeMessageMetadata = {
      tool_name: 'message_post',
      result: toolResult({
        id: MESSAGE_ID,
        space_id: SPACE_ID,
        content: 'Receipt polish dogfood complete from MCP history test',
      }),
    };
    const revokedTaskMetadata = {
      tool_name: 'task_transition',
      result: toolResult({
        id: TASK_ID,
        transition: { from: 'in_review', to: 'done' },
      }),
    };
    const revokedGrantMetadata = {
      grant_id: GRANT_ID,
      tool_name: 'task_update',
      result: toolResult({
        id: TASK_ID,
        title: 'Receipt polish launch blocker',
      }),
    };

    await client.query(
      `INSERT INTO oauth_audit_events (id, org_id, user_id, client_id, event, metadata, created_at)
       VALUES
        ($1, $2, $3, $4, 'mcp_idempotency_result', $5::jsonb, now() - interval '4 minutes'),
        ($6, $2, $3, $4, 'mcp_idempotency_result', $7::jsonb, now() - interval '3 minutes'),
        ($8, $2, $3, $9, 'mcp_idempotency_result', $10::jsonb, now() - interval '2 minutes'),
        ($11, $2, $3, $9, 'token_revoked', $12::jsonb, now() - interval '1 minute'),
        ($13, $2, $3, $14, 'mcp_idempotency_result', $15::jsonb, now() - interval '2 minutes'),
        ($16, $2, $3, $14, 'grant_revoked', $17::jsonb, now() - interval '1 minute')`,
      [
        `mcp-access-history-active-task-event-${TEST_ID}`,
        ORG_ID,
        USER_ID,
        `personal-token:${ACTIVE_TOKEN_ID}`,
        JSON.stringify(activeTaskMetadata),
        `mcp-access-history-active-message-event-${TEST_ID}`,
        JSON.stringify(activeMessageMetadata),
        `mcp-access-history-revoked-task-event-${TEST_ID}`,
        `personal-token:${REVOKED_TOKEN_ID}`,
        JSON.stringify(revokedTaskMetadata),
        `mcp-access-history-revoked-token-event-${TEST_ID}`,
        JSON.stringify({ token_id: REVOKED_TOKEN_ID, surface: 'mcp-access' }),
        `mcp-access-history-revoked-grant-task-event-${TEST_ID}`,
        CLIENT_ID,
        JSON.stringify(revokedGrantMetadata),
        `mcp-access-history-revoked-grant-event-${TEST_ID}`,
        JSON.stringify({ grant_id: GRANT_ID, surface: 'oauth-mcp' }),
      ],
    );
  });
}

before(async () => {
  await cleanup();
  await seedWorkspace();
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: USER_ID,
      org_id: ORG_ID,
      email: `mcp-access-history-${TEST_ID}@test.local`,
      name: 'MCP Access History User',
    } as never);
    await next();
  });
  testApp.route('/api/mcp-access', mcpAccessRoutes);
});

after(async () => {
  await cleanup();
});

test('active personal MCP tokens include enriched task and message receipts', async () => {
  const res = await testApp.request('/api/mcp-access/tokens');
  assert.equal(res.status, 200);
  const body = await res.json() as {
    tokens: Array<{
      id: string;
      recent_actions: Array<{
        event: string;
        receipt: { title: string; detail: string; href?: string; target_kind?: string };
      }>;
    }>;
  };

  assert.equal(body.tokens.length, 1);
  assert.equal(body.tokens[0]?.id, ACTIVE_TOKEN_ID);

  const receipts = body.tokens[0]?.recent_actions.map((action) => action.receipt) ?? [];
  const taskReceipt = receipts.find((receipt) => receipt.title === 'Created task');
  assert.ok(taskReceipt);
  assert.equal(taskReceipt.target_kind, 'task');
  assert.match(taskReceipt.detail, /MKT-7: Receipt polish launch blocker/);
  assert.equal(taskReceipt.href, `/tasks?task=${encodeURIComponent(TASK_ID)}`);

  const messageReceipt = receipts.find((receipt) => receipt.title === 'Posted message');
  assert.ok(messageReceipt);
  assert.equal(messageReceipt.target_kind, 'message');
  assert.match(messageReceipt.detail, /#launch: Receipt polish dogfood complete/);
  assert.equal(
    messageReceipt.href,
    `/chat?space=${encodeURIComponent(SPACE_ID)}&message=${encodeURIComponent(MESSAGE_ID)}`,
  );
});

test('history endpoint returns revoked token and OAuth grant receipts with enriched targets', async () => {
  const res = await testApp.request('/api/mcp-access/history');
  assert.equal(res.status, 200);
  const body = await res.json() as {
    revoked_tokens: Array<{
      id: string;
      recent_actions: Array<{ event: string; receipt: { title: string; detail: string; href?: string } }>;
    }>;
    revoked_grants: Array<{
      id: string;
      last_used_at: string | null;
      recent_actions: Array<{ event: string; receipt: { title: string; detail: string; href?: string } }>;
    }>;
  };

  assert.equal(body.revoked_tokens.length, 1);
  assert.equal(body.revoked_tokens[0]?.id, REVOKED_TOKEN_ID);
  const revokedTokenReceipts = body.revoked_tokens[0]?.recent_actions.map((action) => action.receipt) ?? [];
  assert.ok(revokedTokenReceipts.find((receipt) => receipt.title === 'Token revoked'));
  const transitionReceipt = revokedTokenReceipts.find((receipt) => receipt.title === 'Changed task status');
  assert.ok(transitionReceipt);
  assert.match(transitionReceipt.detail, /MKT-7: in_review -> done/);
  assert.equal(transitionReceipt.href, `/tasks?task=${encodeURIComponent(TASK_ID)}`);

  assert.equal(body.revoked_grants.length, 1);
  assert.equal(body.revoked_grants[0]?.id, GRANT_ID);
  assert.ok(body.revoked_grants[0]?.last_used_at);
  const revokedGrantReceipts = body.revoked_grants[0]?.recent_actions.map((action) => action.receipt) ?? [];
  assert.ok(revokedGrantReceipts.find((receipt) => receipt.title === 'App connection revoked'));
  const grantTaskReceipt = revokedGrantReceipts.find((receipt) => receipt.title === 'Updated task');
  assert.ok(grantTaskReceipt);
  assert.match(grantTaskReceipt.detail, /MKT-7: Receipt polish launch blocker/);
  assert.equal(grantTaskReceipt.href, `/tasks?task=${encodeURIComponent(TASK_ID)}`);
});
