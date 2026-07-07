/**
 * Blocked chat governance test.
 *
 * Blocked messages should alert the right human lead when they relate to
 * in-progress work, but they must not mechanically create Defty task proposals.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and } from 'drizzle-orm';
import {
  db,
  agentActions,
  agentNudges,
  messages,
  notifications,
  orgMembers,
  orgs,
  projects,
  projectSpaces,
  spaceMembers,
  spaces,
  tasks,
  users,
  workIntents,
} from '@deft/db';
import { handleBlockedAlert } from '../src/workers/handlers/blocked-alert.js';

let testOrgId: string;
let blockedUserId: string;
let leadUserId: string;
let spaceId: string;
let msgId: string;
let projectId: string;
let taskId: string;

async function runBlockedAlert(content = 'I am completely stuck on the database migration') {
  await handleBlockedAlert({
    id: 'job',
    name: 'blocked-alert',
    data: {
      messageId: msgId,
      spaceId,
      content,
      orgId: testOrgId,
      userId: blockedUserId,
    },
  } as any);
}

before(async () => {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  testOrgId = crypto.randomUUID();
  await db.insert(orgs).values({
    id: testOrgId,
    name: `blocked-governance-${suffix}`,
    slug: `blocked-governance-${suffix}`,
  });

  blockedUserId = crypto.randomUUID();
  leadUserId = crypto.randomUUID();
  await db.insert(users).values([
    {
      id: blockedUserId,
      email: `blocked-${suffix}@t.local`,
      name: `Blocked User ${suffix}`,
    },
    {
      id: leadUserId,
      email: `blocked-lead-${suffix}@t.local`,
      name: `Project Lead ${suffix}`,
    },
  ]);

  await db.insert(orgMembers).values([
    {
      id: crypto.randomUUID(),
      org_id: testOrgId,
      user_id: blockedUserId,
      role: 'member',
    },
    {
      id: crypto.randomUUID(),
      org_id: testOrgId,
      user_id: leadUserId,
      role: 'admin',
    },
  ]);

  spaceId = crypto.randomUUID();
  await db.insert(spaces).values({
    id: spaceId,
    org_id: testOrgId,
    name: `blocked-space-${Date.now()}`,
    type: 'public',
    created_by: leadUserId,
  });
  await db.insert(spaceMembers).values([
    { id: crypto.randomUUID(), space_id: spaceId, user_id: blockedUserId },
    { id: crypto.randomUUID(), space_id: spaceId, user_id: leadUserId },
  ]);

  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    id: projectId,
    org_id: testOrgId,
    name: `blocked-project-${Date.now()}`,
    prefix: `B${Math.floor(Math.random() * 100000)}`,
    lead_id: leadUserId,
    created_by: leadUserId,
  });
  await db.insert(projectSpaces).values({
    id: crypto.randomUUID(),
    project_id: projectId,
    space_id: spaceId,
  });

  taskId = crypto.randomUUID();
  await db.insert(tasks).values({
    id: taskId,
    org_id: testOrgId,
    project_id: projectId,
    number: 1,
    title: 'Finish migration plan',
    status: 'in_progress' as any,
    assignee_id: blockedUserId,
    created_by: leadUserId,
  });

  msgId = crypto.randomUUID();
  await db.insert(messages).values({
    id: msgId,
    org_id: testOrgId,
    space_id: spaceId,
    user_id: blockedUserId,
    content: 'I am completely stuck on the database migration',
  });
});

afterEach(async () => {
  if (!testOrgId || !msgId || !blockedUserId) return;

  await db.delete(agentActions).where(
    and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.message_id, msgId),
      eq(agentActions.source, 'defty_capture'),
    ),
  );
  await db.delete(workIntents).where(
    and(
      eq(workIntents.org_id, testOrgId),
      eq(workIntents.source_message_id, msgId),
    ),
  );
  await db.delete(notifications).where(eq(notifications.org_id, testOrgId));
  await db.delete(agentNudges).where(
    and(
      eq(agentNudges.user_id, blockedUserId),
      eq(agentNudges.nudge_type, 'blocked'),
    ),
  );
});

after(async () => {
  if (testOrgId) {
    await db.delete(agentActions).where(eq(agentActions.org_id, testOrgId));
    await db.delete(workIntents).where(eq(workIntents.org_id, testOrgId));
    await db.delete(notifications).where(eq(notifications.org_id, testOrgId));
    await db.delete(agentNudges).where(eq(agentNudges.org_id, testOrgId));
  }
  if (msgId) await db.delete(messages).where(eq(messages.id, msgId));
  if (taskId) await db.delete(tasks).where(eq(tasks.id, taskId));
  if (projectId) await db.delete(projectSpaces).where(eq(projectSpaces.project_id, projectId));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  if (spaceId) await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  if (spaceId) await db.delete(spaces).where(eq(spaces.id, spaceId));
  if (testOrgId) await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  if (testOrgId) await db.delete(orgs).where(eq(orgs.id, testOrgId));
  if (blockedUserId || leadUserId) {
    await db.delete(users).where(eq(users.id, blockedUserId));
    await db.delete(users).where(eq(users.id, leadUserId));
  }
});

test('blocked-alert does not create Defty task proposals by itself', async () => {
  await runBlockedAlert();

  const actions = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, testOrgId),
      eq(agentActions.message_id, msgId),
      eq(agentActions.source, 'defty_capture'),
    ));
  assert.equal(actions.length, 0, 'blocked chat should wait for Defty/human task creation');

  const intents = await db
    .select()
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, testOrgId),
      eq(workIntents.source_message_id, msgId),
    ));
  assert.equal(intents.length, 0, 'blocked chat should not create passive work intents');
});

test('blocked-alert still notifies the project lead for real blocked work', async () => {
  await runBlockedAlert();

  const rows = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.org_id, testOrgId),
      eq(notifications.user_id, leadUserId),
      eq(notifications.title, 'Blocked Team Member'),
    ));

  assert.equal(rows.length, 1, `expected one lead notification, got ${rows.length}`);
  assert.equal(rows[0]!.type, 'agent_suggestion');
  assert.match(rows[0]!.body ?? '', /stuck on the database migration/i);
  assert.equal((rows[0]!.metadata as any).task_id, taskId);
});

test('blocked-alert strips rich text from lead notification body', async () => {
  await runBlockedAlert('<p><strong>I am blocked</strong> on the &amp; vendor export.</p>');

  const [row] = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.org_id, testOrgId),
      eq(notifications.user_id, leadUserId),
      eq(notifications.title, 'Blocked Team Member'),
    ))
    .limit(1);

  assert.ok(row, 'expected lead notification');
  assert.match(row.body ?? '', /I am blocked on the & vendor export\./);
  assert.doesNotMatch(row.body ?? '', /<strong>|<p>/);
});
