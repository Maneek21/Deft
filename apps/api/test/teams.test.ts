import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth.js';
import { teamRoutes } from '../src/routes/teams.js';
import { env } from '../src/lib/env.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const app = new Hono();
app.use('/api/*', authMiddleware);
app.route('/api/teams', teamRoutes);

const RUN_ID = crypto.randomUUID();
const ORG_ID = crypto.randomUUID();
const OTHER_ORG_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();
const LEAD_ID = crypto.randomUUID();
const MEMBER_ID = crypto.randomUUID();
const TARGET_ID = crypto.randomUUID();
const AGENT_USER_ID = crypto.randomUUID();
const AGENT_EMPLOYEE_ID = crypto.randomUUID();
const INACTIVE_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const TEAM_ID = crypto.randomUUID();
const PRIVATE_TEAM_ID = crypto.randomUUID();
const OTHER_TEAM_ID = crypto.randomUUID();
const SPACE_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const OTHER_PROJECT_ID = crypto.randomUUID();
const OVERDUE_TASK_ID = crypto.randomUUID();
const REVIEW_TASK_ID = crypto.randomUUID();

function token(userId: string, orgId = ORG_ID, email = `${userId}@test.local`) {
  return jwt.sign({ id: userId, email, org_id: orgId }, env.JWT_SECRET, { expiresIn: '15m' });
}

async function authed(path: string, userId: string, init: RequestInit = {}, orgId = ORG_ID) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token(userId, orgId)}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    }),
  );
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'Teams Loop Org', $2), ($3, 'Other Teams Org', $4)`,
      [ORG_ID, `teams-loop-${RUN_ID.slice(0, 8)}`, OTHER_ORG_ID, `teams-other-${RUN_ID.slice(0, 8)}`],
    );

    await c.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES
        ($1, $2, 'Admin User', true),
        ($3, $4, 'Lead User', true),
        ($5, $6, 'Member User', true),
        ($7, $8, 'Target User', true),
        ($9, $10, 'Agent User', true),
        ($11, $12, 'Inactive User', true),
        ($13, $14, 'Other User', true)`,
      [
        ADMIN_ID,
        `teams-admin-${RUN_ID}@test.local`,
        LEAD_ID,
        `teams-lead-${RUN_ID}@test.local`,
        MEMBER_ID,
        `teams-member-${RUN_ID}@test.local`,
        TARGET_ID,
        `teams-target-${RUN_ID}@test.local`,
        AGENT_USER_ID,
        `teams-agent-${RUN_ID}@test.local`,
        INACTIVE_ID,
        `teams-inactive-${RUN_ID}@test.local`,
        OTHER_USER_ID,
        `teams-other-user-${RUN_ID}@test.local`,
      ],
    );

    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES
        ($1, $2, $3, 'admin', true),
        ($4, $2, $5, 'member', true),
        ($6, $2, $7, 'member', true),
        ($8, $2, $9, 'member', true),
        ($10, $2, $11, 'member', true),
        ($12, $2, $13, 'member', false),
        ($14, $15, $16, 'admin', true)`,
      [
        crypto.randomUUID(),
        ORG_ID,
        ADMIN_ID,
        crypto.randomUUID(),
        LEAD_ID,
        crypto.randomUUID(),
        MEMBER_ID,
        crypto.randomUUID(),
        TARGET_ID,
        crypto.randomUUID(),
        AGENT_USER_ID,
        crypto.randomUUID(),
        INACTIVE_ID,
        crypto.randomUUID(),
        OTHER_ORG_ID,
        OTHER_USER_ID,
      ],
    );

    await c.query(
      `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, created_by)
       VALUES ($1, $2, $3, 'Teams Agent', $4, 'custom', 'Assist the launch team.', $5)`,
      [AGENT_EMPLOYEE_ID, ORG_ID, AGENT_USER_ID, `teams-agent-${RUN_ID.slice(0, 8)}`, ADMIN_ID],
    );

    await c.query(
      `INSERT INTO spaces (id, org_id, name, created_by, is_default)
       VALUES ($1, $2, 'teams-loop-space', $3, true)`,
      [SPACE_ID, ORG_ID, ADMIN_ID],
    );
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES
        ($1, $2, 'Teams Loop Project', 'TLP', $3, 0),
        ($4, $5, 'Other Project', 'OTP', $6, 0)`,
      [PROJECT_ID, ORG_ID, ADMIN_ID, OTHER_PROJECT_ID, OTHER_ORG_ID, OTHER_USER_ID],
    );
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, due_date)
       VALUES
        ($1, $2, $3, 1, 'Fix launch handoff', 'todo', 'p1', $4, $5, now() - interval '1 day'),
        ($6, $2, $3, 2, 'Review buyer update copy', 'in_review', 'p2', $7, $5, now() + interval '3 days')`,
      [OVERDUE_TASK_ID, ORG_ID, PROJECT_ID, LEAD_ID, ADMIN_ID, REVIEW_TASK_ID, MEMBER_ID],
    );

    await c.query(
      `INSERT INTO teams (id, org_id, name, handle, description, visibility, lead_user_id, default_space_id, created_by)
       VALUES
        ($1, $2, 'Launch Team', 'launch-team', 'Public launch team', 'org', $3, $4, $5),
        ($6, $2, 'Private Finance', 'private-finance', 'Hidden from non-members', 'private', $3, NULL, $5),
        ($7, $8, 'Other Org Team', 'other-org-team', 'Cross-org fixture', 'org', $9, NULL, $9)`,
      [TEAM_ID, ORG_ID, LEAD_ID, SPACE_ID, ADMIN_ID, PRIVATE_TEAM_ID, OTHER_TEAM_ID, OTHER_ORG_ID, OTHER_USER_ID],
    );
    await c.query(
      `INSERT INTO team_members (id, org_id, team_id, user_id, role)
       VALUES
        ($1, $2, $3, $4, 'lead'),
        ($5, $2, $3, $6, 'member'),
        ($7, $2, $8, $4, 'lead')`,
      [crypto.randomUUID(), ORG_ID, TEAM_ID, LEAD_ID, crypto.randomUUID(), MEMBER_ID, crypto.randomUUID(), PRIVATE_TEAM_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM team_dashboard_snapshots WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM team_resources WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM team_members WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM teams WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM agent_employees WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM tasks WHERE id IN ($1, $2)`, [OVERDUE_TASK_ID, REVIEW_TASK_ID]);
    await c.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await c.query(`DELETE FROM spaces WHERE id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM org_members WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN_ID, LEAD_ID, MEMBER_ID, TARGET_ID, AGENT_USER_ID, INACTIVE_ID, OTHER_USER_ID]]);
    await c.query(`DELETE FROM orgs WHERE id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
  });
});

