/**
 * Block 2.4 — blocked → task-create proposal test.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/blocked-task-suggest.test.ts
 *
 * The blocked-alert handler now also queues a task_create proposal
 * (approval_status='pending', source='blocked_classifier') so the user
 * can one-click convert the blocked message into a tracked task.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, inArray } from 'drizzle-orm';
import {
  db, agentActions, agentNudges, spaces, messages,
  orgs, users, orgMembers,
} from '@deft/db';
import { handleBlockedAlert } from '../src/workers/handlers/blocked-alert.js';

let testOrgId: string;
let testUserId: string;
let spaceId: string;
let msgId: string;

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b24', slug: 'b24' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b24-${Date.now()}@t.local`, name: 'b24' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  spaceId = crypto.randomUUID();
  await db.insert(spaces).values({
    id: spaceId, org_id: testOrgId, name: `b24-space-${Date.now()}`,
    type: 'public', created_by: testUserId,
  });

  msgId = crypto.randomUUID();
  await db.insert(messages).values({
    id: msgId, org_id: testOrgId, space_id: spaceId, user_id: testUserId,
    content: 'I am completely stuck on the database migration',
  });
});

afterEach(async () => {
  await db.delete(agentActions).where(
    and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.user_id, testUserId),
      eq(agentActions.source, 'blocked_classifier'),
    ),
  );
  // Clear the dedup nudge too so the next test isn't skipped by the
  // 4h "already alerted" guard in handleBlockedAlert.
  await db.delete(agentNudges).where(
    and(
      eq(agentNudges.user_id, testUserId),
      eq(agentNudges.nudge_type, 'blocked'),
    ),
  );
});

after(async () => {
  await db.delete(messages).where(eq(messages.id, msgId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
});

test('blocked-alert queues a task_create proposal for the blocked user', async () => {
  await handleBlockedAlert({
    id: 'job',
    name: 'blocked-alert',
    data: {
      messageId: msgId,
      spaceId,
      content: 'I am completely stuck on the database migration',
      orgId: testOrgId,
      userId: testUserId,
    },
  } as any);

  const rows = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.user_id, testUserId),
      eq(agentActions.source, 'blocked_classifier'),
    ));
  assert.equal(rows.length, 1, `expected 1 proposal, got ${rows.length}`);
  const row = rows[0]!;
  assert.equal(row.action, 'create_task');
  assert.equal(row.approval_tier, 'quick');
  assert.equal(row.approval_status, 'pending');
  assert.equal(row.message_id, msgId);
  const params = row.params as any;
  assert.ok(typeof params.title === 'string' && params.title.startsWith('Blocker:'));
  assert.equal(params.source_message_id, msgId);
  assert.equal(params.source_space_id, spaceId);
});

test('proposal payload description keeps the full message', async () => {
  await handleBlockedAlert({
    id: 'job',
    name: 'blocked-alert',
    data: {
      messageId: msgId,
      spaceId,
      content: 'I am completely stuck on the database migration',
      orgId: testOrgId,
      userId: testUserId,
    },
  } as any);

  const [row] = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.user_id, testUserId),
      eq(agentActions.source, 'blocked_classifier'),
    ))
    .limit(1);
  const params = row!.params as any;
  assert.equal(params.description, 'I am completely stuck on the database migration');
});

test('blocked-alert strips rich text from task proposal fields', async () => {
  await handleBlockedAlert({
    id: 'job',
    name: 'blocked-alert',
    data: {
      messageId: msgId,
      spaceId,
      content: '<p><strong>I am blocked</strong> on the &amp; vendor export.</p>',
      orgId: testOrgId,
      userId: testUserId,
    },
  } as any);

  const [row] = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.user_id, testUserId),
      eq(agentActions.source, 'blocked_classifier'),
    ))
    .limit(1);
  const params = row!.params as any;
  assert.equal(params.title, 'Blocker: I am blocked on the & vendor export.');
  assert.equal(params.description, 'I am blocked on the & vendor export.');
});
