import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { agentActions } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { visibleModuleActionSql } from '../src/lib/module-action-visibility.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const canRun = Boolean(
  TEST_DATABASE_URL && /(?:test|ci|acceptance)/i.test(new URL(TEST_DATABASE_URL).pathname),
);

after(async () => closeDb());

test('module actions are visible only to requester, explicit reviewer, or admin', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const orgId = `visibility-org-${suffix}`;
  const requesterId = `visibility-requester-${suffix}`;
  const reviewerId = `visibility-reviewer-${suffix}`;
  const unrelatedId = `visibility-unrelated-${suffix}`;
  const ownerId = `visibility-owner-${suffix}`;
  const guestId = `visibility-guest-${suffix}`;
  const moduleActionId = `visibility-module-action-${suffix}`;
  const ordinaryActionId = `visibility-ordinary-action-${suffix}`;

  try {
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [
      orgId,
      `Visibility ${suffix}`,
      `visibility-${suffix}`,
    ]);
    for (const [id, role] of [
      [requesterId, 'member'],
      [reviewerId, 'member'],
      [unrelatedId, 'member'],
      [ownerId, 'owner'],
      [guestId, 'guest'],
    ] as const) {
      await client.query(
        'INSERT INTO users (id, email, name) VALUES ($1, $2, $3)',
        [id, `${id}@example.test`, id],
      );
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true)`,
        [orgId, id, role],
      );
    }
    await client.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, source, action, params, approval_tier, approval_status)
       VALUES
        ($1, $2, $3, 'defty', 'module_record_create', $4::jsonb, 'quick', 'pending'),
        ($5, $2, $3, 'defty', 'create_task', '{}'::jsonb, 'quick', 'pending')`,
      [
        moduleActionId,
        orgId,
        requesterId,
        JSON.stringify({ data: { name: `private-${suffix}` } }),
        ordinaryActionId,
      ],
    );
    await client.query(
      `INSERT INTO agent_action_approvers
        (id, org_id, action_id, user_id, decision)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'pending')`,
      [orgId, moduleActionId, reviewerId],
    );

    const visibleIds = async (
      role: 'owner' | 'admin' | 'member' | 'guest',
      userId: string,
    ) => (await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        visibleModuleActionSql(role, { userId, orgId }),
      )))
      .map((row) => row.id);

    assert.deepEqual(new Set(await visibleIds('owner', ownerId)), new Set([
      moduleActionId,
      ordinaryActionId,
    ]));
    assert.deepEqual(new Set(await visibleIds('member', requesterId)), new Set([
      moduleActionId,
      ordinaryActionId,
    ]));
    assert.deepEqual(new Set(await visibleIds('member', reviewerId)), new Set([
      moduleActionId,
      ordinaryActionId,
    ]));
    assert.deepEqual(await visibleIds('member', unrelatedId), [ordinaryActionId]);
    assert.deepEqual(await visibleIds('guest', guestId), [ordinaryActionId]);
  } finally {
    await client.query('DELETE FROM agent_action_approvers WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[
      requesterId,
      reviewerId,
      unrelatedId,
      ownerId,
      guestId,
    ]]);
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await client.end();
  }
});