describe('Loop 3 teams API', () => {
  test('lists org-visible teams but hides private teams from non-members', async () => {
    const res = await authed('/api/teams', TARGET_ID);
    assert.equal(res.status, 200);
    const rows = await res.json() as Array<{ id: string; handle: string }>;
    assert.ok(rows.some((row) => row.id === TEAM_ID));
    assert.equal(rows.some((row) => row.id === PRIVATE_TEAM_ID), false);

    const adminRes = await authed('/api/teams', ADMIN_ID);
    const adminRows = await adminRes.json() as Array<{ id: string; handle: string }>;
    assert.ok(adminRows.some((row) => row.id === PRIVATE_TEAM_ID));
  });

  test('private team detail is visible only to members, leads, and admins', async () => {
    const outsider = await authed(`/api/teams/${PRIVATE_TEAM_ID}`, TARGET_ID);
    assert.equal(outsider.status, 404);
    assert.equal((await outsider.json() as { code: string }).code, 'NOT_FOUND');

    const lead = await authed(`/api/teams/${PRIVATE_TEAM_ID}`, LEAD_ID);
    assert.equal(lead.status, 200);
    const leadBody = await lead.json() as { team: { id: string; visibility: string }; members: Array<{ user_id: string }> };
    assert.equal(leadBody.team.id, PRIVATE_TEAM_ID);
    assert.equal(leadBody.team.visibility, 'private');
    assert.ok(leadBody.members.some((row) => row.user_id === LEAD_ID));

    const admin = await authed(`/api/teams/${PRIVATE_TEAM_ID}`, ADMIN_ID);
    assert.equal(admin.status, 200);
  });

  test('team detail does not leak cross-org teams', async () => {
    const res = await authed(`/api/teams/${OTHER_TEAM_ID}`, ADMIN_ID);
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { code: string }).code, 'NOT_FOUND');
  });

  test('non-admin members cannot create teams', async () => {
    const res = await authed('/api/teams', MEMBER_ID, {
      method: 'POST',
      body: JSON.stringify({ name: 'Unauthorized Team', handle: 'unauthorized-team' }),
    });
    assert.equal(res.status, 403);
  });

  test('admins create teams with active leads and initial members', async () => {
    const res = await authed('/api/teams', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Buyer Success',
        handle: 'buyer-success',
        lead_user_id: LEAD_ID,
        member_ids: [MEMBER_ID],
        default_space_id: SPACE_ID,
      }),
    });
    const body = await res.json() as { id: string; handle: string };
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.handle, 'buyer-success');

    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT role, count(*)::int AS count
         FROM team_members
         WHERE team_id = $1
         GROUP BY role
         ORDER BY role`,
        [body.id],
      );
      assert.deepEqual(rows.map((row) => [row.role, row.count]), [['lead', 1], ['member', 1]]);
    });
  });

  test('team creation rejects inactive or cross-org members', async () => {
    const inactive = await authed('/api/teams', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad Team', handle: 'bad-team', member_ids: [INACTIVE_ID] }),
    });
    assert.equal(inactive.status, 400);
    assert.equal((await inactive.json() as { code: string }).code, 'INVALID_MEMBERS');

    const crossOrg = await authed('/api/teams', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({ name: 'Other User Team', handle: 'other-user-team', lead_user_id: OTHER_USER_ID }),
    });
    assert.equal(crossOrg.status, 400);
    assert.equal((await crossOrg.json() as { code: string }).code, 'INVALID_MEMBERS');
  });

  test('team leads can manage their team but regular members cannot', async () => {
    const memberRes = await authed(`/api/teams/${TEAM_ID}/members`, MEMBER_ID, {
      method: 'POST',
      body: JSON.stringify({ user_id: TARGET_ID, role: 'member' }),
    });
    assert.equal(memberRes.status, 403);

    const leadRes = await authed(`/api/teams/${TEAM_ID}/members`, LEAD_ID, {
      method: 'POST',
      body: JSON.stringify({ user_id: TARGET_ID, role: 'viewer' }),
    });
    const body = await leadRes.json() as { user_id: string; role: string };
    assert.equal(leadRes.status, 201, JSON.stringify(body));
    assert.equal(body.user_id, TARGET_ID);
    assert.equal(body.role, 'viewer');
  });

  test('team updates reject ignored membership payloads and support lead transfer', async () => {
    const rejected = await authed(`/api/teams/${TEAM_ID}`, LEAD_ID, {
      method: 'PATCH',
      body: JSON.stringify({ member_ids: [TARGET_ID] }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { code: string }).code, 'VALIDATION_ERROR');

    const updated = await authed(`/api/teams/${TEAM_ID}`, LEAD_ID, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Launch Command', lead_user_id: TARGET_ID }),
    });
    const body = await updated.json() as { name: string; lead_user_id: string };
    assert.equal(updated.status, 200, JSON.stringify(body));
    assert.equal(body.name, 'Launch Command');
    assert.equal(body.lead_user_id, TARGET_ID);

    const detail = await authed(`/api/teams/${TEAM_ID}`, TARGET_ID);
    const detailBody = await detail.json() as { members: Array<{ user_id: string; role: string }> };
    assert.ok(detailBody.members.some((row) => row.user_id === TARGET_ID && row.role === 'lead'));
  });

  test('resource links are org-scoped and idempotent', async () => {
    const crossOrg = await authed(`/api/teams/${TEAM_ID}/resources`, LEAD_ID, {
      method: 'POST',
      body: JSON.stringify({ resource_type: 'project', resource_id: OTHER_PROJECT_ID }),
    });
    assert.equal(crossOrg.status, 400);
    assert.equal((await crossOrg.json() as { code: string }).code, 'INVALID_RESOURCE');

    const ok = await authed(`/api/teams/${TEAM_ID}/resources`, LEAD_ID, {
      method: 'POST',
      body: JSON.stringify({ resource_type: 'project', resource_id: PROJECT_ID, label: 'Launch project' }),
    });
    assert.equal(ok.status, 201);

    const duplicate = await authed(`/api/teams/${TEAM_ID}/resources`, LEAD_ID, {
      method: 'POST',
      body: JSON.stringify({ resource_type: 'project', resource_id: PROJECT_ID, label: 'Launch project' }),
    });
    assert.equal(duplicate.status, 200);

    const detail = await authed(`/api/teams/${TEAM_ID}`, TARGET_ID);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { resources: Array<{ resource_id: string }>; summary: { resources_by_type: Record<string, number> } };
    assert.ok(detailBody.resources.some((row) => row.resource_id === PROJECT_ID));
    assert.equal(detailBody.summary.resources_by_type.project, 1);
  });

  test('resource links can be detached without deleting the linked resource', async () => {
    const detached = await authed(`/api/teams/${TEAM_ID}/resources/project/${PROJECT_ID}`, LEAD_ID, { method: 'DELETE' });
    assert.equal(detached.status, 200);
    assert.equal((await detached.json() as { success: boolean }).success, true);

    const detail = await authed(`/api/teams/${TEAM_ID}`, TARGET_ID);
    const detailBody = await detail.json() as { resources: Array<{ resource_id: string }>; summary: { resources_by_type: Record<string, number> } };
    assert.equal(detailBody.resources.some((row) => row.resource_id === PROJECT_ID), false);
    assert.equal(detailBody.summary.resources_by_type.project ?? 0, 0);

    const relink = await authed(`/api/teams/${TEAM_ID}/resources`, LEAD_ID, {
      method: 'POST',
      body: JSON.stringify({ resource_type: 'project', resource_id: PROJECT_ID, label: 'Launch project' }),
    });
    assert.equal(relink.status, 201);
  });

  test('summary route is scoped and does not leak cross-org teams', async () => {
    const summary = await authed(`/api/teams/${TEAM_ID}/summary`, TARGET_ID);
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json() as {
      member_count: number;
      agent_count: number;
      resources_by_type: Record<string, number>;
    };
    assert.equal(summaryBody.member_count, 3);
    assert.equal(summaryBody.agent_count, 0);
    assert.equal(summaryBody.resources_by_type.project, 1);

    const crossOrg = await authed(`/api/teams/${OTHER_TEAM_ID}/summary`, ADMIN_ID);
    assert.equal(crossOrg.status, 404);
    assert.equal((await crossOrg.json() as { code: string }).code, 'NOT_FOUND');
  });

  test('dashboard route returns team attention, workload, and context cards', async () => {
    const addAgent = await authed(`/api/teams/${TEAM_ID}/members`, LEAD_ID, {
      method: 'POST',
      body: JSON.stringify({ user_id: AGENT_USER_ID, role: 'viewer' }),
    });
    assert.equal(addAgent.status, 201);

    const detail = await authed(`/api/teams/${TEAM_ID}`, TARGET_ID);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { summary: { agent_count: number }; members: Array<{ user_id: string; kind: string }> };
    assert.equal(detailBody.summary.agent_count, 1);
    assert.ok(detailBody.members.some((row) => row.user_id === AGENT_USER_ID && row.kind === 'agent'));

    const res = await authed(`/api/teams/${TEAM_ID}/dashboard`, TARGET_ID);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      attention: { overdue_tasks: number; due_soon_tasks: number; in_review_tasks: number; top_tasks: Array<{ id: string }> };
      workload: { open_tasks: number; by_status: Record<string, number>; by_owner: Array<{ name: string; count: number }> };
      context: { linked_projects: number; human_members: number; agent_members: number };
    };
    assert.equal(body.attention.overdue_tasks, 1);
    assert.equal(body.attention.due_soon_tasks, 1);
    assert.equal(body.attention.in_review_tasks, 1);
    assert.equal(body.workload.open_tasks, 2);
    assert.equal(body.workload.by_status.todo, 1);
    assert.equal(body.workload.by_status.in_review, 1);
    assert.equal(body.context.linked_projects, 1);
    assert.equal(body.context.human_members, 3);
    assert.equal(body.context.agent_members, 1);
    assert.ok(body.attention.top_tasks.some((row) => row.id === OVERDUE_TASK_ID));
  });

  test('archives teams without deleting memberships or resources', async () => {
    const res = await authed(`/api/teams/${TEAM_ID}/archive`, LEAD_ID, { method: 'POST' });
    const body = await res.json() as { is_archived: boolean };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.is_archived, true);

    const hidden = await authed('/api/teams', LEAD_ID);
    const hiddenRows = await hidden.json() as Array<{ id: string }>;
    assert.equal(hiddenRows.some((row) => row.id === TEAM_ID), false);

    const included = await authed('/api/teams?include_archived=true', LEAD_ID);
    const includedRows = await included.json() as Array<{ id: string }>;
    assert.ok(includedRows.some((row) => row.id === TEAM_ID));
  });
});
