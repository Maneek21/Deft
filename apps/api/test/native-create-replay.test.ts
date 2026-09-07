import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { orgs, users, orgMembers, spaces, spaceMembers, projects, messages, tasks, events, taskActivity, files, messageAttachments, jobQueue, notifications, nativeCreateRequests } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';

const orgId = randomUUID(), otherOrg = randomUUID(), userId = randomUUID(), sameOrgUser = randomUUID(), otherUser = randomUUID();
const spaceId = randomUUID(), projectId = randomUUID();
let app: Hono;
before(async () => {
  await db.insert(orgs).values([{ id: orgId, name: 'Replay test', slug: `replay-${orgId}` }, { id: otherOrg, name: 'Other', slug: `replay-${otherOrg}` }]);
  await db.insert(users).values([{ id: userId, name: 'Owner', email: `${userId}@test.local` }, { id: sameOrgUser, name: 'Member', email: `${sameOrgUser}@test.local` }, { id: otherUser, name: 'Other', email: `${otherUser}@test.local` }]);
  await db.insert(orgMembers).values([{ org_id: orgId, user_id: userId, role: 'owner' }, { org_id: orgId, user_id: sameOrgUser, role: 'member' }, { org_id: otherOrg, user_id: otherUser, role: 'owner' }]);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'Replay', type: 'public', created_by: userId });
  await db.insert(spaceMembers).values([{ space_id: spaceId, user_id: userId }, { space_id: spaceId, user_id: sameOrgUser }]);
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'Replay', prefix: 'RPL', created_by: userId });
  const [{ messageRoutes }, { taskRoutes }, { projectRoutes }, { eventRoutes }] = await Promise.all([import('../src/routes/messages.js'), import('../src/routes/tasks.js'), import('../src/routes/projects.js'), import('../src/routes/events.js')]);
  app = new Hono();
  app.use('*', async (c, next) => {
    const other = c.req.header('x-test-other') === 'true';
    const sameOrgActor = c.req.header('x-test-same-org-actor') === 'true';
    c.set('user', {
      id: other ? otherUser : sameOrgActor ? sameOrgUser : userId,
      org_id: other ? otherOrg : orgId,
      email: other ? 'other@test.local' : sameOrgActor ? 'member@test.local' : 'owner@test.local',
      role: other ? 'owner' : sameOrgActor ? 'member' : 'owner',
    });
    await next();
  });
  app.route('/messages', messageRoutes); app.route('/tasks', taskRoutes); app.route('/projects', projectRoutes); app.route('/events', eventRoutes);
});

async function create(route: string, body: unknown, key?: string, other = false, sameOrgActor = false) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-test-other': String(other), 'x-test-same-org-actor': String(sameOrgActor) };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const response = await app.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test('native creates retain one identity under concurrent explicit replay without deduplicating new intents', async () => {
  for (const [route, body] of [
    [`/messages/${spaceId}`, { content: 'Same content' }],
    [`/projects/${projectId}/tasks`, { title: 'Same title' }],
    ['/events', { title: 'Same event', start: '2026-09-12T10:00:00Z', end: '2026-09-12T11:00:00Z' }],
  ] as const) {
    const key = randomUUID();
    const first = await create(route, body, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replies = await Promise.all(Array.from({ length: 8 }, () => create(route, body, key)));
    for (const reply of replies) { assert.equal(reply.status, 201); assert.equal(reply.body.id, first.body.id); }
    if ('content' in body) {
      const delivered = await db.select().from(notifications).where(and(
        eq(notifications.org_id, orgId), eq(notifications.user_id, sameOrgUser),
        sql`${notifications.metadata}->>'message_id' = ${first.body.id}`,
      ));
      assert.equal(delivered.length, 1, 'explicit replay must not duplicate recipient notifications');
      const projectionJobs = await db.select().from(jobQueue).where(and(
        eq(jobQueue.name, 'notification-attention-sync'),
        sql`${jobQueue.data}->>'orgId' = ${orgId}`,
        sql`${jobQueue.data}->'notificationIds' @> ${JSON.stringify([delivered[0]!.id])}::jsonb`,
      ));
      assert.equal(projectionJobs.length, 1, 'explicit replay must not enqueue another projection');
    }
    const distinct = await create(route, body, randomUUID());
    assert.equal(distinct.status, 201); assert.notEqual(distinct.body.id, first.body.id);
    const conflict = await create(route, { ...body, ...('content' in body ? { content: 'Changed' } : { title: 'Changed' }) }, key);
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await create(route, body, 'bad key')).status, 400);
  }
});

test('keyless creates retain legacy distinct-create behavior', async () => {
  for (const [route, body] of [
    [`/messages/${spaceId}`, { content: 'Unkeyed message' }],
    [`/projects/${projectId}/tasks`, { title: 'Unkeyed task' }],
    ['/events', { title: 'Unkeyed event', start: '2026-09-13T10:00:00Z', end: '2026-09-13T11:00:00Z' }],
  ] as const) {
    const first = await create(route, body);
    const second = await create(route, body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.id, first.body.id);
  }
});

