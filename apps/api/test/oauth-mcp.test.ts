import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import dotenv from 'dotenv';

dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });

const oldEnv = {
  DEFT_PUBLIC_URL: process.env.DEFT_PUBLIC_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  API_PORT: process.env.API_PORT,
};

delete process.env.DEFT_PUBLIC_URL;
process.env.API_PORT = '3301';
process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3301';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3012';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const TEST_ID = randomUUID();
const ORG_ID = `oauth-mcp-org-${TEST_ID}`;
const USER_ID = `oauth-mcp-user-${TEST_ID}`;
const OTHER_USER_ID = `oauth-mcp-other-user-${TEST_ID}`;
const ORG_SLUG = `oauth-mcp-${TEST_ID.slice(0, 8)}`;
const WIKI_ID = `oauth-mcp-wiki-${TEST_ID}`;
const WIKI_SLUG = `oauth-mcp-salsa-${TEST_ID.slice(0, 8)}`;
const ATTRIBUTED_WIKI_ID = `oauth-mcp-attributed-wiki-${TEST_ID}`;
const ATTRIBUTED_WIKI_SLUG = `oauth-mcp-defty-audit-${TEST_ID.slice(0, 8)}`;
const ATTRIBUTED_AGENT_EMPLOYEE_ID = `oauth-mcp-agent-${TEST_ID}`;
const ATTRIBUTED_WIKI_PROOF = `DEFTY-AUDIT-WIKI-PROOF-${TEST_ID}`;
const PRIVATE_WIKI_ID = `oauth-mcp-private-wiki-${TEST_ID}`;
const PRIVATE_WIKI_SLUG = `oauth-mcp-private-sauce-${TEST_ID.slice(0, 8)}`;
const PROJECT_ID = `oauth-mcp-project-${TEST_ID}`;
const PRIVATE_PROJECT_ID = `oauth-mcp-private-project-${TEST_ID}`;
const TASK_ID = `oauth-mcp-task-${TEST_ID}`;
const SAVED_VIEW_ID = `oauth-mcp-saved-view-${TEST_ID}`;
const RESTRICTED_TASK_ID = `oauth-mcp-restricted-task-${TEST_ID}`;
const PRIVATE_EVENT_ID = `oauth-mcp-private-event-${TEST_ID}`;
const SPACE_ID = `oauth-mcp-space-${TEST_ID}`;
const MESSAGE_ID = `oauth-mcp-message-${TEST_ID}`;
const UNREAD_MESSAGE_ID = `oauth-mcp-unread-message-${TEST_ID}`;
const PUBLIC_NONMEMBER_SPACE_ID = `oauth-mcp-public-nonmember-space-${TEST_ID}`;
const PRIVATE_SPACE_ID = `oauth-mcp-private-space-${TEST_ID}`;
const PRIVATE_MESSAGE_ID = `oauth-mcp-private-message-${TEST_ID}`;
const PRIVATE_PROOF = `PRIVATE-OAUTH-MCP-PROOF-${TEST_ID}`;
const TEAM_ID = `oauth-mcp-team-${TEST_ID}`;
const TEAM_HANDLE = `oauth-mcp-salsa-ops-${TEST_ID.slice(0, 8)}`;
const NOTE_ID = `oauth-mcp-note-${TEST_ID}`;
const EVENT_ID = `oauth-mcp-event-${TEST_ID}`;
const NOTIFICATION_ID = `oauth-mcp-notification-${TEST_ID}`;
const APPROVAL_ID = `oauth-mcp-approval-${TEST_ID}`;

let testApp: Hono;
let helpers: typeof import('../src/lib/oauth-mcp.js');

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function cleanup() {
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM oauth_refresh_tokens
       WHERE grant_id IN (SELECT id FROM oauth_grants WHERE org_id = $1)`,
      [ORG_ID],
    );
    await client.query(`DELETE FROM oauth_access_tokens WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM oauth_grants WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM oauth_authorization_codes WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM oauth_audit_events WHERE user_id = $1 OR org_id = $2`, [USER_ID, ORG_ID]);
    await client.query(`DELETE FROM oauth_clients WHERE client_name LIKE 'OAuth MCP Test%'`);
    await client.query(`DELETE FROM events WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM notifications WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM action_receipts WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM team_dashboard_snapshots WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM team_resources WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM team_members WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM teams WHERE org_id = $1`, [ORG_ID]);
    await client.query(`UPDATE tasks SET source_message_id = NULL WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)`, [ORG_ID]);
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM task_comments WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM task_activity WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM saved_views WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM agent_nudges WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`, [ORG_ID]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM wiki_citations WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM wiki_ops_log WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM wiki_page_versions WHERE page_id IN (SELECT id FROM wiki_pages WHERE org_id = $1)`, [ORG_ID]);
    await client.query(`DELETE FROM wiki_pages WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE org_id = $1)`, [ORG_ID]);
    await client.query(`DELETE FROM notes WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_ID, OTHER_USER_ID]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
}

