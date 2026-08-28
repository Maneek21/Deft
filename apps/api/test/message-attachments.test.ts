import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attachmentDerivatives,
  files,
  jobQueue,
  messageAttachments,
  messages,
  notifications,
  orgMembers,
  orgs,
  spaceMembers,
  spaces,
  users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { sweepExpiredStagedAttachments } from '../src/lib/attachment-retention.js';
import { localFileStore } from '../src/lib/file-store.js';

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
  const { fileServingRoutes, uploadRoutes } = await import('../src/routes/upload.js');
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
  app.route('/api/upload', uploadRoutes);
  app.route('/api/files', fileServingRoutes);
});

after(async () => {
  const storedFiles = createdFileIds.length > 0
    ? await db.select({ storage_key: files.storage_key })
      .from(files)
      .where(inArray(files.id, createdFileIds))
    : [];
  if (createdFileIds.length > 0) {
    await db.delete(files).where(inArray(files.id, createdFileIds));
  }
  await Promise.all(storedFiles.map((file) => (
    rm(join(process.cwd(), 'uploads', file.storage_key), { force: true })
  )));
  await db.delete(jobQueue).where(sql`${jobQueue.data}->>'orgId' IN (${orgId}, ${otherOrgId})`);
  await db.delete(notifications).where(inArray(notifications.user_id, [userId, otherUserId, crossOrgUserId]));
  await db.delete(messages).where(eq(messages.space_id, spaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgId, otherOrgId]));
  await db.delete(users).where(inArray(users.id, [userId, otherUserId, crossOrgUserId]));
  await db.delete(orgs).where(inArray(orgs.id, [orgId, otherOrgId]));
});

test('processes uploaded text into a bounded derivative and serves detected bytes', async () => {
  const content = 'project,task\nLaunch,Verify\n';
  const form = new FormData();
  form.append('file', new File([content], 'plan.csv', { type: 'application/vnd.ms-excel' }));
  const response = await app.request('/api/upload', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  createdFileIds.push(body.id);
  assert.equal(body.detected_type, 'text/csv');
  assert.equal(body.kind, 'spreadsheet');
  assert.equal(body.processing_status, 'ready');
  assert.equal(body.processing_error, null);

  const [record] = await db.select({
    content_sha256: files.content_sha256,
    processing_status: files.processing_status,
    staged_expires_at: files.staged_expires_at,
  }).from(files).where(eq(files.id, body.id));
  assert.match(record!.content_sha256!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record!.processing_status, 'ready');
  assert.ok(record!.staged_expires_at);

  const [derivative] = await db.select()
    .from(attachmentDerivatives)
    .where(and(
      eq(attachmentDerivatives.org_id, orgId),
      eq(attachmentDerivatives.file_id, body.id),
    ));
  assert.equal(derivative?.content, content);

  const download = await app.request(`/api/files/${body.id}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/csv');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await download.text(), content);

  const claim = await postMessage({ content: 'Please read this plan.', file_ids: [body.id] });
  assert.equal(claim.status, 201);
  const claimBody = await claim.json() as any;
  createdMessageIds.push(claimBody.id);
  const [claimed] = await db.select({ staged_expires_at: files.staged_expires_at })
    .from(files)
    .where(eq(files.id, body.id));
  assert.equal(claimed!.staged_expires_at, null);
});

test('persists but never serves an attachment blocked by safety policy', async () => {
  const form = new FormData();
  form.append('file', new File(['harmless-looking text'], 'payload.exe', { type: 'text/plain' }));
  const response = await app.request('/api/upload', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  createdFileIds.push(body.id);
  assert.equal(body.processing_status, 'blocked');
  assert.equal(body.processing_error, 'unsafe_executable');

  const download = await app.request(`/api/files/${body.id}`);
  assert.equal(download.status, 423);
  assert.equal((await download.json() as any).code, 'FILE_BLOCKED');

  const deletion = await app.request(`/api/files/${body.id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { success: true, storage_cleanup: 'complete' });
  assert.equal((await app.request(`/api/files/${body.id}`)).status, 404);
});

test('sweeps only expired uploads that remain unattached', async () => {
  const form = new FormData();
  form.append('file', new File(['temporary'], 'temporary.txt', { type: 'text/plain' }));
  const response = await app.request('/api/upload', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const body = await response.json() as any;
  createdFileIds.push(body.id);
  const [record] = await db.update(files)
    .set({ staged_expires_at: new Date(Date.now() - 1_000) })
    .where(eq(files.id, body.id))
    .returning({ storage_key: files.storage_key });

  const result = await sweepExpiredStagedAttachments();
  assert.deepEqual(result, { deletedRows: 1, deletedBytes: 1, orphanedStorageKeys: [] });
  assert.equal(await localFileStore.stat(record!.storage_key), null);
  assert.equal((await db.select().from(files).where(eq(files.id, body.id))).length, 0);
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
  const [typedLink] = await db.select()
    .from(messageAttachments)
    .where(and(
      eq(messageAttachments.message_id, body.id),
      eq(messageAttachments.file_id, file.id),
    ));
  assert.equal(typedLink?.org_id, orgId);
  assert.equal(typedLink?.position, 0);

  const listResponse = await app.request(`/api/messages/${spaceId}`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as any;
  const listed = listBody.messages.find((message: any) => message.id === body.id);
  assert.deepEqual(listed.file_ids, [file.id]);
  assert.equal(listed.files[0].name, 'contacts.csv');
});

test('reads a typed-only attachment without requiring the legacy message column', async () => {
  const file = await createUnattachedFile({ filename: 'typed-only.csv' });
  const [message] = await db.insert(messages).values({
    org_id: orgId,
    space_id: spaceId,
    user_id: userId,
    content: 'typed-only attachment',
  }).returning();
  createdMessageIds.push(message!.id);
  await db.insert(messageAttachments).values({
    org_id: orgId,
    message_id: message!.id,
    file_id: file.id,
    position: 0,
  });

  const response = await app.request(`/api/messages/${spaceId}`);
  assert.equal(response.status, 200);
  const listed = ((await response.json()) as any).messages.find((row: any) => row.id === message!.id);
  assert.deepEqual(listed.file_ids, [file.id]);
  assert.equal(listed.files[0].name, 'typed-only.csv');
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
