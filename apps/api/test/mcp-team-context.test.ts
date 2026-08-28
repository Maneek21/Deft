import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hono } from 'hono';
import { issueEmployeeToken, issuePersonalMcpToken } from '../src/lib/mcp-token.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { _clearPlatformContextCache } from '../src/lib/mcp-tools/context.js';
import {
  teamContext,
  teamGet,
  teamList,
} from '../src/lib/mcp-tools/team-context.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const runId = randomUUID();
const orgId = randomUUID();
const userId = randomUUID();
const agentUserId = randomUUID();
const outsiderId = randomUUID();
const agentEmployeeId = randomUUID();
const teamId = randomUUID();
const privateTeamId = randomUUID();
const projectId = randomUUID();
const taskOneId = randomUUID();
const taskTwoId = randomUUID();
const spaceId = randomUUID();
const wikiId = randomUUID();
const noteId = randomUUID();
const feedId = randomUUID();
const tokenIds: string[] = [];

const agentSlug = `mcp-team-agent-${runId.slice(0, 8)}`;
let humanToken = '';
let workspaceOnlyToken = '';
let agentToken = '';
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

async function jsonRpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await app.request('/api/mcp/v1', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  assert.equal(response.status, 200, `${method} should return 200`);
  const body = (await response.json()) as any;
  assert.ok(!body.error, `${method} should not return JSON-RPC error: ${JSON.stringify(body)}`);
  return body.result;
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const result = await jsonRpc(token, 'tools/call', { name, arguments: args });
  assert.ok(!result.isError, `${name} should not return tool error: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}

before(async () => {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO orgs (id, name, slug, timezone)
       VALUES ($1, 'MCP Team Context Org', $2, 'UTC')`,
      [orgId, `mcp-team-${runId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO users (id, email, name, kind, is_agent, title, email_verified)
       VALUES
        ($1, $2, 'Diego MCP Team Tester', 'human', false, 'Owner operator', true),
        ($3, $4, 'Team Context Agent', 'agent', true, 'AI teammate', true),
        ($5, $6, 'Outsider Human', 'human', false, 'Viewer', true)`,
      [
        userId,
        `mcp-team-human-${runId}@test.local`,
        agentUserId,
        `mcp-team-agent-${runId}@test.local`,
        outsiderId,
        `mcp-team-outsider-${runId}@test.local`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES
        ($1, $2, $3, 'member', true),
        ($4, $2, $5, 'member', true),
        ($6, $2, $7, 'member', true)`,
      [randomUUID(), orgId, userId, randomUUID(), agentUserId, randomUUID(), outsiderId],
    );
    await client.query(
      `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, runtime_kind, created_by)
       VALUES ($1, $2, $3, 'Team Context Agent', $4, 'custom', 'Handle team context.', 'standard', 'custom_mcp', $5)`,
      [agentEmployeeId, orgId, agentUserId, agentSlug, userId],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by, description)
       VALUES ($1, $2, 'mcp-team-launch', 'public', $3, 'Launch team conversation')`,
      [spaceId, orgId, userId],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES ($1, $2, $3), ($4, $2, $5)`,
      [randomUUID(), spaceId, userId, randomUUID(), agentUserId],
    );
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'MCP Team Launch Project', 'MTL', $3, 2)`,
      [projectId, orgId, userId],
    );
    await client.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, due_date)
       VALUES
        ($1, $2, $3, 1, 'Prepare harvest buyer briefing', 'todo', 'p1', $4, $4, now() + interval '2 days'),
        ($5, $2, $3, 2, 'Review heirloom tomato wiki packet', 'in_progress', 'p2', $6, $4, now() + interval '4 days')`,
      [taskOneId, orgId, projectId, userId, taskTwoId, agentUserId],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, 'Team launch context: buyers need a harvest readiness update tomorrow.')`,
      [randomUUID(), orgId, spaceId, userId],
    );
    await client.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, summary, content, confidence, is_deleted)
       VALUES ($1, $2, 'resource', 'org', 'Team Heirloom Tomato Guide', $3, 'Growing notes for team context.', 'Longer guide body.', 0.95, false)`,
      [wikiId, orgId, `team-heirloom-${runId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, visibility)
       VALUES ($1, $2, $3, 'Launch Team Field Note', '<p>Field observations.</p>', 'org')`,
      [noteId, orgId, userId],
    );
    await client.query(
      `INSERT INTO ics_subscriptions (id, org_id, user_id, ics_url, label, is_active)
       VALUES ($1, $2, $3, 'https://calendar.example.test/team.ics', 'Team calendar', true)`,
      [feedId, orgId, userId],
    );
    await client.query(
      `INSERT INTO teams (id, org_id, name, handle, description, visibility, lead_user_id, default_space_id, created_by)
       VALUES
        ($1, $2, 'MCP Launch Team', 'mcp-launch-team', 'Team with linked MCP context.', 'org', $3, $4, $3),
        ($5, $2, 'Secret Finance Team', 'secret-finance-team', 'Private team hidden from normal members.', 'private', $6, NULL, $3)`,
      [teamId, orgId, userId, spaceId, privateTeamId, outsiderId],
    );
    await client.query(
      `INSERT INTO team_members (id, org_id, team_id, user_id, role)
       VALUES
        ($1, $2, $3, $4, 'lead'),
        ($5, $2, $3, $6, 'viewer'),
        ($7, $2, $8, $9, 'lead')`,
      [randomUUID(), orgId, teamId, userId, randomUUID(), agentUserId, randomUUID(), privateTeamId, outsiderId],
    );
    const resources: Array<[string, string, string]> = [
      ['project', projectId, 'Launch project'],
      ['space', spaceId, 'Launch space'],
      ['wiki_page', wikiId, 'Heirloom guide'],
      ['note', noteId, 'Field note'],
      ['calendar_feed', feedId, 'Team calendar'],
      ['agent_employee', agentEmployeeId, 'AI teammate'],
    ];
    for (const [type, id, label] of resources) {
      await client.query(
        `INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, label, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), orgId, teamId, type, id, label, userId],
      );
    }
  });

  const human = await issuePersonalMcpToken({
    orgId,
    userId,
    createdBy: userId,
    name: 'MCP team context full token',
    scopes: ['read:workspace', 'read:tasks', 'read:messages', 'read:wiki'],
  });
  const workspaceOnly = await issuePersonalMcpToken({
    orgId,
    userId,
    createdBy: userId,
    name: 'MCP team context workspace token',
    scopes: ['read:workspace'],
  });
  humanToken = human.raw;
  workspaceOnlyToken = workspaceOnly.raw;
  tokenIds.push(human.tokenId, workspaceOnly.tokenId);
  agentToken = await issueEmployeeToken(orgId, agentEmployeeId);
  app = new Hono();
  app.route('/api/mcp/v1', mcpServerV1Routes);
});

