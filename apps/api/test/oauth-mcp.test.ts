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
const PRIVATE_WIKI_ID = `oauth-mcp-private-wiki-${TEST_ID}`;
const PRIVATE_WIKI_SLUG = `oauth-mcp-private-sauce-${TEST_ID.slice(0, 8)}`;
const PROJECT_ID = `oauth-mcp-project-${TEST_ID}`;
const PRIVATE_PROJECT_ID = `oauth-mcp-private-project-${TEST_ID}`;
const TASK_ID = `oauth-mcp-task-${TEST_ID}`;
const RESTRICTED_TASK_ID = `oauth-mcp-restricted-task-${TEST_ID}`;
const PRIVATE_EVENT_ID = `oauth-mcp-private-event-${TEST_ID}`;
const SPACE_ID = `oauth-mcp-space-${TEST_ID}`;
const MESSAGE_ID = `oauth-mcp-message-${TEST_ID}`;
const PUBLIC_NONMEMBER_SPACE_ID = `oauth-mcp-public-nonmember-space-${TEST_ID}`;
const PRIVATE_SPACE_ID = `oauth-mcp-private-space-${TEST_ID}`;
const PRIVATE_MESSAGE_ID = `oauth-mcp-private-message-${TEST_ID}`;
const PRIVATE_PROOF = `PRIVATE-OAUTH-MCP-PROOF-${TEST_ID}`;

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
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM space_members WHERE space_id IN ($1, $2, $3)`, [SPACE_ID, PRIVATE_SPACE_ID, PUBLIC_NONMEMBER_SPACE_ID]);
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM task_comments WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM task_activity WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM wiki_pages WHERE org_id = $1`, [ORG_ID]);
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
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, 'Salsa tasting thread for OAuth MCP contract tests')`,
      [MESSAGE_ID, ORG_ID, SPACE_ID, USER_ID],
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

  const authServer = await testApp.request('/.well-known/oauth-authorization-server');
  assert.equal(authServer.status, 200);
  const authBody = (await authServer.json()) as any;
  assert.equal(authBody.registration_endpoint, 'http://localhost:3301/oauth/register');
  assert.equal(authBody.authorization_endpoint, 'http://localhost:3012/oauth/authorize');

  const client = await registerClient();
  assert.ok(client.client_id.startsWith('deft_dcr_'));
  assert.equal(client.scope, 'read:workspace read:wiki write:tasks');
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
  assert.ok(names.has('activity_query'));

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

  const primaryTasks = await callTool(primaryToken.access_token, 12, 'task_query', { limit: 50 });
  assert.ok(!primaryTasks.some((task: any) => task.id === RESTRICTED_TASK_ID));

  const primaryEvents = await callTool(primaryToken.access_token, 13, 'events_query', { limit: 50 });
  assert.ok(!primaryEvents.some((event: any) => event.id === PRIVATE_EVENT_ID));

  const primarySpaces = await callTool(primaryToken.access_token, 131, 'space_list', { limit: 50 });
  assert.ok(!primarySpaces.some((space: any) => space.id === PRIVATE_SPACE_ID));

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
    memory_recall: { query: 'salsa tasting', limit: 5 },
    wiki_search: { query: 'salsa tasting', limit: 5 },
    memory_list: { limit: 5 },
    list_my_tasks: { limit: 5 },
    task_get: { task_id: TASK_ID },
    task_query: { limit: 5 },
    project_list: { limit: 5 },
    project_get: { project_id: PROJECT_ID },
    space_list: { limit: 5 },
    space_get: { space_id: SPACE_ID },
    thread_fetch: { parent_message_id: MESSAGE_ID, limit: 5 },
    member_list: { limit: 5 },
    member_get: { user_id: USER_ID },
    activity_query: { limit: 5 },
    events_query: { limit: 5 },
    messages_search: { query: 'salsa', limit: 5 },
    project_progress: { project_id: PROJECT_ID },
    team_workload: { days: 7 },
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
