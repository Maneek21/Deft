import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  files,
  jobQueue,
  messages,
  notifications,
  orgMembers,
  orgs,
  spaceMembers,
  spaces,
  users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';

let app: Hono;
let orgId: string;
let otherOrgId: string;
let userId: string;
let otherUserId: string;
let crossOrgUserId: string;
let spaceId: string;

const createdFileIds: string[] = [];
const createdMessageIds: string[] = [];

async function createUnattachedFile(params: {
  orgId?: string;
  uploadedBy?: string;
  filename?: string;
} = {}) {
  const [file] = await db.insert(files).values({
    org_id: params.orgId ?? orgId,
    uploaded_by: params.uploadedBy ?? userId,
    filename: params.filename ?? 'contacts.csv',
    mime_type: 'text/csv',
    size_bytes: 24,
    storage_key: `message-attachment-${Date.now()}-${Math.random()}.csv`,
  }).returning();
  createdFileIds.push(file!.id);
  return file!;
}

async function postMessage(body: Record<string, unknown>) {
  return app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const stamp = Date.now();
  const [org, otherOrg] = await db.insert(orgs).values([
    { name: 'Message Attachment Test', slug: `message-attachment-${stamp}` },
    { name: 'Message Attachment Other Org', slug: `message-attachment-other-${stamp}` },
  ]).returning();
  orgId = org!.id;
  otherOrgId = otherOrg!.id;

  const [user, otherUser, crossOrgUser] = await db.insert(users).values([
    { email: `message-attachment-${stamp}@test.local`, name: 'Attachment Owner', email_verified: true },
    { email: `message-attachment-other-${stamp}@test.local`, name: 'Other Uploader', email_verified: true },
    { email: `message-attachment-cross-${stamp}@test.local`, name: 'Cross Org Uploader', email_verified: true },
  ]).returning();
  userId = user!.id;
  otherUserId = otherUser!.id;
  crossOrgUserId = crossOrgUser!.id;

  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: userId, role: 'owner' },
    { org_id: orgId, user_id: otherUserId, role: 'member' },
    { org_id: otherOrgId, user_id: crossOrgUserId, role: 'owner' },
  ]);

  const [space] = await db.insert(spaces).values({
    org_id: orgId,
    name: 'attachment-test',
    type: 'public',
    created_by: userId,
  }).returning();
  spaceId = space!.id;
  await db.insert(spaceMembers).values({ space_id: spaceId, user_id: userId });

  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      org_id: orgId,
      email: `message-attachment-${stamp}@test.local`,
      name: 'Attachment Owner',
    } as never);
    await next();
  });
  app.route('/api/messages', messageRoutes);
});

after(async () => {
  if (createdFileIds.length > 0) {
    await db.delete(files).where(inArray(files.id, createdFileIds));
  }
  await db.delete(jobQueue).where(sql`${jobQueue.data}->>'orgId' IN (${orgId}, ${otherOrgId})`);
  await db.delete(notifications).where(inArray(notifications.user_id, [userId, otherUserId, crossOrgUserId]));
  await db.delete(messages).where(eq(messages.space_id, spaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgId, otherOrgId]));
  await db.delete(users).where(inArray(users.id, [userId, otherUserId, crossOrgUserId]));
  await db.delete(orgs).where(inArray(orgs.id, [orgId, otherOrgId]));
});

test('claims an uploaded file atomically and returns canonical structured metadata', async () => {
  const file = await createUnattachedFile();
  const response = await postMessage({ content: 'Please inspect the attachment.', file_ids: [file.id] });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  createdMessageIds.push(body.id);
  assert.deepEqual(body.file_ids, [file.id]);
  assert.deepEqual(body.files, [{
    id: file.id,
    name: 'contacts.csv',
    type: 'text/csv',
    size: 24,
    url: `/api/files/${file.id}`,
  }]);

  const [linked] = await db.select({ message_id: files.message_id })
    .from(files)
    .where(eq(files.id, file.id));
  assert.equal(linked!.message_id, body.id);

  const listResponse = await app.request(`/api/messages/${spaceId}`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as any;
  const listed = listBody.messages.find((message: any) => message.id === body.id);
  assert.deepEqual(listed.file_ids, [file.id]);
  assert.equal(listed.files[0].name, 'contacts.csv');
});

test('rejects another uploader or another org file without persisting a message', async () => {
  const otherUserFile = await createUnattachedFile({ uploadedBy: otherUserId });
  const crossOrgFile = await createUnattachedFile({ orgId: otherOrgId, uploadedBy: crossOrgUserId });

  for (const [fileId, content] of [
    [otherUserFile.id, 'unauthorized other uploader'],
    [crossOrgFile.id, 'unauthorized other org'],
  ]) {
    const response = await postMessage({ content, file_ids: [fileId] });
    assert.equal(response.status, 404);
    const [persisted] = await db.select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.space_id, spaceId), eq(messages.content, content)));
    assert.equal(persisted!.count, 0);
  }
});

test('prevents attachment reuse and rolls back the losing message', async () => {
  const file = await createUnattachedFile();
  const first = await postMessage({ content: 'first claim', file_ids: [file.id] });
  assert.equal(first.status, 201);
  createdMessageIds.push(((await first.json()) as any).id);

  const second = await postMessage({ content: 'second claim', file_ids: [file.id] });
  assert.equal(second.status, 404);
  const [persisted] = await db.select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.space_id, spaceId), eq(messages.content, 'second claim')));
  assert.equal(persisted!.count, 0);
});

test('legacy markers claim by id but never trust marker metadata', async () => {
  const file = await createUnattachedFile({ filename: 'canonical.csv' });
  const content = `Legacy client\n[[file:${file.id}:spoofed.exe:application/x-msdownload:999999:/evil]]`;
  const response = await postMessage({ content });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  createdMessageIds.push(body.id);
  assert.deepEqual(body.file_ids, [file.id]);
  assert.equal(body.files[0].name, 'canonical.csv');
  assert.equal(body.files[0].type, 'text/csv');
  assert.equal(body.files[0].size, 24);
  assert.equal(body.files[0].url, `/api/files/${file.id}`);
});