after(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM oauth_audit_events WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_mcp_call_audit WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM mcp_tokens WHERE org_id = $1 OR id = ANY($2::text[])`, [orgId, tokenIds]);
    await client.query(`DELETE FROM team_resources WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM team_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM teams WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM space_members WHERE space_id = $1`, [spaceId]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM wiki_pages WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM notes WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM ics_subscriptions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[userId, agentUserId, outsiderId]]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('personal and agent MCP catalogs advertise team context tools', async () => {
  const humanList = await jsonRpc(humanToken, 'tools/list');
  const humanNames = new Set(humanList.tools.map((tool: any) => tool.name));
  assert.ok(humanNames.has('team_list'));
  assert.ok(humanNames.has('team_get'));
  assert.ok(humanNames.has('team_context'));

  const agentList = await jsonRpc(agentToken, 'tools/list');
  const agentNames = new Set(agentList.tools.map((tool: any) => tool.name));
  assert.ok(agentNames.has('team_list'));
  assert.ok(agentNames.has('team_get'));
  assert.ok(agentNames.has('team_context'));
});

test('personal MCP team tools resolve visible team context and hide private teams', async () => {
  const list = await callTool(humanToken, 'team_list', { query: 'launch', limit: 10 });
  assert.equal(list.count, 1);
  assert.equal(list.teams[0].handle, 'mcp-launch-team');
  assert.equal(list.teams.some((team: any) => team.handle === 'secret-finance-team'), false);

  const profile = await callTool(humanToken, 'team_get', { handle: 'mcp-launch-team' });
  assert.equal(profile.status, 'resolved');
  assert.ok(profile.members.some((member: any) => member.user_id === agentUserId && member.kind === 'agent'));
  assert.ok(profile.resources.some((resource: any) => resource.type === 'wiki_page' && resource.metadata?.title === 'Team Heirloom Tomato Guide'));

  const context = await callTool(humanToken, 'team_context', { handle: 'mcp-launch-team', limit: 10 });
  assert.equal(context.status, 'resolved');
  assert.equal(context.work.tasks.open_count, 2);
  assert.equal(context.work.tasks.by_status.todo, 1);
  assert.ok(context.work.tasks.top_open.some((task: any) => task.key === 'MTL-1'));
  assert.ok(context.work.recent_messages.some((message: any) => message.preview.includes('harvest readiness')));

  const privateResult = await callTool(humanToken, 'team_get', { handle: 'secret-finance-team' });
  assert.equal(privateResult.status, 'not_found');
});

test('workspace-only personal MCP team_context withholds task, message, and wiki details', async () => {
  const context = await callTool(workspaceOnlyToken, 'team_context', { handle: 'mcp-launch-team', limit: 10 });
  assert.equal(context.status, 'resolved');
  assert.equal(context.work.tasks.open_count, 0);
  assert.deepEqual(context.work.recent_messages, []);
  const wikiResource = context.resources.find((resource: any) => resource.type === 'wiki_page');
  assert.ok(wikiResource, 'wiki resource relation still exists');
  assert.equal(wikiResource.metadata, null, 'wiki metadata requires read:wiki');
});

test('agent employee MCP team_context returns linked work using caller slug', async () => {
  const context = await callTool(agentToken, 'team_context', {
    caller_employee_slug: agentSlug,
    handle: 'mcp-launch-team',
    limit: 10,
  });
  assert.equal(context.status, 'resolved');
  assert.equal(context.team.handle, 'mcp-launch-team');
  assert.ok(context.members.some((member: any) => member.user_id === agentUserId && member.kind === 'agent'));
  assert.equal(context.work.tasks.open_count, 2);
});

test('agent project allowlist filters platform and team project/task context while null and [] remain unrestricted', async () => {
  const otherProjectId = randomUUID();
  const otherTaskId = randomUUID();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'Restricted Team Project', 'RTP', $3, 1)`,
      [otherProjectId, orgId, userId],
    );
    await client.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by)
       VALUES ($1, $2, $3, 1, 'Hidden cross-project task', 'todo', 'p0', $4)`,
      [otherTaskId, orgId, otherProjectId, userId],
    );
    await client.query(
      `INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, label, created_by)
       VALUES ($1, $2, $3, 'project', $4, 'Restricted linked project', $5)`,
      [randomUUID(), orgId, teamId, otherProjectId, userId],
    );
    await client.query(
      `UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [agentEmployeeId, projectId],
    );
  });

  _clearPlatformContextCache();
  const platform = await callTool(agentToken, 'platform_context', { caller_employee_slug: agentSlug });
  assert.deepEqual(platform.active_projects.map((project: any) => project.id), [projectId]);
  const teamSummary = platform.teams.find((team: any) => team.id === teamId);
  assert.equal(teamSummary.resources_by_type.project, 1);
  assert.equal(teamSummary.resource_count, 6, 'restricted project link must not contribute to summary counts');

  const profile = await callTool(agentToken, 'team_get', {
    caller_employee_slug: agentSlug,
    handle: 'mcp-launch-team',
  });
  const linkedProjects = profile.resources.filter((resource: any) => resource.type === 'project');
  assert.deepEqual(linkedProjects.map((resource: any) => resource.resource_id), [projectId]);

  const restrictedContext = await callTool(agentToken, 'team_context', {
    caller_employee_slug: agentSlug,
    handle: 'mcp-launch-team',
    limit: 10,
  });
  assert.equal(restrictedContext.work.tasks.linked_project_count, 1);
  assert.equal(restrictedContext.work.tasks.open_count, 2);
  assert.equal(
    restrictedContext.work.tasks.top_open.some((task: any) => task.id === otherTaskId),
    false,
  );

  for (const unrestrictedValue of [null, []]) {
    await withClient(async (client) => {
      await client.query('UPDATE agent_employees SET project_ids = $2 WHERE id = $1', [
        agentEmployeeId,
        unrestrictedValue,
      ]);
    });
    _clearPlatformContextCache();
    const unrestricted = await callTool(agentToken, 'team_context', {
      caller_employee_slug: agentSlug,
      handle: 'mcp-launch-team',
      limit: 10,
    });
    assert.equal(unrestricted.work.tasks.linked_project_count, 2);
    assert.equal(unrestricted.work.tasks.open_count, 3);
    assert.ok(unrestricted.work.tasks.top_open.some((task: any) => task.id === otherTaskId));
    assert.ok(
      unrestricted.resources.some(
        (resource: any) => resource.type === 'project' && resource.resource_id === otherProjectId,
      ),
    );
  }
});

