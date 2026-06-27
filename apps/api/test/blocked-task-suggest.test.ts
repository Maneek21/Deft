/**
 * Block 2.4 — blocked → task-create proposal test.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/blocked-task-suggest.test.ts
 *
 * The blocked-alert handler now also queues a Defty task_create proposal
 * (approval_status='pending', source='defty_capture') so the user
 * can one-click convert the blocked message into a tracked task.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and } from 'drizzle-orm';
import {
  db, agentActions, agentNudges, spaces, messages,
  orgs, users, orgMembers, projects, projectSpaces,
} from '@deft/db';
import { handleBlockedAlert } from '../src/workers/handlers/blocked-alert.js';

let testOrgId: string;
let testUserId: string;
let spaceId: string;
let msgId: string;
let projectId: string;

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

  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    id: projectId,
    org_id: testOrgId,
    name: `b24-project-${Date.now()}`,
    prefix: `B${Math.floor(Math.random() * 100000)}`,
    lead_id: testUserId,
  });
  await db.insert(projectSpaces).values({
    id: crypto.randomUUID(),
    project_id: projectId,
    space_id: spaceId,
  });

  msgId = crypto.randomUUID();
  await db.insert(messages).values({
    id: msgId, org_id: testOrgId, space_id: spaceId, user_id: testUserId,
    content: 'I am completely stuck on the database migration',
  });
});

afterEach(async () => {
  if (!testOrgId || !msgId || !testUserId) return;

  await db.delete(agentActions).where(
    and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.message_id, msgId),
      eq(agentActions.source, 'defty_capture'),
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
  if (msgId) await db.delete(messages).where(eq(messages.id, msgId));
  if (projectId) await db.delete(projectSpaces).where(eq(projectSpaces.project_id, projectId));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  if (spaceId) await db.delete(spaces).where(eq(spaces.id, spaceId));
});

test('blocked-alert queues a Defty task_create proposal for the blocked user', async () => {
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
      eq(agentActions.message_id, msgId),
      eq(agentActions.source, 'defty_capture'),
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
  assert.equal(params.source_user_id, testUserId);
  assert.equal(params.origin_message_id, msgId);
  assert.equal(params.origin_space_id, spaceId);
  assert.equal(params.origin_user_id, testUserId);
  assert.equal(params.capture_kind, 'blocker_candidate');
  assert.equal(params.proposed_by, 'defty');
  assert.equal(params.dedupe_key, `defty_capture:blocker_candidate:create_task:${msgId}`);
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
      eq(agentActions.message_id, msgId),
      eq(agentActions.source, 'defty_capture'),
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
      eq(agentActions.message_id, msgId),
      eq(agentActions.source, 'defty_capture'),
    ))
    .limit(1);
  const params = row!.params as any;
  assert.equal(params.title, 'Blocker: I am blocked on the & vendor export.');
  assert.equal(params.description, 'I am blocked on the & vendor export.');
});