test('the same key belongs to the current actor within an organization', async () => {
  const key = randomUUID();
  const body = { content: 'Actor-scoped replay' };
  const owner = await create(`/messages/${spaceId}`, body, key);
  const member = await create(`/messages/${spaceId}`, body, key, false, true);
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  assert.equal(member.status, 201, JSON.stringify(member.body));
  assert.notEqual(member.body.id, owner.body.id);
  assert.equal(member.body.user_id, sameOrgUser);
});

test('task aliases replay one task and one activity, with current tenant authorization', async () => {
  const key = randomUUID(), body = { title: 'Alias replay' };
  const first = await create(`/projects/${projectId}/tasks`, body, key);
  for (const [route, data] of [[`/tasks/project/${projectId}`, body], ['/tasks', { ...body, project_id: projectId }]] as const) {
    const replay = await create(route, data, key);
    assert.equal(replay.status, 201, JSON.stringify(replay.body)); assert.equal(replay.body.id, first.body.id);
  }
  assert.equal((await db.select().from(taskActivity).where(eq(taskActivity.task_id, first.body.id))).length, 1);
  assert.equal((await create(`/projects/${projectId}/tasks`, body, key, true)).status, 404);
  await db.update(tasks).set({ is_deleted: true }).where(eq(tasks.id, first.body.id));
  assert.equal((await create(`/projects/${projectId}/tasks`, body, key)).status, 404);
});

test('attachment claim is atomic with replay identity; revocation and deleted messages do not replay', async () => {
  const fileId = randomUUID();
  await db.insert(files).values({ id: fileId, org_id: orgId, uploaded_by: userId, filename: 'replay.txt', mime_type: 'text/plain', size_bytes: 1, storage_key: `replay-${fileId}` });
  const key = randomUUID(), body = { content: 'Attachment', file_ids: [fileId] };
  const first = await create(`/messages/${spaceId}`, body, key);
  const replay = await create(`/messages/${spaceId}`, body, key);
  assert.equal(first.status, 201); assert.equal(replay.body.id, first.body.id); assert.equal(replay.body.files.length, 1);
  assert.equal((await db.select().from(messageAttachments).where(eq(messageAttachments.file_id, fileId))).length, 1);
  assert.equal((await create(`/messages/${spaceId}`, body, key, true)).status, 403);
  await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, userId)));
  assert.equal((await create(`/messages/${spaceId}`, body, key)).status, 403);
  await db.insert(spaceMembers).values({ space_id: spaceId, user_id: userId });
  await db.update(messages).set({ is_deleted: true }).where(eq(messages.id, first.body.id));
  assert.equal((await create(`/messages/${spaceId}`, body, key)).status, 404);
  const failedKey = randomUUID();
  const failed = await create(`/messages/${spaceId}`, body, failedKey);
  assert.equal(failed.status, 404);
  assert.equal(failed.body.code, 'ATTACHMENT_NOT_FOUND');
  // A rolled-back attachment claim must not reserve the request identity.
  assert.equal((await create(`/messages/${spaceId}`, { content: 'Corrected after validation' }, failedKey)).status, 201);
});

test('event identity is scoped to owner and survives deletion as a tombstone', async () => {
  const key = randomUUID(), body = { title: 'Private', start: '2026-09-12T10:00:00Z', end: '2026-09-12T11:00:00Z' };
  const first = await create('/events', body, key);
  const other = await create('/events', body, key, true);
  assert.equal(other.status, 201); assert.notEqual(other.body.id, first.body.id); assert.equal(other.body.org_id, otherOrg);
  await db.delete(events).where(eq(events.id, first.body.id));
  assert.equal((await create('/events', body, key)).status, 404);
});

after(async () => {
  const ids = [orgId, otherOrg];
  await db.delete(jobQueue).where(sql`${jobQueue.data}->>'orgId' IN (${orgId}, ${otherOrg})`);
  await db.delete(notifications).where(inArray(notifications.user_id, [userId, sameOrgUser, otherUser]));
  await db.delete(messageAttachments).where(inArray(messageAttachments.org_id, ids));
  await db.delete(files).where(inArray(files.org_id, ids));
  await db.delete(messages).where(inArray(messages.org_id, ids));
  await db.delete(taskActivity).where(inArray(taskActivity.org_id, ids));
  await db.delete(tasks).where(inArray(tasks.org_id, ids));
  await db.delete(events).where(inArray(events.org_id, ids));
  await db.delete(projects).where(inArray(projects.org_id, ids));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(nativeCreateRequests).where(inArray(nativeCreateRequests.org_id, ids));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, ids));
  await db.delete(users).where(inArray(users.id, [userId, sameOrgUser, otherUser]));
  await db.delete(orgs).where(inArray(orgs.id, ids));
  await closeDb();
});
