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
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import { authRoutes } from '../src/routes/auth.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { groupRoutes } from '../src/routes/groups.js';
import { apiKeyRoutes } from '../src/routes/api-keys.js';
import { memberRoutes } from '../src/routes/members.js';
import { taskRoutes } from '../src/routes/tasks.js';
import { inviteRoutes } from '../src/routes/invites.js';
import { createWebSession } from '../src/lib/web-sessions.js';
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
const RACE_EMAIL = `invite-race-${RUN_ID}@test.local`;

const sessions = new Map<string, Awaited<ReturnType<typeof createWebSession>>>();
const sessionKey = (userId: string, orgId: string) => `${orgId}:${userId}`;
function accessToken(userId: string, orgId = ORG_ID) {
  return sessions.get(sessionKey(userId, orgId))!.accessToken;
}
function refreshToken(userId: string, orgId = ORG_ID) {
  return sessions.get(sessionKey(userId, orgId))!.refreshToken;
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
  const identities = [
    [ADMIN_ID, ORG_ID, `admin-${RUN_ID}@test.local`],
    [MEMBER_ID, ORG_ID, `member-${RUN_ID}@test.local`],
    [TARGET_ID, ORG_ID, `target-${RUN_ID}@test.local`],
    [OTHER_USER_ID, OTHER_ORG_ID, `other-${RUN_ID}@test.local`],
  ] as const;
  for (const [id, orgId, email] of identities) {
    sessions.set(sessionKey(id, orgId), await createWebSession({ id, org_id: orgId, email }));
  }
  await withClient(c => c.query(`UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2`, [ORG_ID, INACTIVE_ID]).then(() => undefined));
  sessions.set(sessionKey(INACTIVE_ID, ORG_ID), await createWebSession({ id: INACTIVE_ID, org_id: ORG_ID, email: `inactive-${RUN_ID}@test.local` }));
  await withClient(c => c.query(`UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2`, [ORG_ID, INACTIVE_ID]).then(() => undefined));
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM web_sessions WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM invites WHERE org_id IN ($1, $2)`, [ORG_ID, OTHER_ORG_ID]);
    await c.query(`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE created_by IN (SELECT id FROM users WHERE email = ANY($1::text[])))`, [[INVITED_EMAIL, RACE_EMAIL]]);
    await c.query(`DELETE FROM spaces WHERE created_by IN (SELECT id FROM users WHERE email = ANY($1::text[]))`, [[INVITED_EMAIL, RACE_EMAIL]]);
    await c.query(`DELETE FROM space_members WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1::text[]))`, [[INVITED_EMAIL, RACE_EMAIL]]);
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
    await c.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [[INVITED_EMAIL, RACE_EMAIL]]);
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
    const adminSession = await createWebSession({ id: ADMIN_ID, org_id: ORG_ID, email: `admin-${RUN_ID}@test.local` });
    const res = await app.fetch(new Request('http://localhost/api/members/invite', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminSession.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITED_EMAIL, role: 'member' }),
    }));
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

    const passwords = ['Invite-race-alpha-2026!', 'Invite-race-beta-2026!'];
    const responses = await Promise.all(passwords.map((password, index) => app.fetch(new Request('http://localhost/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password, name: `Invite winner ${index}` }),
    }))));
    const statuses = responses.map(response => response.status).sort();
    assert.deepEqual(statuses, [200, 400]);
    const winnerIndex = responses.findIndex(response => response.status === 200);
    assert.notEqual(winnerIndex, -1);
    assert.equal((await responses[1 - winnerIndex]!.json() as Record<string, unknown>).code, 'INVITE_ALREADY_ACCEPTED');

    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT u.password_hash, u.password_version,
                (SELECT count(*)::int FROM web_sessions ws WHERE ws.user_id = u.id) AS session_count,
                (SELECT count(*)::int FROM invites i WHERE i.org_id = $1 AND i.email = $2 AND i.accepted_at IS NOT NULL) AS accepted_count
         FROM users u WHERE u.email = $2`,
        [ORG_ID, INVITED_EMAIL],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].password_version, 1);
      assert.equal(rows[0].session_count, 1);
      assert.equal(rows[0].accepted_count, 1);
      assert.equal(await bcrypt.compare(passwords[winnerIndex]!, rows[0].password_hash), true);
      assert.equal(await bcrypt.compare(passwords[1 - winnerIndex]!, rows[0].password_hash), false);
    });

    const raceInviteResponse = await app.fetch(new Request('http://localhost/api/members/invite', {
      method: 'POST', headers: { Authorization: `Bearer ${adminSession.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: RACE_EMAIL, role: 'member' }),
    }));
    const raceInviteBody = await raceInviteResponse.json() as { invite_url: string; error?: string };
    assert.equal(raceInviteResponse.status, 201, JSON.stringify(raceInviteBody));
    const raceToken = new URL(raceInviteBody.invite_url).pathname.split('/').pop()!;
    const raceInvite = await withClient(async (c) => {
      const { rows } = await c.query(`SELECT id FROM invites WHERE token = $1`, [raceToken]);
      return rows[0] as { id: string };
    });
    const [acceptRace, revokeRace] = await Promise.all([
      app.fetch(new Request('http://localhost/api/invites/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: raceToken, password: 'Invite-revoke-race-2026!' }),
      })),
      app.fetch(new Request(`http://localhost/api/members/invites/${raceInvite.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${adminSession.accessToken}` },
      })),
    ]);
    assert.equal(
      (acceptRace.status === 200 && revokeRace.status === 409)
      || (acceptRace.status === 400 && revokeRace.status === 200),
      true,
      `unexpected accept/revoke results ${acceptRace.status}/${revokeRace.status}`,
    );
    await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT u.password_hash, om.is_active,
                (SELECT count(*)::int FROM web_sessions ws WHERE ws.user_id = u.id AND ws.revoked_at IS NULL) session_count
         FROM users u JOIN org_members om ON om.user_id = u.id AND om.org_id = $1 WHERE u.email = $2`,
        [ORG_ID, RACE_EMAIL],
      );
      assert.equal(rows.length, 1);
      if (acceptRace.status === 200) {
        assert.equal(rows[0].is_active, true);
        assert.ok(rows[0].password_hash);
        assert.equal(rows[0].session_count, 1);
      } else {
        assert.equal(rows[0].is_active, false);
        assert.equal(rows[0].password_hash, null);
        assert.equal(rows[0].session_count, 0);
      }
    });
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
    const triggerSuffix = RUN_ID.replace(/-/g, '_');
    const triggerName = `fail_web_session_revoke_${triggerSuffix}`;
    const functionName = `fail_web_session_revoke_fn_${triggerSuffix}`;
    const before = await withClient(async (c) => {
      const { rows } = await c.query(`SELECT password_version FROM users WHERE id = $1`, [TARGET_ID]);
      await c.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected revoke failure'; END $$`);
      await c.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON web_sessions FOR EACH ROW WHEN (OLD.user_id = '${TARGET_ID}' AND NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION ${functionName}()`);
      return rows[0] as { password_version: number };
    });
    const rollbackResponse = await authed(`/api/members/${TARGET_ID}`, ADMIN_ID, { method: 'DELETE' });
    assert.equal(rollbackResponse.status, 500);
    await withClient(async (c) => {
      await c.query(`DROP TRIGGER ${triggerName} ON web_sessions`);
      await c.query(`DROP FUNCTION ${functionName}()`);
      const { rows } = await c.query(
        `SELECT om.is_active, u.password_version FROM users u JOIN org_members om ON om.user_id = u.id WHERE u.id = $1 AND om.org_id = $2`,
        [TARGET_ID, ORG_ID],
      );
      assert.equal(rows[0].is_active, true, 'membership deactivation must roll back with session revocation');
      assert.equal(rows[0].password_version, before.password_version, 'password version must roll back with session revocation');
    });

    const oldAccessToken = accessToken(TARGET_ID);
    const oldResetToken = jwt.sign({
      id: TARGET_ID, org_id: ORG_ID, purpose: 'password-reset', password_version: before.password_version,
    }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '24h' });
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
      const version = await c.query(`SELECT password_version FROM users WHERE id = $1`, [TARGET_ID]);
      assert.equal(version.rows[0].password_version, before.password_version + 1);
    });

    await withClient(c => c.query(`UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2`, [ORG_ID, TARGET_ID]).then(() => undefined));
    const revivedAccess = await app.fetch(new Request('http://localhost/api/groups', { headers: { Authorization: `Bearer ${oldAccessToken}` } }));
    assert.equal(revivedAccess.status, 401, 'reactivation must not revive a pre-removal session');
    const staleReset = await app.fetch(new Request('http://localhost/api/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: oldResetToken, password: 'stale-reset-must-fail-2026' }),
    }));
    assert.equal(staleReset.status, 400, 'reactivation must not revive a pre-removal recovery URL');
  });
});