async function seedWorkspace() {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'OAuth MCP Test Org', $2)`,
      [ORG_ID, ORG_SLUG],
    );
    await client.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'OAuth MCP User', true)`,
      [USER_ID, `oauth-mcp-${TEST_ID}@test.local`],
    );
    await client.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES ($1, $2, 'OAuth MCP Other User', true)`,
      [OTHER_USER_ID, `oauth-mcp-other-${TEST_ID}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [`oauth-mcp-member-${TEST_ID}`, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'member', true)`,
      [`oauth-mcp-other-member-${TEST_ID}`, ORG_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'OAuth MCP Defty', $4, 'custom', 'test', 'standard',
         true, true, $3)`,
      [ATTRIBUTED_AGENT_EMPLOYEE_ID, ORG_ID, USER_ID, `oauth-mcp-defty-${TEST_ID.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, scope, type, title, slug, summary, content, confidence, version, is_deleted, metadata)
       VALUES
        ($1, $2, 'org', 'decision', 'Salsa demo decision', $3,
         'Use salsa tasting as the demo proof point.',
         'The Testers Tomatoes team decided to use salsa tasting as the public pilot demo proof point.',
         0.95, 1, false, '{}'::jsonb)`,
      [WIKI_ID, ORG_ID, WIKI_SLUG],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, scope, agent_employee_id, type, title, slug, summary, content, confidence, version, is_deleted, metadata)
       VALUES
        ($1, $2, 'org', $3, 'fact', 'Defty audit-attributed org fact', $4,
         $5, $5, 0.92, 1, false, '{}'::jsonb)`,
      [
        ATTRIBUTED_WIKI_ID,
        ORG_ID,
        ATTRIBUTED_AGENT_EMPLOYEE_ID,
        ATTRIBUTED_WIKI_SLUG,
        `${ATTRIBUTED_WIKI_PROOF} shared org knowledge created by Defty`,
      ],
    );
    await client.query(
      `INSERT INTO wiki_pages
        (id, org_id, scope, user_id, type, title, slug, summary, content, confidence, version, is_deleted, metadata)
       VALUES
        ($1, $2, 'user', $3, 'fact', 'Private sauce plan', $4,
         $5, $5, 0.95, 1, false, '{}'::jsonb)`,
      [PRIVATE_WIKI_ID, ORG_ID, OTHER_USER_ID, PRIVATE_WIKI_SLUG, `${PRIVATE_PROOF} private wiki content`],
    );
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'OAuth MCP Demo Project', 'OMCP', $3, 1)`,
      [PROJECT_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO saved_views (id, org_id, project_id, user_id, name, config, is_shared)
       VALUES ($1, $2, $3, $4, 'OAuth P2 view', '{"filters":{"priorities":["p2"]},"columns":["title","priority"]}'::jsonb, false)`,
      [SAVED_VIEW_ID, ORG_ID, PROJECT_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO tasks
        (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
       VALUES
        ($1, $2, $3, 1, 'Prepare salsa tasting brief', 'todo', 'p1', $4, $4, false)`,
      [TASK_ID, ORG_ID, PROJECT_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'OAuth MCP Private Project', 'OMCPX', $3, 1)`,
      [PRIVATE_PROJECT_ID, ORG_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO tasks
        (id, org_id, project_id, number, title, description, status, priority, assignee_id, created_by, is_deleted, metadata)
       VALUES
        ($1, $2, $3, 2, $4, $4, 'todo', 'p1', $5, $5, false, '{"visibility":"restricted"}'::jsonb)`,
      [RESTRICTED_TASK_ID, ORG_ID, PRIVATE_PROJECT_ID, `${PRIVATE_PROOF} restricted task`, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO events
        (id, org_id, source, event_type, title, body, actor, timestamp, metadata, user_id)
       VALUES
        ($1, $2, 'ics', 'calendar_event', $3, $3, 'other user', now(), '{}'::jsonb, $4)`,
      [PRIVATE_EVENT_ID, ORG_ID, `${PRIVATE_PROOF} private calendar event`, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'oauth-mcp-public', 'public', $3)`,
      [SPACE_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3)`,
      [`oauth-mcp-public-space-member-${TEST_ID}`, SPACE_ID, USER_ID],
    );
    await client.query(
      `UPDATE space_members
       SET last_read_at = now() - interval '2 days'
       WHERE space_id = $1 AND user_id = $2`,
      [SPACE_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3)`,
      [`oauth-mcp-public-other-space-member-${TEST_ID}`, SPACE_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, 'Salsa tasting thread for OAuth MCP contract tests')`,
      [MESSAGE_ID, ORG_ID, SPACE_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        UNREAD_MESSAGE_ID,
        ORG_ID,
        SPACE_ID,
        OTHER_USER_ID,
        'OAuth MCP Other User asks OAuth MCP User to review heirloom tomato notes',
      ],
    );
    await client.query(
      `INSERT INTO teams
        (id, org_id, name, handle, description, type, visibility, lead_user_id, default_space_id, created_by)
       VALUES
        ($1, $2, 'Salsa Ops', $3, 'Team context fixture for OAuth MCP contract tests.',
         'functional', 'org', $4, $5, $4)`,
      [TEAM_ID, ORG_ID, TEAM_HANDLE, USER_ID, SPACE_ID],
    );
    await client.query(
      `INSERT INTO team_members (id, org_id, team_id, user_id, role)
       VALUES
        ($1, $2, $3, $4, 'lead'),
        ($5, $2, $3, $6, 'member')`,
      [
        `oauth-mcp-team-lead-${TEST_ID}`,
        ORG_ID,
        TEAM_ID,
        USER_ID,
        `oauth-mcp-team-member-${TEST_ID}`,
        OTHER_USER_ID,
      ],
    );
    await client.query(
      `INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, label, created_by)
       VALUES
        ($1, $2, $3, 'project', $4, 'Demo project', $8),
        ($5, $2, $3, 'space', $6, 'Public discussion space', $8),
        ($7, $2, $3, 'wiki_page', $9, 'Salsa decision wiki', $8)`,
      [
        `oauth-mcp-team-project-${TEST_ID}`,
        ORG_ID,
        TEAM_ID,
        PROJECT_ID,
        `oauth-mcp-team-space-${TEST_ID}`,
        SPACE_ID,
        `oauth-mcp-team-wiki-${TEST_ID}`,
        USER_ID,
        WIKI_ID,
      ],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'oauth-mcp-public-nonmember', 'public', $3)`,
      [PUBLIC_NONMEMBER_SPACE_ID, ORG_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'oauth-mcp-private', 'private', $3)`,
      [PRIVATE_SPACE_ID, ORG_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3)`,
      [`oauth-mcp-private-space-member-${TEST_ID}`, PRIVATE_SPACE_ID, OTHER_USER_ID],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [PRIVATE_MESSAGE_ID, ORG_ID, PRIVATE_SPACE_ID, OTHER_USER_ID, `${PRIVATE_PROOF} private space message`],
    );
    await client.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, visibility)
       VALUES ($1, $2, $3, 'OAuth MCP operator note', '<p>Headless operating note</p>', 'private')`,
      [NOTE_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO events (id, org_id, source, event_type, title, body, actor, timestamp, metadata, user_id)
       VALUES ($1, $2, 'native', 'calendar_event', 'OAuth MCP operating review', 'Review headless parity', 'OAuth MCP User', now() + interval '2 days',
         jsonb_build_object('start', (now() + interval '2 days')::text, 'end', (now() + interval '2 days 1 hour')::text, 'status', 'confirmed'), $3)`,
      [EVENT_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO notifications (id, org_id, user_id, type, title, body, link)
       VALUES ($1, $2, $3, 'system', 'OAuth MCP attention item', 'Inspect this through MCP', '/inbox')`,
      [NOTIFICATION_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, $4, 'post_message', jsonb_build_object('space_id', $5::text, 'content', 'Approval contract fixture'), 'quick', 'pending')`,
      [APPROVAL_ID, ORG_ID, USER_ID, ATTRIBUTED_AGENT_EMPLOYEE_ID, SPACE_ID],
    );
  });
}

before(async () => {
  await cleanup();
  await seedWorkspace();

  helpers = await import('../src/lib/oauth-mcp.js');
  const routes = await import('../src/routes/oauth-mcp.js');
  const mcp = await import('../src/routes/mcp-server-v1.js');

  testApp = new Hono();
  testApp.route('/.well-known', routes.oauthWellKnownRoutes);
  testApp.route('/oauth', routes.oauthPublicRoutes);
  testApp.route('/api/mcp/v1', mcp.mcpServerV1Routes);
});

