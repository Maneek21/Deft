/**
 * Loop 0 identity hardening tests.
 *
 * Covers:
 * - inactive org members cannot keep using JWT access/refresh tokens
 * - groups are admin-managed and org-scoped
 * - group members must be active org members
 * - org API keys are owner/admin-managed
 * - task assignees must be active users or healthy agents in-org
 * - member removal revokes obvious workspace access
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';
import { authRoutes } from '../src/routes/auth.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { groupRoutes } from '../src/routes/groups.js';
import { apiKeyRoutes } from '../src/routes/api-keys.js';
import { memberRoutes } from '../src/routes/members.js';
import { taskRoutes } from '../src/routes/tasks.js';
import { inviteRoutes } from '../src/routes/invites.js';
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
app.route('/api/auth', authRoutes);
app.route('/api/invites', inviteRoutes);
app.use('/api/*', authMiddleware);
app.route('/api/groups', groupRoutes);
app.route('/api/api-keys', apiKeyRoutes);
app.route('/api/members', memberRoutes);
app.route('/api/tasks', taskRoutes);

const RUN_ID = crypto.randomUUID();
const ORG_ID = crypto.randomUUID();
const OTHER_ORG_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();
const MEMBER_ID = crypto.randomUUID();
const TARGET_ID = crypto.randomUUID();
const INACTIVE_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const SPACE_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const OTHER_PROJECT_ID = crypto.randomUUID();
const TASK_ID = crypto.randomUUID();
const OTHER_TASK_ID = crypto.randomUUID();
const OTHER_GROUP_ID = crypto.randomUUID();
const OTHER_GROUP_MEMBER_ID = crypto.randomUUID();
const OTHER_TASK_ASSIGNEE_ID = crypto.randomUUID();
const MCP_TOKEN_ID = crypto.randomUUID();
const TARGET_API_KEY_ID = crypto.randomUUID();
const TARGET_OAUTH_GRANT_ID = crypto.randomUUID();
const TARGET_OAUTH_ACCESS_ID = crypto.randomUUID();
const TARGET_OAUTH_REFRESH_ID = crypto.randomUUID();
const INVITED_EMAIL = `invite-${RUN_ID}@test.local`;

function accessToken(userId: string, orgId = ORG_ID, email = `${userId}@test.local`) {
  return jwt.sign({ id: userId, email, org_id: orgId }, env.JWT_SECRET, { expiresIn: '15m' });
}

function refreshToken(userId: string, orgId = ORG_ID, email = `${userId}@test.local`) {
  return jwt.sign({ id: userId, email, org_id: orgId }, env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
}

async function authed(path: string, userId: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken(userId)}`,
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
       VALUES ($1, 'Identity Hardening Org', $2), ($3, 'Other Identity Org', $4)`,
      [ORG_ID, `identity-hardening-${RUN_ID.slice(0, 8)}`, OTHER_ORG_ID, `identity-other-${RUN_ID.slice(0, 8)}`],
    );

    await c.query(
      `INSERT INTO users (id, email, name, email_verified)
       VALUES
        ($1, $2, 'Admin User', true),
        ($3, $4, 'Member User', true),
        ($5, $6, 'Target User', true),
        ($7, $8, 'Inactive User', true),
        ($9, $10, 'Other Org User', true)`,
      [
        ADMIN_ID,
        `admin-${RUN_ID}@test.local`,
        MEMBER_ID,
        `member-${RUN_ID}@test.local`,
        TARGET_ID,
        `target-${RUN_ID}@test.local`,
        INACTIVE_ID,
        `inactive-${RUN_ID}@test.local`,
        OTHER_USER_ID,
        `other-${RUN_ID}@test.local`,
      ],
    );

    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES
        ($1, $2, $3, 'admin', true),
        ($4, $2, $5, 'member', true),
        ($6, $2, $7, 'member', true),
        ($8, $2, $9, 'member', false),
        ($10, $11, $12, 'admin', true)`,
      [
        crypto.randomUUID(),
        ORG_ID,
        ADMIN_ID,
        crypto.randomUUID(),
        MEMBER_ID,
        crypto.randomUUID(),
        TARGET_ID,
        crypto.randomUUID(),
        INACTIVE_ID,
        crypto.randomUUID(),
        OTHER_ORG_ID,
        OTHER_USER_ID,
      ],
    );

    await c.query(
      `INSERT INTO spaces (id, org_id, name, created_by, is_default)
       VALUES ($1, $2, 'identity-hardening', $3, true)`,
      [SPACE_ID, ORG_ID, ADMIN_ID],
    );
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)`,
      [crypto.randomUUID(), SPACE_ID, TARGET_ID],
    );

    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES
        ($1, $2, 'Identity Project', 'IDH', $3, 0),
        ($4, $5, 'Other Identity Project', 'OID', $6, 0)`,
      [PROJECT_ID, ORG_ID, ADMIN_ID, OTHER_PROJECT_ID, OTHER_ORG_ID, OTHER_USER_ID],
    );
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
       VALUES
        ($1, $2, $3, 1, 'Identity task', 'backlog', 'p2', $4, $5, false),
        ($6, $7, $8, 1, 'Other identity task', 'backlog', 'p2', $9, $9, false)`,
      [TASK_ID, ORG_ID, PROJECT_ID, MEMBER_ID, ADMIN_ID, OTHER_TASK_ID, OTHER_ORG_ID, OTHER_PROJECT_ID, OTHER_USER_ID],
    );
    await c.query(
      `INSERT INTO task_assignees (id, task_id, user_id)
       VALUES ($1, $2, $3)`,
      [OTHER_TASK_ASSIGNEE_ID, OTHER_TASK_ID, OTHER_USER_ID],
    );

    await c.query(
      `INSERT INTO mcp_tokens (id, org_id, user_id, principal_kind, name, token_hash, token_prefix, scopes, created_by)
       VALUES ($1, $2, $3, 'human', 'Target token', 'dummy-hash', 'dummy-prefix', ARRAY['read:workspace'], $4)`,
      [MCP_TOKEN_ID, ORG_ID, TARGET_ID, TARGET_ID],
    );
    await c.query(
      `INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, permissions, is_active, created_by)
       VALUES ($1, $2, 'Target owned key', 'target-key-hash', 'target-prefix', ARRAY['read:workspace'], true, $3)`,
      [TARGET_API_KEY_ID, ORG_ID, TARGET_ID],
    );
    await c.query(
      `INSERT INTO oauth_grants (id, org_id, user_id, client_id, app_name, connector_profile, scopes)
       VALUES ($1, $2, $3, 'identity-client', 'Identity Client', 'workspace_helper', ARRAY['read:workspace'])`,
      [TARGET_OAUTH_GRANT_ID, ORG_ID, TARGET_ID],
    );
    await c.query(
      `INSERT INTO oauth_access_tokens (id, token_hash, grant_id, org_id, user_id, client_id, resource, scopes, expires_at)
       VALUES ($1, 'target-access-hash', $2, $3, $4, 'identity-client', 'https://example.test/mcp', ARRAY['read:workspace'], NOW() + INTERVAL '1 hour')`,
      [TARGET_OAUTH_ACCESS_ID, TARGET_OAUTH_GRANT_ID, ORG_ID, TARGET_ID],
    );
    await c.query(
      `INSERT INTO oauth_refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, 'target-refresh-hash', $2, NOW() + INTERVAL '30 days')`,
      [TARGET_OAUTH_REFRESH_ID, TARGET_OAUTH_GRANT_ID],
    );

    await c.query(
      `INSERT INTO user_groups (id, org_id, name, handle, created_by)
       VALUES ($1, $2, 'Other Group', 'other-group', $3)`,
      [OTHER_GROUP_ID, OTHER_ORG_ID, OTHER_USER_ID],
    );
    await c.query(
      `INSERT INTO user_group_members (id, group_id, user_id)
       VALUES ($1, $2, $3)`,
      [OTHER_GROUP_MEMBER_ID, OTHER_GROUP_ID, OTHER_USER_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM invites WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM oauth_access_tokens WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM oauth_refresh_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE org_id IN ($1, $2))`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM oauth_grants WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM mcp_tokens WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM api_keys WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM user_group_members WHERE group_id IN (SELECT id FROM user_groups WHERE org_id IN ($1, $2))`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM user_groups WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN ($1, $2))`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await c.query(`DELETE FROM task_activity WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN ($1, $2))`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await c.query(`DELETE FROM notifications WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM tasks WHERE project_id IN ($1, $2)`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await c.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [PROJECT_ID, OTHER_PROJECT_ID]);
    await c.query(`DELETE FROM space_members WHERE space_id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM spaces WHERE id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM org_members WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM users WHERE email = $1`, [INVITED_EMAIL]);
    await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN_ID, MEMBER_ID, TARGET_ID, INACTIVE_ID, OTHER_USER_ID]]);
    await c.query(`DELETE FROM orgs WHERE id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
  });
});

describe('Loop 0 identity hardening', () => {
  test('inactive org members cannot use protected JWT routes', async () => {
    const res = await authed('/api/groups', INACTIVE_ID);
    assert.equal(res.status, 403);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, 'ORG_MEMBERSHIP_INACTIVE');
  });

  test('inactive org members cannot refresh tokens', async () => {
    const res = await app.fetch(new Request('http://localhost/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshToken(INACTIVE_ID) }),
    }));
    assert.equal(res.status, 403);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, 'ORG_MEMBERSHIP_INACTIVE');
  });

  test('non-admin members cannot create groups', async () => {
    const res = await authed('/api/groups', MEMBER_ID, {
      method: 'POST',
      body: JSON.stringify({ name: 'Ops', handle: 'ops' }),
    });
    assert.equal(res.status, 403);
  });

  test('admins cannot add inactive or cross-org users to groups', async () => {
    const res = await authed('/api/groups', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad Group',
        handle: 'bad-group',
        member_ids: [MEMBER_ID, INACTIVE_ID],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, 'INVALID_MEMBERS');
  });

  test('admins can create groups with active org members', async () => {
    const res = await authed('/api/groups', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Launch Team',
        handle: 'launch-team',
        member_ids: [MEMBER_ID],
      }),
    });
    assert.equal(res.status, 201);
    const group = await res.json() as { id: string };

    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS count FROM user_group_members WHERE group_id = $1 AND user_id = $2`,
        [group.id, MEMBER_ID],
      );
      assert.equal(rows[0].count, 1);
    });
  });

  test('cross-org group delete returns 404 without deleting member rows first', async () => {
    const res = await authed(`/api/groups/${OTHER_GROUP_ID}`, ADMIN_ID, { method: 'DELETE' });
    assert.equal(res.status, 404);

    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS count FROM user_group_members WHERE id = $1`,
        [OTHER_GROUP_MEMBER_ID],
      );
      assert.equal(rows[0].count, 1);
    });
  });

  test('org API keys are admin-managed', async () => {
    const memberRes = await authed('/api/api-keys', MEMBER_ID);
    assert.equal(memberRes.status, 403);

    const adminRes = await authed('/api/api-keys', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({ name: 'Admin key', permissions: ['read:workspace'] }),
    });
    assert.equal(adminRes.status, 201);
    const body = await adminRes.json() as Record<string, unknown>;
    assert.equal(typeof body.raw_key, 'string');
  });

  test('member invite creates a durable invite row used by preview', async () => {
    const res = await authed('/api/members/invite', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({ email: INVITED_EMAIL, role: 'member' }),
    });
    const body = await res.json() as { invite_url: string; expires_at: string };
    assert.equal(res.status, 201, JSON.stringify(body));
    const token = new URL(body.invite_url).pathname.split('/').pop();
    assert.ok(token, 'expected invite token in URL');

    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS count FROM invites WHERE org_id = $1 AND email = $2 AND token = $3 AND accepted_at IS NULL`,
        [ORG_ID, INVITED_EMAIL, token],
      );
      assert.equal(rows[0].count, 1);
    });

    const preview = await app.fetch(new Request(`http://localhost/api/invites/preview/${encodeURIComponent(token)}`));
    const previewBody = await preview.json() as Record<string, unknown>;
    assert.equal(preview.status, 200, JSON.stringify(previewBody));
    assert.equal(previewBody.email, INVITED_EMAIL);
    assert.equal(previewBody.already_accepted, false);
  });

  test('task writes reject inactive or cross-org assignees', async () => {
    const inactiveRes = await authed('/api/tasks', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: 'Should not assign inactive user',
        assignee_id: INACTIVE_ID,
      }),
    });
    assert.equal(inactiveRes.status, 400);
    assert.equal((await inactiveRes.json() as Record<string, unknown>).code, 'INVALID_ASSIGNEE');

    const crossOrgRes = await authed('/api/tasks', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: 'Should not assign cross-org user',
        assignee_id: OTHER_USER_ID,
      }),
    });
    assert.equal(crossOrgRes.status, 400);
    assert.equal((await crossOrgRes.json() as Record<string, unknown>).code, 'INVALID_ASSIGNEE');

    const validRes = await authed('/api/tasks', ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: 'Can assign active user',
        assignee_id: MEMBER_ID,
      }),
    });
    assert.equal(validRes.status, 201, await validRes.text());
  });

  test('additional assignee routes enforce org visibility and active members', async () => {
    const inactiveRes = await authed(`/api/tasks/${TASK_ID}/assignees`, ADMIN_ID, {
      method: 'POST',
      body: JSON.stringify({ user_id: INACTIVE_ID }),
    });
    assert.equal(inactiveRes.status, 400);
    assert.equal((await inactiveRes.json() as Record<string, unknown>).code, 'INVALID_ASSIGNEE');

    const deleteOtherOrgRes = await authed(`/api/tasks/${OTHER_TASK_ID}/assignees/${OTHER_USER_ID}`, ADMIN_ID, { method: 'DELETE' });
    assert.equal(deleteOtherOrgRes.status, 404);

    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS count FROM task_assignees WHERE id = $1`,
        [OTHER_TASK_ASSIGNEE_ID],
      );
      assert.equal(rows[0].count, 1);
    });
  });

  test('member removal revokes space access and personal MCP tokens', async () => {
    const res = await authed(`/api/members/${TARGET_ID}`, ADMIN_ID, { method: 'DELETE' });
    assert.equal(res.status, 200, await res.text());

    await withClient(async (c) => {
      const membership = await c.query(
        `SELECT is_active FROM org_members WHERE org_id = $1 AND user_id = $2`,
        [ORG_ID, TARGET_ID],
      );
      assert.equal(membership.rows[0].is_active, false);

      const spaceRows = await c.query(
        `SELECT count(*)::int AS count FROM space_members WHERE space_id = $1 AND user_id = $2`,
        [SPACE_ID, TARGET_ID],
      );
      assert.equal(spaceRows.rows[0].count, 0);

      const tokenRows = await c.query(
        `SELECT revoked_at IS NOT NULL AS revoked FROM mcp_tokens WHERE id = $1`,
        [MCP_TOKEN_ID],
      );
      assert.equal(tokenRows.rows[0].revoked, true);

      const apiKeyRows = await c.query(
        `SELECT is_active FROM api_keys WHERE id = $1`,
        [TARGET_API_KEY_ID],
      );
      assert.equal(apiKeyRows.rows[0].is_active, false);

      const oauthGrantRows = await c.query(
        `SELECT revoked_at IS NOT NULL AS revoked FROM oauth_grants WHERE id = $1`,
        [TARGET_OAUTH_GRANT_ID],
      );
      assert.equal(oauthGrantRows.rows[0].revoked, true);

      const oauthAccessRows = await c.query(
        `SELECT revoked_at IS NOT NULL AS revoked FROM oauth_access_tokens WHERE id = $1`,
        [TARGET_OAUTH_ACCESS_ID],
      );
      assert.equal(oauthAccessRows.rows[0].revoked, true);

      const oauthRefreshRows = await c.query(
        `SELECT revoked_at IS NOT NULL AS revoked FROM oauth_refresh_tokens WHERE id = $1`,
        [TARGET_OAUTH_REFRESH_ID],
      );
      assert.equal(oauthRefreshRows.rows[0].revoked, true);
    });
  });
});
