import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  files,
  jobQueue,
  messages,
  orgMembers,
  orgs,
  scheduledMessages,
  spaceMembers,
  spaces,
  users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { scheduledRoutes } from '../src/routes/scheduled.js';
import {
  handleScheduledMessageSend,
  rehydratePendingScheduledMessages,
  sendScheduledMessage,
} from '../src/workers/handlers/scheduled-message-send.js';

const marker = `scheduled-queue-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let orgId: string;
let userId: string;
let spaceId: string;

before(async () => {
  const [org] = await db.insert(orgs).values({
    name: 'Scheduled queue reliability',
    slug: marker,
  }).returning();
  const [user] = await db.insert(users).values({
    email: `${marker}@test.local`,
    name: 'Scheduled Queue Test User',
    email_verified: true,
  }).returning();
  if (!org || !user) throw new Error('Failed to seed scheduled-message test fixture');
  orgId = org.id;
  userId = user.id;

  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'owner' });
  const [space] = await db.insert(spaces).values({
    org_id: orgId,
    name: 'Scheduled Queue Test Space',
    created_by: userId,
  }).returning();
  if (!space) throw new Error('Failed to seed scheduled-message test space');
  spaceId = space.id;
  await db.insert(spaceMembers).values({ space_id: spaceId, user_id: userId });
});

after(async () => {
  await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
  await db.delete(messages).where(and(
    eq(messages.org_id, orgId),
    sql`${messages.content} LIKE ${`${marker}%`}`,
  ));
  await db.delete(scheduledMessages).where(eq(scheduledMessages.org_id, orgId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId)));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

function validationApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId });
    await next();
  });
  app.route('/', scheduledRoutes);
  return app;
}

test('scheduled-message handler rejects missing, empty, and non-string ids', async () => {
  const invalidData = [{}, { scheduledId: '' }, { scheduledId: 42 }];
  for (const data of invalidData) {
    await assert.rejects(
      handleScheduledMessageSend({
        id: crypto.randomUUID(),
        name: 'scheduled-message-send',
        data,
        attempts: 1,
      }),
      /requires data\.scheduledId/,
    );
  }
});

test('scheduled-message route rejects malformed, past, and blank-content requests', async () => {
  const app = validationApp();
  const cases = [
    { space_id: spaceId, content: `${marker}-bad-date`, scheduled_for: 'not-a-date' },
    { space_id: spaceId, content: `${marker}-past`, scheduled_for: '2020-01-01T00:00:00.000Z' },
    { space_id: spaceId, content: '   ', scheduled_for: new Date(Date.now() + 60_000).toISOString() },
  ];

  for (const body of cases) {
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, `expected validation failure for ${JSON.stringify(body)}`);
  }
});

test('scheduled-message rehydration is deduplicated across concurrent startup scans', async () => {
  const [scheduled] = await db.insert(scheduledMessages).values({
    org_id: orgId,
    user_id: userId,
    space_id: spaceId,
    content: `${marker}-rehydrate`,
    scheduled_for: new Date(Date.now() + 60_000),
  }).returning();
  if (!scheduled) throw new Error('Failed to seed pending scheduled message');

  await Promise.all([
    rehydratePendingScheduledMessages(),
    rehydratePendingScheduledMessages(),
    rehydratePendingScheduledMessages(),
  ]);

  const rows = await db.select({ id: jobQueue.id })
    .from(jobQueue)
    .where(and(
      eq(jobQueue.org_id, orgId),
      eq(jobQueue.dedupe_key, `scheduled-message:${scheduled.id}`),
      sql`${jobQueue.status} IN ('pending', 'running')`,
    ));
  assert.equal(rows.length, 1, 'concurrent rehydration must leave one active delivery job');
});

test('scheduled-message send commits exactly one message under concurrent delivery', async () => {
  const content = `${marker}-exactly-once`;
  const [scheduled] = await db.insert(scheduledMessages).values({
    org_id: orgId,
    user_id: userId,
    space_id: spaceId,
    content,
    scheduled_for: new Date(Date.now() - 1_000),
  }).returning();
  if (!scheduled) throw new Error('Failed to seed scheduled message');

  const results = await Promise.all([
    sendScheduledMessage(scheduled.id),
    sendScheduledMessage(scheduled.id),
    sendScheduledMessage(scheduled.id),
  ]);
  assert.deepEqual(results.sort(), [false, false, true]);

  const sent = await db.select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.org_id, orgId), eq(messages.content, content)));
  assert.equal(sent.length, 1);

  const [state] = await db.select({ status: scheduledMessages.status, sentAt: scheduledMessages.sent_at })
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, scheduled.id));
  assert.equal(state?.status, 'sent');
  assert.ok(state?.sentAt instanceof Date);
  assert.equal(await sendScheduledMessage(scheduled.id), false, 'replay after commit must no-op');
});

test('scheduled-message delivery claims marker attachments into the committed message', async () => {
  const [file] = await db.insert(files).values({
    org_id: orgId,
    uploaded_by: userId,
    filename: 'scheduled.csv',
    mime_type: 'text/csv',
    size_bytes: 12,
    storage_key: `${marker}-scheduled.csv`,
  }).returning();
  if (!file) throw new Error('Failed to seed scheduled attachment');
  const content = `${marker}-attachment\n[[file:${file.id}:scheduled.csv:text/csv:12:/api/files/${file.id}]]`;
  const [scheduled] = await db.insert(scheduledMessages).values({
    org_id: orgId,
    user_id: userId,
    space_id: spaceId,
    content,
    scheduled_for: new Date(Date.now() - 1_000),
  }).returning();
  if (!scheduled) throw new Error('Failed to seed scheduled attachment message');

  try {
    assert.equal(await sendScheduledMessage(scheduled.id), true);
    const [sent] = await db.select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.org_id, orgId), eq(messages.content, content)));
    assert.ok(sent);
    const [linked] = await db.select({ message_id: files.message_id })
      .from(files)
      .where(eq(files.id, file.id));
    assert.equal(linked?.message_id, sent.id);
  } finally {
    await db.delete(files).where(eq(files.id, file.id));
    await db.delete(messages).where(and(eq(messages.org_id, orgId), eq(messages.content, content)));
    await db.delete(scheduledMessages).where(eq(scheduledMessages.id, scheduled.id));
  }
});

test('scheduled-message delivery cancels when space access was revoked', async () => {
  const revokedContent = `${marker}-revoked-access`;
  const [revokedSpace] = await db.insert(spaces).values({
    org_id: orgId,
    name: `Revoked scheduled space ${crypto.randomUUID().slice(0, 8)}`,
    created_by: userId,
  }).returning();
  if (!revokedSpace) throw new Error('Failed to seed revoked-access space');

  await db.insert(spaceMembers).values({ space_id: revokedSpace.id, user_id: userId });
  const [scheduled] = await db.insert(scheduledMessages).values({
    org_id: orgId,
    user_id: userId,
    space_id: revokedSpace.id,
    content: revokedContent,
    scheduled_for: new Date(Date.now() - 1_000),
  }).returning();
  if (!scheduled) throw new Error('Failed to seed revoked scheduled message');

  try {
    await db.delete(spaceMembers).where(and(
      eq(spaceMembers.space_id, revokedSpace.id),
      eq(spaceMembers.user_id, userId),
    ));

    assert.equal(await sendScheduledMessage(scheduled.id), false);
    const delivered = await db.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.org_id, orgId),
        eq(messages.content, revokedContent),
      ));
    assert.equal(delivered.length, 0);

    const [state] = await db.select({ status: scheduledMessages.status })
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, scheduled.id));
    assert.equal(state?.status, 'cancelled');
  } finally {
    await db.delete(messages).where(and(
      eq(messages.org_id, orgId),
      eq(messages.content, revokedContent),
    ));
    await db.delete(scheduledMessages).where(eq(scheduledMessages.id, scheduled.id));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, revokedSpace.id));
    await db.delete(spaces).where(eq(spaces.id, revokedSpace.id));
  }
});