after(async () => {
  await cleanup();
  if (oldEnv.DEFT_PUBLIC_URL === undefined) delete process.env.DEFT_PUBLIC_URL;
  else process.env.DEFT_PUBLIC_URL = oldEnv.DEFT_PUBLIC_URL;
  if (oldEnv.NEXT_PUBLIC_API_URL === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = oldEnv.NEXT_PUBLIC_API_URL;
  if (oldEnv.NEXT_PUBLIC_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = oldEnv.NEXT_PUBLIC_APP_URL;
  if (oldEnv.API_PORT === undefined) delete process.env.API_PORT;
  else process.env.API_PORT = oldEnv.API_PORT;
});

async function jsonPost(path: string, body: unknown, bearer?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return testApp.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function registerClient() {
  const res = await jsonPost('/oauth/register', {
    client_name: `OAuth MCP Test ${TEST_ID}`,
    redirect_uris: ['http://localhost:3999/callback'],
    scope: 'read:workspace read:wiki write:tasks',
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string; scope: string };
}

async function issueOAuthToken(clientId: string, scopes = ['read:workspace', 'read:wiki'], userId = USER_ID) {
  const verifier = `verifier-${TEST_ID}`;
  const resource = helpers.metadataUrls().resource;
  const { code } = await helpers.createAuthorizationCode({
    orgId: ORG_ID,
    userId,
    clientId,
    redirectUri: 'http://localhost:3999/callback',
    codeChallenge: helpers.pkceS256(verifier),
    codeChallengeMethod: 'S256',
    resource,
    scopes,
  });

  const res = await jsonPost('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: 'http://localhost:3999/callback',
    code_verifier: verifier,
    resource,
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { access_token: string; refresh_token: string; scope: string };
}

test('OAuth metadata and dynamic client registration describe the remote MCP connector', async () => {
  const protectedResource = await testApp.request('/.well-known/oauth-protected-resource');
  assert.equal(protectedResource.status, 200);
  const protectedBody = (await protectedResource.json()) as any;
  assert.equal(protectedBody.resource, 'http://localhost:3301/api/mcp/v1');
  assert.ok(protectedBody.authorization_servers.includes('http://localhost:3301'));
  assert.ok(protectedBody.scopes_supported.includes('write:wiki'));
  assert.equal(protectedBody.scopes_supported.includes('offline_access'), false);

  const authServer = await testApp.request('/.well-known/oauth-authorization-server');
  assert.equal(authServer.status, 200);
  const authBody = (await authServer.json()) as any;
  assert.equal(authBody.registration_endpoint, 'http://localhost:3301/oauth/register');
  assert.equal(authBody.authorization_endpoint, 'http://localhost:3012/oauth/authorize');
  assert.ok(authBody.scopes_supported.includes('write:wiki'));
  assert.ok(authBody.scopes_supported.includes('offline_access'));

  const client = await registerClient();
  assert.ok(client.client_id.startsWith('deft_dcr_'));
  assert.equal(client.scope, 'read:workspace read:wiki write:tasks');

  const wikiClientRes = await jsonPost('/oauth/register', {
    client_name: `OAuth MCP Wiki Writer ${TEST_ID}`,
    redirect_uris: ['http://localhost:3999/callback'],
    scope: 'read:workspace read:wiki write:wiki',
  });
  assert.equal(wikiClientRes.status, 201);
  const wikiClient = (await wikiClientRes.json()) as { client_id: string; scope: string };
  assert.ok(wikiClient.client_id.startsWith('deft_dcr_'));
  assert.equal(wikiClient.scope, 'read:workspace read:wiki write:wiki');

  const refreshClientRes = await jsonPost('/oauth/register', {
    client_name: `OAuth MCP Refresh Client ${TEST_ID}`,
    redirect_uris: ['http://localhost:3999/callback'],
    scope: 'read:workspace offline_access',
  });
  assert.equal(refreshClientRes.status, 201);
  const refreshClient = (await refreshClientRes.json()) as { scope: string };
  assert.equal(refreshClient.scope, 'read:workspace offline_access');
});

test('OAuth PKCE token exchange resolves to a scoped human MCP principal', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace', 'read:wiki']);
  assert.equal(token.scope, 'read:workspace read:wiki');

  const principal = await helpers.resolveOAuthAccessToken(token.access_token);
  assert.equal(principal.kind, 'oauth');
  assert.equal(principal.org_id, ORG_ID);
  assert.equal(principal.user_id, USER_ID);
  assert.deepEqual(principal.scopes, ['read:workspace', 'read:wiki']);
});

test('OAuth bearer can use JSON-RPC MCP read tools but not ungranted write tools', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace', 'read:wiki', 'read:tasks']);

  const listRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }, token.access_token);
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as any;
  const names = new Set<string>(listBody.result.tools.map((tool: any) => tool.name));
  assert.ok(names.has('search'));
  assert.ok(names.has('fetch'));
  assert.ok(names.has('memory_recall'));
  assert.ok(names.has('wiki_search'));
  assert.ok(names.has('list_my_tasks'));
  assert.ok(!names.has('task_create'), 'write tool must be hidden without write:tasks');
  const searchTool = listBody.result.tools.find((tool: any) => tool.name === 'search');
  assert.equal(searchTool.annotations?.readOnlyHint, true);

  const searchRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'search',
      arguments: { query: 'salsa tasting', limit: 5 },
    },
  }, token.access_token);
  assert.equal(searchRes.status, 200);
  const searchBody = (await searchRes.json()) as any;
  assert.equal(searchBody.result.isError, false);
  const results = JSON.parse(searchBody.result.content[0].text);
  assert.ok(results.some((result: any) => result.id === `wiki:${WIKI_SLUG}`));

  const myTasksRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'list_my_tasks',
      arguments: { limit: 10 },
    },
  }, token.access_token);
  assert.equal(myTasksRes.status, 200);
  const myTasksBody = (await myTasksRes.json()) as any;
  assert.equal(myTasksBody.result.isError, false);
  const myTasks = JSON.parse(myTasksBody.result.content[0].text);
  assert.ok(myTasks.some((task: any) => task.id === TASK_ID));
  assert.ok(myTasks.every((task: any) => task.assignee_id === USER_ID));

  const writeRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: { title: 'Should not be created' },
    },
  }, token.access_token);
  assert.equal(writeRes.status, 200);
  const writeBody = (await writeRes.json()) as any;
  assert.equal(writeBody.result.isError, true);
  assert.match(writeBody.result.content[0].text, /Missing MCP scope: write:tasks/);
});

