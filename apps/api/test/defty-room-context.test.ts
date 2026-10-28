import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { messages, orgMembers, orgs, projects, projectSpaces, spaceMembers, spaces, tasks, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { buildRoomContextPack, formatRoomContextPack } from '../src/lib/defty-room-context.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const orgId = randomUUID();
const otherOrgId = randomUUID();
const requesterId = randomUUID();
const rahulId = randomUUID();
const outsiderId = randomUUID();
const spaceId = randomUUID();
const privateSpaceId = randomUUID();
const projectId = randomUUID();
const triggerTime = new Date('2026-10-22T09:30:00Z');
const canRun = Boolean(safeTestDatabaseUrl());

describe('room context database', { skip: !canRun }, () => {
before(async () => {
  if (!canRun) return;
  await db.insert(orgs).values([
    { id: orgId, name: 'Room context', slug: `room-${orgId}` },
    { id: otherOrgId, name: 'Other tenant', slug: `room-${otherOrgId}` },
  ]);
  await db.insert(users).values([
    { id: requesterId, name: 'Priya Shah' },
    { id: rahulId, name: 'Rahul Mehta' },
    { id: outsiderId, name: 'Other tenant person' },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: requesterId }, { org_id: orgId, user_id: rahulId },
    { org_id: otherOrgId, user_id: outsiderId },
  ]);
  await db.insert(spaces).values([
    { id: spaceId, org_id: orgId, name: 'launch', type: 'public' },
    { id: privateSpaceId, org_id: orgId, name: 'private', type: 'private' },
  ]);
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: requesterId }, { space_id: spaceId, user_id: rahulId },
    { space_id: privateSpaceId, user_id: rahulId },
    { space_id: spaceId, user_id: outsiderId },
  ]);
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'Deft v1', prefix: 'DEFT' });
  await db.insert(projectSpaces).values({ project_id: projectId, space_id: spaceId });
  await db.insert(tasks).values([
    { org_id: orgId, project_id: projectId, number: 13, title: 'Review: feat(auth) — server-side logout',
      status: 'in_review', assignee_id: rahulId, created_by: rahulId },
    { org_id: orgId, project_id: projectId, number: 14, title: 'Restricted payroll task',
      created_by: rahulId, metadata: { visibility: 'restricted' } },
  ]);
});

after(async () => {
  if (!canRun) return;
  await db.delete(tasks).where(eq(tasks.org_id, orgId));
  await db.delete(messages).where(eq(messages.org_id, orgId));
  await db.delete(projectSpaces).where(eq(projectSpaces.project_id, projectId));
  await db.delete(projects).where(eq(projects.org_id, orgId));
  await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [spaceId, privateSpaceId]));
  await db.delete(spaces).where(eq(spaces.org_id, orgId));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgId, otherOrgId]));
  await db.delete(orgs).where(inArray(orgs.id, [orgId, otherOrgId]));
  await db.delete(users).where(inArray(users.id, [requesterId, rahulId, outsiderId]));
  await closeDb();
});

async function seed(content: string, minutesBefore: number, input: { spaceId?: string; parentId?: string } = {}) {
  const id = randomUUID();
  await db.insert(messages).values({ id, org_id: orgId, space_id: input.spaceId ?? spaceId,
    user_id: rahulId, content, parent_id: input.parentId,
    created_at: new Date(triggerTime.getTime() - minutesBefore * 60_000) });
  return id;
}

test('room context pack includes preceding channel discussion for a fresh top-level mention', { skip: !canRun }, async () => {
  const bodies = ['first plan', 'second detail', 'third owner', 'fourth due date', 'fifth DEFT-13 and DEFT-14'];
  for (let index = 0; index < bodies.length; index++) await seed(bodies[index]!, 10 - index);
  const triggerMessageId = await seed('@Defty catch me up', 0);
  await seed('future message must not appear', -1);
  const result = await buildRoomContextPack({ orgId, spaceId, threadParentId: null, triggerMessageId, requesterId });
  assert.ok(result);
  let last = -1;
  for (const body of bodies) {
    const position = result.indexOf(body);
    assert.ok(position > last, `${body} appears in chronological order`);
    last = position;
  }
  assert.match(result, /Rahul Mehta/);
  assert.match(result, /People in this channel:.*Priya Shah.*Rahul Mehta/);
  assert.match(result, /Projects:.*Deft v1.*single accessible project/i);
  assert.match(result, /DEFT-13 "Review: feat\(auth\) — server-side logout".*in_review.*Rahul Mehta/);
  assert.doesNotMatch(result, /Restricted payroll task|Other tenant person|future message must not appear/);
});