test('agent team summaries and work context exclude soft-deleted linked projects', async () => {
  const deletedProjectId = randomUUID();
  const deletedTaskId = randomUUID();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter, is_deleted)
       VALUES ($1, $2, 'Soft-deleted Team Project', 'DTP', $3, 1, true)`,
      [deletedProjectId, orgId, userId],
    );
    await client.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by)
       VALUES ($1, $2, $3, 1, 'Task under soft-deleted team project', 'todo', 'p0', $4)`,
      [deletedTaskId, orgId, deletedProjectId, userId],
    );
    await client.query(
      `INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, label, created_by)
       VALUES ($1, $2, $3, 'project', $4, 'Soft-deleted linked project', $5)`,
      [randomUUID(), orgId, teamId, deletedProjectId, userId],
    );
    await client.query(
      `UPDATE agent_employees SET project_ids = ARRAY[$2, $3]::text[] WHERE id = $1`,
      [agentEmployeeId, projectId, deletedProjectId],
    );
  });

  const list = await callTool(agentToken, 'team_list', {
    caller_employee_slug: agentSlug,
    query: 'launch',
    limit: 10,
  });
  assert.equal(list.teams[0].resources_by_type.project, 1);
  assert.equal(list.teams[0].resource_count, 6);

  const profile = await callTool(agentToken, 'team_get', {
    caller_employee_slug: agentSlug,
    handle: 'mcp-launch-team',
  });
  assert.equal(
    profile.resources.some(
      (resource: any) => resource.type === 'project' && resource.resource_id === deletedProjectId,
    ),
    false,
  );

  const context = await callTool(agentToken, 'team_context', {
    caller_employee_slug: agentSlug,
    handle: 'mcp-launch-team',
    limit: 10,
  });
  assert.equal(context.work.tasks.linked_project_count, 1);
  assert.equal(context.work.tasks.open_count, 2);
  assert.equal(context.work.tasks.top_open.some((task: any) => task.id === deletedTaskId), false);

  await withClient((client) => client.query(
    `UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1`,
    [agentEmployeeId, projectId],
  ));
});

test('team tools fail closed for inactive and deleted employee principals', async () => {
  const ctx: ToolContext = {
    org_id: orgId,
    employee_id: agentEmployeeId,
    employee_slug: agentSlug,
    trust_level: 'standard',
  };
  const calls = [
    () => teamList({ limit: 10 }, ctx),
    () => teamGet({ handle: 'mcp-launch-team' }, ctx),
    () => teamContext({ handle: 'mcp-launch-team', limit: 10 }, ctx),
  ];

  for (const state of [
    { is_active: false, is_deleted: false },
    { is_active: true, is_deleted: true },
  ]) {
    await withClient((client) => client.query(
      `UPDATE agent_employees SET is_active = $2, is_deleted = $3 WHERE id = $1`,
      [agentEmployeeId, state.is_active, state.is_deleted],
    ));
    for (const call of calls) {
      const result = await call();
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? '', /caller employee not found/);
      assert.doesNotMatch(result.content[0]?.text ?? '', /MCP Launch Team|harvest|Heirloom/);
    }
  }

  await withClient((client) => client.query(
    `UPDATE agent_employees SET is_active = true, is_deleted = false WHERE id = $1`,
    [agentEmployeeId],
  ));
});
