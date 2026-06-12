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
const ORG_SLUG = `oauth-mcp-${TEST_ID.slice(0, 8)}`;
const WIKI_ID = `oauth-mcp-wiki-${TEST_ID}`;
const WIKI_SLUG = `oauth-mcp-salsa-${TEST_ID.slice(0, 8)}`;
const PROJECT_ID = `oauth-mcp-project-${TEST_ID}`;
const TASK_ID = `oauth-mcp-task-${TEST_ID}`;

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
       WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = $1)`,
      [USER_ID],
    );
    await client.query(`DELETE FROM oauth_access_tokens WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM oauth_grants WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM oauth_authorization_codes WHERE user_id = $1`, [USER_ID]);
    await client.query(`DELETE FROM oauth_audit_events WHERE user_id = $1 OR org_id = $2`, [USER_ID, ORG_ID]);
    await client.query(`DELETE FROM oauth_clients WHERE client_name LIKE 'OAuth MCP Test%'`);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM wiki_pages WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
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
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'owner', true)`,
      [`oauth-mcp-member-${TEST_ID}`, ORG_ID, USER_ID],
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
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'OAuth MCP Demo Project', 'OMCP', $3, 1)`,
      [PROJECT_ID, ORG_ID, USER_ID],
    );
    await client.query(
      `INSERT INTO tasks
        (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
       VALUES
        ($1, $2, $3, 1, 'Prepare salsa tasting brief', 'todo', 'p1', $4, $4, false)`,
      [TASK_ID, ORG_ID, PROJECT_ID, USER_ID],
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

async function issueOAuthToken(clientId: string, scopes = ['read:workspace', 'read:wiki']) {
  const verifier = `verifier-${TEST_ID}`;
  const resource = helpers.metadataUrls().resource;
  const { code } = await helpers.createAuthorizationCode({
    orgId: ORG_ID,
    userId: USER_ID,
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

  const authServer = await testApp.request('/.well-known/oauth-authorization-server');
  assert.equal(authServer.status, 200);
  const authBody = (await authServer.json()) as any;
  assert.equal(authBody.registration_endpoint, 'http://localhost:3301/oauth/register');
  assert.equal(authBody.authorization_endpoint, 'http://localhost:3012/oauth/authorize');

  const client = await registerClient();
  assert.ok(client.client_id.startsWith('deft_dcr_'));
  assert.equal(client.scope, 'read:workspace read:wiki');
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
  assert.equal(badAudience.status, 200, 'refresh may issue, but MCP resolver must reject wrong audience');
  const badToken = (await badAudience.json()) as { access_token: string };
  await assert.rejects(
    () => helpers.resolveOAuthAccessToken(badToken.access_token),
    /audience does not match/,
  );

  const revokeRes = await jsonPost('/oauth/revoke', { token: token.access_token });
  assert.equal(revokeRes.status, 200);
  await assert.rejects(
    () => helpers.resolveOAuthAccessToken(token.access_token),
    /Invalid OAuth access token/,
  );
});