test('OAuth task-helper profile can comment on and update visible tasks', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace', 'read:tasks', 'read:messages', 'write:tasks', 'write:messages']);
  assert.equal(token.scope, 'read:workspace read:tasks read:messages write:tasks write:messages');

  const principal = await helpers.resolveOAuthAccessToken(token.access_token);
  assert.equal(principal.connector_profile, 'task-helper');

  const listRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/list',
    params: {},
  }, token.access_token);
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as any;
  const names = new Set<string>(listBody.result.tools.map((tool: any) => tool.name));
  assert.ok(names.has('task_create'));
  assert.ok(names.has('task_update'));
  assert.ok(names.has('task_transition'));
  assert.ok(names.has('comment_on_task'));
  assert.ok(names.has('message_post'));
  assert.ok(names.has('send_message'));
  assert.ok(names.has('attention_digest'));
  assert.ok(names.has('messages_recent'));
  assert.ok(names.has('resolve_space'));
  assert.ok(names.has('resolve_project'));
  assert.ok(names.has('resolve_member'));
  assert.ok(names.has('resolve_targets'));
  assert.ok(names.has('activity_query'));

  const attentionRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 281,
    method: 'tools/call',
    params: {
      name: 'attention_digest',
      arguments: { limit: 10 },
    },
  }, token.access_token);
  assert.equal(attentionRes.status, 200);
  const attentionBody = (await attentionRes.json()) as any;
  assert.equal(attentionBody.result.isError, false, JSON.stringify(attentionBody));
  const attention = JSON.parse(attentionBody.result.content[0].text);
  assert.ok(
    attention.unread_messages.some((message: any) => message.id === UNREAD_MESSAGE_ID),
    'attention_digest should surface unread messages without keyword search',
  );
  assert.ok(
    attention.assigned_tasks.some((task: any) => task.id === TASK_ID),
    'attention_digest should surface assigned open tasks',
  );

  const recentMessagesRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 282,
    method: 'tools/call',
    params: {
      name: 'messages_recent',
      arguments: { space_name: 'oauth mcp public', limit: 10 },
    },
  }, token.access_token);
  assert.equal(recentMessagesRes.status, 200);
  const recentMessagesBody = (await recentMessagesRes.json()) as any;
  assert.equal(recentMessagesBody.result.isError, false, JSON.stringify(recentMessagesBody));
  const recentMessages = JSON.parse(recentMessagesBody.result.content[0].text);
  assert.ok(
    recentMessages.messages.some((message: any) => message.id === UNREAD_MESSAGE_ID),
    'messages_recent should resolve hyphenated space names from human wording',
  );

  const createArgs = {
    title: `Retry-safe OAuth follow-up ${TEST_ID}`,
    project_id: PROJECT_ID,
    assignee_id: USER_ID,
    priority: 'p2',
    idempotency_key: `create-${TEST_ID}`,
  };
  const createRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 29,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: createArgs,
    },
  }, token.access_token);
  assert.equal(createRes.status, 200);
  const createBody = (await createRes.json()) as any;
  assert.equal(createBody.result.isError, false, JSON.stringify(createBody));
  const createdTask = JSON.parse(createBody.result.content[0].text);
  assert.equal(createdTask.title, createArgs.title);

  const duplicateCreateRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 291,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: createArgs,
    },
  }, token.access_token);
  assert.equal(duplicateCreateRes.status, 200);
  const duplicateCreateBody = (await duplicateCreateRes.json()) as any;
  assert.equal(duplicateCreateBody.result.isError, false, JSON.stringify(duplicateCreateBody));
  const duplicateCreatedTask = JSON.parse(duplicateCreateBody.result.content[0].text);
  assert.equal(duplicateCreatedTask.id, createdTask.id, 'same idempotency key should replay the original task_create result');

  await withClient(async (pgClient) => {
    const count = await pgClient.query(
      `SELECT count(*)::int AS count FROM tasks WHERE org_id = $1 AND title = $2`,
      [ORG_ID, createArgs.title],
    );
    assert.equal(count.rows[0].count, 1, 'idempotent task_create must not create duplicates');
  });

  const fallbackCreateArgs = {
    title: `Fallback duplicate-safe OAuth follow-up ${TEST_ID}`,
    project_id: PROJECT_ID,
    assignee_id: USER_ID,
    priority: 'p3',
    description: 'first no-key create call',
  };
  const fallbackCreateRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 292,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: fallbackCreateArgs,
    },
  }, token.access_token);
  assert.equal(fallbackCreateRes.status, 200);
  const fallbackCreateBody = (await fallbackCreateRes.json()) as any;
  assert.equal(fallbackCreateBody.result.isError, false, JSON.stringify(fallbackCreateBody));
  const fallbackCreatedTask = JSON.parse(fallbackCreateBody.result.content[0].text);

  const fallbackDuplicateCreateRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 293,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: {
        ...fallbackCreateArgs,
        description: 'second no-key create call from the same user intent',
      },
    },
  }, token.access_token);
  assert.equal(fallbackDuplicateCreateRes.status, 200);
  const fallbackDuplicateCreateBody = (await fallbackDuplicateCreateRes.json()) as any;
  assert.equal(fallbackDuplicateCreateBody.result.isError, false, JSON.stringify(fallbackDuplicateCreateBody));
  const fallbackDuplicateTask = JSON.parse(fallbackDuplicateCreateBody.result.content[0].text);
  assert.equal(
    fallbackDuplicateTask.id,
    fallbackCreatedTask.id,
    'fallback duplicate detection should replay the original task_create result even without idempotency_key',
  );

  await withClient(async (pgClient) => {
    const count = await pgClient.query(
      `SELECT count(*)::int AS count FROM tasks WHERE org_id = $1 AND title = $2`,
      [ORG_ID, fallbackCreateArgs.title],
    );
    assert.equal(count.rows[0].count, 1, 'fallback duplicate detection must not create duplicate task rows');
  });

  const richCreateArgs = {
    title: `Rich OAuth MCP task create ${TEST_ID}`,
    project_name: 'OAuth MCP Demo Project',
    assignee_email: `oauth-mcp-other-${TEST_ID}@test.local`,
    priority: 'p1',
    due_date: '2026-07-10T10:00:00.000Z',
    start_date: '2026-07-09T09:00:00.000Z',
    estimation: '2h',
    source_message_id: MESSAGE_ID,
    idempotency_key: `rich-create-${TEST_ID}`,
  };
  const richCreateRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 294,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: richCreateArgs,
    },
  }, token.access_token);
  assert.equal(richCreateRes.status, 200);
  const richCreateBody = (await richCreateRes.json()) as any;
  assert.equal(richCreateBody.result.isError, false, JSON.stringify(richCreateBody));
  const richTask = JSON.parse(richCreateBody.result.content[0].text);
  assert.equal(richTask.project_id, PROJECT_ID);
  assert.equal(richTask.assignee_id, OTHER_USER_ID);
  assert.equal(richTask.source_message_id, MESSAGE_ID);
  assert.equal(richTask.estimation, '2h');
  assert.match(String(richTask.due_date), /^2026-07-10/);

  const commentRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'comment_on_task',
      arguments: {
        task_id: TASK_ID,
        content: 'Codex task-helper contract test comment',
        idempotency_key: `comment-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(commentRes.status, 200);
  const commentBody = (await commentRes.json()) as any;
  assert.equal(commentBody.result.isError, false, JSON.stringify(commentBody));
  const comment = JSON.parse(commentBody.result.content[0].text);
  assert.equal(comment.task_id, TASK_ID);
  assert.equal(comment.user_id, USER_ID);

  const duplicateCommentRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 311,
    method: 'tools/call',
    params: {
      name: 'comment_on_task',
      arguments: {
        task_id: TASK_ID,
        content: 'Codex task-helper contract test comment',
        idempotency_key: `comment-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(duplicateCommentRes.status, 200);
  const duplicateCommentBody = (await duplicateCommentRes.json()) as any;
  assert.equal(duplicateCommentBody.result.isError, false, JSON.stringify(duplicateCommentBody));
  const duplicateComment = JSON.parse(duplicateCommentBody.result.content[0].text);
  assert.equal(duplicateComment.id, comment.id, 'same idempotency key should replay the original comment result');

  const transitionRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: {
      name: 'task_transition',
      arguments: {
        task_id: TASK_ID,
        status: 'in_progress',
        reason: 'contract test starts work',
        idempotency_key: `transition-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(transitionRes.status, 200);
  const transitionBody = (await transitionRes.json()) as any;
  assert.equal(transitionBody.result.isError, false, JSON.stringify(transitionBody));
  const transitionedTask = JSON.parse(transitionBody.result.content[0].text);
  assert.equal(transitionedTask.id, TASK_ID);
  assert.equal(transitionedTask.status, 'in_progress');

  const updateRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 321,
    method: 'tools/call',
    params: {
      name: 'task_update',
      arguments: {
        task_id: TASK_ID,
        patch: { status: 'done' },
        idempotency_key: `update-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(updateRes.status, 200);
  const updateBody = (await updateRes.json()) as any;
  assert.equal(updateBody.result.isError, false, JSON.stringify(updateBody));
  const updatedTask = JSON.parse(updateBody.result.content[0].text);
  assert.equal(updatedTask.id, TASK_ID);
  assert.equal(updatedTask.status, 'done');

  const messageRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 34,
    method: 'tools/call',
    params: {
      name: 'message_post',
      arguments: {
        space_id: SPACE_ID,
        content: 'Codex task-helper contract test completion message',
        idempotency_key: `message-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(messageRes.status, 200);
  const messageBody = (await messageRes.json()) as any;
  assert.equal(messageBody.result.isError, false, JSON.stringify(messageBody));
  const postedMessage = JSON.parse(messageBody.result.content[0].text);
  assert.equal(postedMessage.space_id, SPACE_ID);
  assert.equal(postedMessage.user_id, USER_ID);

  const duplicateMessageRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 341,
    method: 'tools/call',
    params: {
      name: 'message_post',
      arguments: {
        space_id: SPACE_ID,
        content: 'Codex task-helper contract test completion message',
        idempotency_key: `message-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(duplicateMessageRes.status, 200);
  const duplicateMessageBody = (await duplicateMessageRes.json()) as any;
  assert.equal(duplicateMessageBody.result.isError, false, JSON.stringify(duplicateMessageBody));
  const duplicateMessage = JSON.parse(duplicateMessageBody.result.content[0].text);
  assert.equal(duplicateMessage.id, postedMessage.id, 'same idempotency key should replay the original message result');

  const nonmemberMessageRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 343,
    method: 'tools/call',
    params: {
      name: 'message_post',
      arguments: {
        space_id: PUBLIC_NONMEMBER_SPACE_ID,
        content: 'This should not post because the user has not joined the public space',
        idempotency_key: `message-nonmember-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(nonmemberMessageRes.status, 200);
  const nonmemberMessageBody = (await nonmemberMessageRes.json()) as any;
  assert.equal(nonmemberMessageBody.result.isError, true, JSON.stringify(nonmemberMessageBody));
  assert.match(nonmemberMessageBody.result.content[0].text, /not a member/i);

  const sendMessageRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 344,
    method: 'tools/call',
    params: {
      name: 'send_message',
      arguments: {
        email: `oauth-mcp-other-${TEST_ID}@test.local`,
        content: 'Codex human-facing send_message contract test DM',
        idempotency_key: `send-message-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(sendMessageRes.status, 200);
  const sendMessageBody = (await sendMessageRes.json()) as any;
  assert.equal(sendMessageBody.result.isError, false, JSON.stringify(sendMessageBody));
  const sentMessage = JSON.parse(sendMessageBody.result.content[0].text);
  assert.equal(sentMessage.target_kind, 'dm');
  assert.equal(sentMessage.target_user_id, OTHER_USER_ID);
  assert.equal(sentMessage.user_id, USER_ID);

  const sendSpaceMessageRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 3441,
    method: 'tools/call',
    params: {
      name: 'send_message',
      arguments: {
        space_name: 'oauth mcp public',
        content: 'Codex human-facing send_message contract test to a resolved space',
        idempotency_key: `send-space-message-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(sendSpaceMessageRes.status, 200);
  const sendSpaceMessageBody = (await sendSpaceMessageRes.json()) as any;
  assert.equal(sendSpaceMessageBody.result.isError, false, JSON.stringify(sendSpaceMessageBody));
  const sentSpaceMessage = JSON.parse(sendSpaceMessageBody.result.content[0].text);
  assert.equal(sentSpaceMessage.target_kind, 'space');
  assert.equal(sentSpaceMessage.space_id, SPACE_ID);
  assert.equal(sentSpaceMessage.space_name, 'oauth-mcp-public');

  const duplicateSendMessageRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 345,
    method: 'tools/call',
    params: {
      name: 'send_message',
      arguments: {
        email: `oauth-mcp-other-${TEST_ID}@test.local`,
        content: 'Codex human-facing send_message contract test DM',
        idempotency_key: `send-message-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(duplicateSendMessageRes.status, 200);
  const duplicateSendMessageBody = (await duplicateSendMessageRes.json()) as any;
  assert.equal(duplicateSendMessageBody.result.isError, false, JSON.stringify(duplicateSendMessageBody));
  const duplicateSentMessage = JSON.parse(duplicateSendMessageBody.result.content[0].text);
  assert.equal(duplicateSentMessage.id, sentMessage.id, 'send_message should replay with the same idempotency key');

  const activityRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 342,
    method: 'tools/call',
    params: {
      name: 'activity_query',
      arguments: {
        tool_name: 'task_create',
        limit: 10,
      },
    },
  }, token.access_token);
  assert.equal(activityRes.status, 200);
  const activityBody = (await activityRes.json()) as any;
  assert.equal(activityBody.result.isError, false, JSON.stringify(activityBody));
  const activity = JSON.parse(activityBody.result.content[0].text);
  assert.ok(
    activity.some((event: any) => event.event === 'mcp_tool_call' && event.metadata?.tool_name === 'task_create'),
    'activity_query should expose recent task_create audit activity',
  );
  const taskCreateReceipt = activity.find(
    (event: any) => event.event === 'mcp_idempotency_result' && event.metadata?.tool_name === 'task_create' && event.receipt?.title === 'Created task',
  )?.receipt;
  assert.ok(taskCreateReceipt, 'activity_query should return enriched task_create receipts for MCP clients');
  assert.equal(taskCreateReceipt.target_kind, 'task');
  assert.match(taskCreateReceipt.detail, /OMCP-\d+: /);
  assert.match(taskCreateReceipt.href, /^\/tasks\?task=/);

  const blockedRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 33,
    method: 'tools/call',
    params: {
      name: 'task_update',
      arguments: {
        task_id: RESTRICTED_TASK_ID,
        patch: { status: 'done' },
      },
    },
  }, token.access_token);
  assert.equal(blockedRes.status, 200);
  const blockedBody = (await blockedRes.json()) as any;
  assert.equal(blockedBody.result.isError, true, JSON.stringify(blockedBody));
  assert.match(blockedBody.result.content[0].text, /task not found/);
});

test('OAuth wiki_upsert creates or updates durable knowledge instead of duplicating pages', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace', 'read:wiki', 'read:messages', 'write:wiki']);

  const listRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 370,
    method: 'tools/list',
    params: {},
  }, token.access_token);
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as any;
  const names = new Set<string>(listBody.result.tools.map((tool: any) => tool.name));
  assert.ok(names.has('wiki_upsert'));

  const slug = `oauth-mcp-heirloom-${TEST_ID.slice(0, 8)}`;
  const createRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 371,
    method: 'tools/call',
    params: {
      name: 'wiki_upsert',
      arguments: {
        title: `OAuth MCP Heirloom Tomato Notes ${TEST_ID}`,
        slug,
        content: 'Initial heirloom tomato field notes from MCP contract tests.',
        type: 'resource',
        source_message_id: MESSAGE_ID,
        idempotency_key: `wiki-create-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(createRes.status, 200);
  const createBody = (await createRes.json()) as any;
  assert.equal(createBody.result.isError, false, JSON.stringify(createBody));
  const created = JSON.parse(createBody.result.content[0].text);
  assert.equal(created.operation, 'created');
  assert.equal(created.slug, slug);

  const updateRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 372,
    method: 'tools/call',
    params: {
      name: 'wiki_upsert',
      arguments: {
        title: `OAuth MCP Heirloom Tomato Notes ${TEST_ID}`,
        slug,
        content: 'Updated heirloom tomato field notes from MCP contract tests.',
        type: 'resource',
        source_message_id: MESSAGE_ID,
        idempotency_key: `wiki-update-${TEST_ID}`,
      },
    },
  }, token.access_token);
  assert.equal(updateRes.status, 200);
  const updateBody = (await updateRes.json()) as any;
  assert.equal(updateBody.result.isError, false, JSON.stringify(updateBody));
  const updated = JSON.parse(updateBody.result.content[0].text);
  assert.equal(updated.operation, 'updated');
  assert.equal(updated.id, created.id);

  await withClient(async (pgClient) => {
    const pages = await pgClient.query(
      `SELECT id, content, version
       FROM wiki_pages
       WHERE org_id = $1 AND slug = $2`,
      [ORG_ID, slug],
    );
    assert.equal(pages.rowCount, 1, 'wiki_upsert must keep one page per slug');
    assert.match(pages.rows[0].content, /Updated heirloom/);
    assert.ok(Number(pages.rows[0].version) >= 2, 'wiki_upsert update should increment page version');

    const citations = await pgClient.query(
      `SELECT count(*)::int AS count
       FROM wiki_citations
       WHERE org_id = $1 AND page_id = $2 AND source_id = $3`,
      [ORG_ID, created.id, MESSAGE_ID],
    );
    assert.ok(citations.rows[0].count >= 1, 'wiki_upsert should cite the source message when provided');
  });
});

test('OAuth human MCP read tools match user-scoped wiki task and calendar visibility', async () => {
  const client = await registerClient();
  const scopes = ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar'];
  const primaryToken = await issueOAuthToken(client.client_id, scopes, USER_ID);
  const otherToken = await issueOAuthToken(client.client_id, scopes, OTHER_USER_ID);

  async function callTool(accessToken: string, id: number, name: string, args: Record<string, unknown>) {
    const res = await jsonPost('/api/mcp/v1', {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }, accessToken);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.result.isError, false, `${name} should not error: ${JSON.stringify(body)}`);
    return JSON.parse(body.result.content[0].text);
  }

  async function callToolError(accessToken: string, id: number, name: string, args: Record<string, unknown>) {
    const res = await jsonPost('/api/mcp/v1', {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }, accessToken);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.result.isError, true, `${name} should error: ${JSON.stringify(body)}`);
    return body.result.content[0].text as string;
  }

  const primarySearch = await callTool(primaryToken.access_token, 10, 'search', { query: PRIVATE_PROOF, limit: 10 });
  assert.ok(Array.isArray(primarySearch));
  assert.ok(!primarySearch.some((result: any) => [PRIVATE_WIKI_SLUG, RESTRICTED_TASK_ID, PRIVATE_EVENT_ID].some((id) => String(result.id).includes(id))));

  const primaryRecall = await callTool(primaryToken.access_token, 11, 'memory_recall', { query: PRIVATE_PROOF, limit: 10 });
  assert.ok(Array.isArray(primaryRecall));
  assert.ok(!primaryRecall.some((page: any) => page.slug === PRIVATE_WIKI_SLUG));

  const attributedSearch = await callTool(primaryToken.access_token, 111, 'search', { query: ATTRIBUTED_WIKI_PROOF, limit: 10 });
  assert.ok(
    attributedSearch.some((result: any) => result.id === `wiki:${ATTRIBUTED_WIKI_SLUG}`),
    'human MCP search should include Defty-authored org pages that retain agent attribution',
  );

  const attributedRecall = await callTool(primaryToken.access_token, 112, 'memory_recall', { query: ATTRIBUTED_WIKI_PROOF, limit: 10 });
  assert.ok(
    attributedRecall.some((page: any) => page.slug === ATTRIBUTED_WIKI_SLUG),
    'human MCP memory_recall should include Defty-authored org pages that retain agent attribution',
  );

  const attributedFetch = await callTool(primaryToken.access_token, 113, 'fetch', { id: `wiki:${ATTRIBUTED_WIKI_SLUG}` });
  assert.equal(attributedFetch.slug, ATTRIBUTED_WIKI_SLUG);

  const primaryTasks = await callTool(primaryToken.access_token, 12, 'task_query', { limit: 50 });
  assert.ok(!primaryTasks.some((task: any) => task.id === RESTRICTED_TASK_ID));

  const primaryEvents = await callTool(primaryToken.access_token, 13, 'events_query', { limit: 50 });
  assert.ok(!primaryEvents.some((event: any) => event.id === PRIVATE_EVENT_ID));

  const primarySpaces = await callTool(primaryToken.access_token, 131, 'space_list', { limit: 50 });
  assert.ok(!primarySpaces.some((space: any) => space.id === PRIVATE_SPACE_ID));

  const resolvedSpace = await callTool(primaryToken.access_token, 1311, 'resolve_space', { query: 'oauth mcp public', limit: 5 });
  assert.equal(resolvedSpace.status, 'resolved');
  assert.equal(resolvedSpace.selected.id, SPACE_ID);
  assert.equal(resolvedSpace.needs_confirmation, false);
  assert.ok(!resolvedSpace.candidates.some((space: any) => space.id === PRIVATE_SPACE_ID));

  const resolvedMember = await callTool(primaryToken.access_token, 1312, 'resolve_member', { query: 'OAuth MCP Other', limit: 5 });
  assert.equal(resolvedMember.status, 'resolved');
  assert.equal(resolvedMember.selected.id, OTHER_USER_ID);

  const ambiguousMember = await callTool(primaryToken.access_token, 1313, 'resolve_member', { query: 'OAuth MCP', limit: 5 });
  assert.equal(ambiguousMember.status, 'ambiguous');
  assert.equal(ambiguousMember.needs_confirmation, true);
  assert.ok(ambiguousMember.candidates.some((member: any) => member.id === USER_ID));
  assert.ok(ambiguousMember.candidates.some((member: any) => member.id === OTHER_USER_ID));

  const resolvedProject = await callTool(primaryToken.access_token, 1314, 'resolve_project', { query: 'OAuth MCP Demo', limit: 5 });
  assert.equal(resolvedProject.status, 'resolved');
  assert.equal(resolvedProject.selected.id, PROJECT_ID);

  const resolvedTargets = await callTool(primaryToken.access_token, 1315, 'resolve_targets', {
    spaces: ['oauth mcp public'],
    members: ['OAuth MCP Other'],
    projects: ['OAuth MCP Demo'],
    limit: 5,
  });
  assert.equal(resolvedTargets.spaces['oauth mcp public'].status, 'resolved');
  assert.equal(resolvedTargets.spaces['oauth mcp public'].selected.id, SPACE_ID);
  assert.equal(resolvedTargets.members['OAuth MCP Other'].selected.id, OTHER_USER_ID);
  assert.equal(resolvedTargets.projects['OAuth MCP Demo'].selected.id, PROJECT_ID);

  const projectProgress = await callTool(primaryToken.access_token, 132, 'project_progress', { project_identifier: 'OMCP' });
  assert.equal(projectProgress.project.id, PROJECT_ID);
  assert.equal(projectProgress.project.prefix, 'OMCP');
  assert.ok(projectProgress.total_tasks >= 1);
  assert.ok(typeof projectProgress.status_counts === 'object');
  assert.ok(!Array.isArray(projectProgress), 'filtered project_progress should return one project summary, not an org-wide list');

  const projectProgressById = await callTool(primaryToken.access_token, 133, 'project_progress', { project_id: PROJECT_ID });
  assert.equal(projectProgressById.project.id, PROJECT_ID);

  await callToolError(primaryToken.access_token, 14, 'fetch', { id: `wiki:${PRIVATE_WIKI_SLUG}` });
  await callToolError(primaryToken.access_token, 15, 'fetch', { id: `task:${RESTRICTED_TASK_ID}` });
  await callToolError(primaryToken.access_token, 16, 'fetch', { id: `event:${PRIVATE_EVENT_ID}` });
  await callToolError(primaryToken.access_token, 161, 'space_get', { space_id: PRIVATE_SPACE_ID });
  await callToolError(primaryToken.access_token, 162, 'fetch', { id: `message:${PRIVATE_MESSAGE_ID}` });

  const otherRecall = await callTool(otherToken.access_token, 17, 'memory_recall', { query: PRIVATE_PROOF, limit: 10 });
  assert.ok(otherRecall.some((page: any) => page.slug === PRIVATE_WIKI_SLUG), 'own user-scoped wiki page is visible');

  const otherTasks = await callTool(otherToken.access_token, 18, 'task_query', { limit: 50 });
  assert.ok(otherTasks.some((task: any) => task.id === RESTRICTED_TASK_ID), 'own restricted task is visible');

  const otherEvents = await callTool(otherToken.access_token, 19, 'events_query', { limit: 50 });
  assert.ok(otherEvents.some((event: any) => event.id === PRIVATE_EVENT_ID), 'own ICS event is visible');

  const otherSpace = await callTool(otherToken.access_token, 191, 'space_get', { space_id: PRIVATE_SPACE_ID });
  assert.equal(otherSpace.space.id, PRIVATE_SPACE_ID, 'private space is visible to members');
});

test('OAuth tools/list read catalog only advertises callable tools', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar']);

  const listRes = await jsonPost('/api/mcp/v1', {
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/list',
    params: {},
  }, token.access_token);
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as any;
  const tools = listBody.result.tools as Array<{ name: string }>;
  assert.ok(tools.length > 0, 'read catalog is not empty');

  const minimalArgs: Record<string, Record<string, unknown>> = {
    search: { query: 'salsa tasting', limit: 5 },
    fetch: { id: `wiki:${WIKI_SLUG}` },
    platform_context: {},
    attention_digest: { limit: 5 },
    memory_recall: { query: 'salsa tasting', limit: 5 },
    wiki_search: { query: 'salsa tasting', limit: 5 },
    memory_list: { limit: 5 },
    list_my_tasks: { limit: 5 },
    task_get: { task_id: TASK_ID },
    task_query: { limit: 5 },
    task_saved_view_get: { saved_view_id: SAVED_VIEW_ID },
    project_list: { limit: 5 },
    resolve_project: { query: 'OAuth MCP Demo', limit: 5 },
    project_get: { project_id: PROJECT_ID },
    team_list: { query: 'Salsa Ops', limit: 5 },
    team_get: { handle: TEAM_HANDLE },
    team_context: { handle: TEAM_HANDLE, limit: 5 },
    space_list: { limit: 5 },
    resolve_space: { query: 'oauth mcp public', limit: 5 },
    space_get: { space_id: SPACE_ID },
    thread_fetch: { parent_message_id: MESSAGE_ID, limit: 5 },
    member_list: { limit: 5 },
    resolve_member: { query: 'OAuth MCP Other', limit: 5 },
    resolve_targets: { spaces: ['oauth mcp public'], members: ['OAuth MCP Other'], projects: ['OAuth MCP Demo'], limit: 5 },
    member_get: { user_id: USER_ID },
    activity_query: { limit: 5 },
    events_query: { limit: 5 },
    messages_recent: { space_id: SPACE_ID, limit: 5 },
    messages_search: { query: 'salsa', limit: 5 },
    project_progress: { project_id: PROJECT_ID },
    team_workload: { days: 7 },
    workspace_capabilities: {},
    note_list: { limit: 5 },
    note_get: { note_id: NOTE_ID },
    calendar_list: { limit: 5 },
    calendar_get: { event_id: EVENT_ID },
    calendar_availability: {},
    inbox_list: { limit: 5 },
    inbox_get: { notification_id: NOTIFICATION_ID },
    approval_list: { limit: 5 },
    approval_get: { action_id: APPROVAL_ID },
    task_saved_view_list: { limit: 5 },
    agent_employee_list: { limit: 5 },
    agent_employee_get: { employee_id: ATTRIBUTED_AGENT_EMPLOYEE_ID },
  };

  for (const tool of tools) {
    const args = minimalArgs[tool.name];
    assert.ok(args, `test must define minimal args for advertised tool ${tool.name}`);
    const res = await jsonPost('/api/mcp/v1', {
      jsonrpc: '2.0',
      id: `contract-${tool.name}`,
      method: 'tools/call',
      params: { name: tool.name, arguments: args },
    }, token.access_token);
    assert.equal(res.status, 200, `${tool.name} returns HTTP 200`);
    const body = (await res.json()) as any;
    assert.equal(body.result?.isError, false, `${tool.name} should be callable, got ${JSON.stringify(body)}`);
  }
});

test('OAuth operational profile can run reversible owner workflows with receipts and dedupe', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, [
    'read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'read:calendar',
    'write:workspace', 'write:calendar', 'write:tasks', 'write:messages', 'write:wiki',
  ]);
  let requestId = 2000;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await jsonPost('/api/mcp/v1', {
      jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: args },
    }, token.access_token);
    assert.equal(res.status, 200, `${name} returns HTTP 200`);
    const body = (await res.json()) as any;
    assert.equal(body.result?.isError, false, `${name} should succeed: ${JSON.stringify(body)}`);
    return JSON.parse(body.result.content[0].text);
  };

  const capabilities = await call('workspace_capabilities', {});
  assert.equal(capabilities.operationally_headless, true);
  assert.ok(capabilities.available_tools.includes('note_create'));
  assert.ok(capabilities.available_tools.includes('calendar_event_create'));
  assert.ok(capabilities.ui_only.includes('initial workspace authentication and connector authorization'));

  const noteArgs = { title: 'MCP weekly operator note', content: '<p>One operating record</p>', visibility: 'private' };
  const firstNote = await call('note_create', noteArgs);
  const replayedNote = await call('note_create', noteArgs);
  assert.equal(replayedNote.note.id, firstNote.note.id, 'fallback dedupe replays an identical create intent');
  assert.match(firstNote.url, /^\/notes\?note=/);
  const updatedNote = await call('note_update', { note_id: firstNote.note.id, content: '<p>Updated operating record</p>', idempotency_key: `note-update-${TEST_ID}` });
  assert.equal(updatedNote.note.version, 2);

  const start = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  const calendar = await call('calendar_event_create', { title: 'Headless owner review', start: start.toISOString(), end: end.toISOString(), idempotency_key: `event-create-${TEST_ID}` });
  assert.match(calendar.url, /^\/calendar\?event=/);
  const calendarUpdate = await call('calendar_event_update', { event_id: calendar.event.id, title: 'Headless owner review updated', idempotency_key: `event-update-${TEST_ID}` });
  assert.equal(calendarUpdate.event.title, 'Headless owner review updated');
  const cancelled = await call('calendar_event_cancel', { event_id: calendar.event.id, idempotency_key: `event-cancel-${TEST_ID}` });
  assert.equal(cancelled.cancelled, true);

  const inbox = await call('inbox_mark_read', { notification_id: NOTIFICATION_ID, idempotency_key: `inbox-${TEST_ID}` });
  assert.equal(inbox.notification.is_read, true);
  const rejected = await call('approval_reject', { action_id: APPROVAL_ID, reason: 'Contract verification', idempotency_key: `approval-${TEST_ID}` });
  assert.ok(['rejected', 'ok'].includes(rejected.status) || rejected.approval_status === 'rejected');

  const prefix = `H${TEST_ID.replace(/-/g, '').slice(0, 4)}`.toUpperCase();
  const createdProject = await call('project_create', { name: 'Headless MCP Operations', prefix, idempotency_key: `project-create-${TEST_ID}` });
  assert.match(createdProject.url, /^\/tasks\?project=/);
  const updatedProject = await call('project_update', { project_id: createdProject.project.id, description: 'Managed through one MCP connection', idempotency_key: `project-update-${TEST_ID}` });
  assert.equal(updatedProject.project.description, 'Managed through one MCP connection');
  const archivedProject = await call('project_archive', { project_id: createdProject.project.id, archived: true, idempotency_key: `project-archive-${TEST_ID}` });
  assert.equal(archivedProject.archived, true);

  const savedView = await call('task_saved_view_create', { name: 'Owner attention', project_id: PROJECT_ID, config: { filters: { priorities: ['p1'] }, columns: ['title', 'priority'] }, idempotency_key: `view-${TEST_ID}` });
  assert.equal(savedView.created, true);
  const paused = await call('agent_employee_update_state', { employee_id: ATTRIBUTED_AGENT_EMPLOYEE_ID, state: 'paused', idempotency_key: `agent-pause-${TEST_ID}` });
  assert.equal(paused.employee.is_active, false);
  const resumed = await call('agent_employee_update_state', { employee_id: ATTRIBUTED_AGENT_EMPLOYEE_ID, state: 'active', idempotency_key: `agent-resume-${TEST_ID}` });
  assert.equal(resumed.employee.is_active, true);

  const archivedNote = await call('note_archive', { note_id: firstNote.note.id, idempotency_key: `note-archive-${TEST_ID}` });
  assert.equal(archivedNote.archived, true);
});

test('OAuth refresh tokens rotate and reject replay', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace']);

  const refreshed = await jsonPost('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: token.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const refreshedBody = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.ok(refreshedBody.access_token);
  assert.ok(refreshedBody.refresh_token);
  assert.notEqual(refreshedBody.refresh_token, token.refresh_token);

  const replay = await jsonPost('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: token.refresh_token,
  });
  assert.equal(replay.status, 400);
  const replayBody = (await replay.json()) as { error: string };
  assert.equal(replayBody.error, 'invalid_grant');

  const secondRefresh = await jsonPost('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: refreshedBody.refresh_token,
  });
  assert.equal(secondRefresh.status, 200);
});

test('OAuth token audience and revocation are enforced', async () => {
  const client = await registerClient();
  const token = await issueOAuthToken(client.client_id, ['read:workspace']);

  const badAudience = await jsonPost('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    resource: 'https://elsewhere.example/api/mcp/v1',
  });
  assert.equal(badAudience.status, 400, 'refresh must reject wrong resource before issuing a token');
  const badAudienceBody = (await badAudience.json()) as { error: string };
  assert.equal(badAudienceBody.error, 'invalid_target');

  const revokeRes = await jsonPost('/oauth/revoke', { token: token.access_token });
  assert.equal(revokeRes.status, 200);
  await assert.rejects(
    () => helpers.resolveOAuthAccessToken(token.access_token),
    /Invalid OAuth access token/,
  );
});