test('room context pack excludes spaces the requester cannot read and is bounded', { skip: !canRun }, async () => {
  for (let index = 0; index < 40; index++) await seed(`bounded-${index.toString().padStart(2, '0')}: ${'x'.repeat(600)}`, 60 - index);
  const privateTrigger = await seed('private confidential body', 0, { spaceId: privateSpaceId });
  const triggerMessageId = await seed('@Defty read this room', 0);
  const result = await buildRoomContextPack({ orgId, spaceId, threadParentId: null, triggerMessageId, requesterId });
  assert.ok(result);
  assert.ok((result.match(/bounded-\d\d:/g) ?? []).length <= 30);
  assert.ok(result.length <= 12_000);
  assert.doesNotMatch(result, /private confidential body|Other tenant person/);
  assert.equal(await buildRoomContextPack({ orgId, spaceId: privateSpaceId, threadParentId: null,
    triggerMessageId: privateTrigger, requesterId }), null);
  assert.equal(await buildRoomContextPack({ orgId: otherOrgId, spaceId, threadParentId: null,
    triggerMessageId, requesterId: outsiderId }), null);
});

test('room context pack includes thread history only up to its trigger', { skip: !canRun }, async () => {
  const root = await seed('thread root plan', 5);
  await seed('thread prior answer', 4, { parentId: root });
  const triggerMessageId = await seed('@Defty thread question', 3, { parentId: root });
  await seed('thread future answer', 2, { parentId: root });
  const result = await buildRoomContextPack({ orgId, spaceId, threadParentId: root, triggerMessageId, requesterId });
  assert.ok(result);
  assert.match(result, /thread root plan/);
  assert.match(result, /thread prior answer/);
  assert.match(result, /@Defty thread question/);
  assert.doesNotMatch(result, /thread future answer/);
});

});

test('room context formatting bounds message bodies and the complete pack', () => {
  const input = {
    spaceId: 'launch', triggerTime,
    people: ['Priya Shah'], projects: [{ id: 'project', name: 'Deft v1', prefix: 'DEFT', linked: false }], tasks: [],
    messages: Array.from({ length: 40 }, (_, index) => ({ id: `message-${index}`, author: 'Rahul Mehta',
      content: `body-${index}: ${'x'.repeat(600)}`, createdAt: new Date(triggerTime.getTime() - (40 - index) * 60_000),
      replyCount: 0, parentId: null })),
    thread: [],
  };
  const result = formatRoomContextPack(input);
  assert.ok(result.length <= 12_000);
  const messageLines = result.split('\n').filter(line => line.includes('body-'));
  assert.ok(messageLines.length > 0 && messageLines.length <= 30);
  for (const line of messageLines) assert.ok(line.slice(line.indexOf('body-')).length <= 400);
  assert.match(result, /Rahul Mehta, \d+m ago/);
});


test('room context counts an older thread root toward the top-level limit', () => {
  const root = { id: 'root', author: 'Rahul Mehta', content: 'original thread root',
    createdAt: new Date(triggerTime.getTime() - 60 * 60_000), replyCount: 1, parentId: null };
  const recent = Array.from({ length: 30 }, (_, index) => ({ ...root, id: `recent-${index}`,
    content: `recent top-level ${index}`, createdAt: new Date(triggerTime.getTime() - (40 - index) * 60_000) }));
  const result = formatRoomContextPack({ spaceId, triggerTime, people: [], projects: [], tasks: [],
    messages: recent, thread: [root] });
  assert.match(result, /original thread root/);
  assert.equal((result.match(/recent top-level/g) ?? []).length, 29);
});
