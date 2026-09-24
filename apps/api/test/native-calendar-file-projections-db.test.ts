import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { connectedAccounts, events, files, messageAttachments, messages,
  orgMembers, orgs, projects, spaceMembers, spaces, taskAttachments, tasks, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { getVisibleAttachment } from '../src/lib/attachment-access.js';
import { resolveNativeCalendarDisplay, resolveNativeFileDisplay } from
  '../src/lib/native-calendar-file-projections.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c0(?:3b|4)_(?:public|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);

test('native Calendar and File display uses current event owner and attachment parent ACLs',
  { skip: !safe }, async () => {
    const marker = randomUUID();
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const ownerId = randomUUID();
    const peerId = randomUUID();
    const accountId = randomUUID();
    const spaceId = randomUUID();
    const foreignSpaceId = randomUUID();
    const messageId = randomUUID();
    const malformedMessageId = randomUUID();
    const projectId = randomUUID();
    const foreignProjectId = randomUUID();
    const taskId = randomUUID();
    const malformedTaskId = randomUUID();
    const attachedId = randomUUID();
    const stagedId = randomUUID();
    const taskFileId = randomUUID();
    const malformedMessageFileId = randomUUID();
    const malformedTaskFileId = randomUUID();
    const legacyBadId = randomUUID();
    const ids = { native: randomUUID(), ics: randomUUID(), connected: randomUUID(),
      peer: randomUUID(), nonCalendar: randomUUID(), foreign: randomUUID() };
    const owner = { org_id: orgId, user_id: ownerId, role: 'member' as const };
    const peer = { org_id: orgId, user_id: peerId, role: 'member' as const };
    const foreign = { org_id: foreignOrgId, user_id: peerId, role: 'member' as const };
    const when = new Date('2037-06-15T12:00:00.000Z');
    try {
      await db.insert(orgs).values([
        { id: orgId, name: 'Native display owner fixture', slug: `${marker}-org` },
        { id: foreignOrgId, name: 'Foreign display fixture', slug: `${marker}-foreign` },
      ]);
      await db.insert(users).values([
        { id: ownerId, email: `${marker}-owner@example.test`, name: 'Owner' },
        { id: peerId, email: `${marker}-peer@example.test`, name: 'Peer' },
      ]);
      await db.insert(orgMembers).values([ownerId, peerId].map(userId => ({
        id: randomUUID(), org_id: orgId, user_id: userId, role: 'member' as const,
      })));
      await db.insert(connectedAccounts).values({ id: accountId, org_id: orgId,
        user_id: ownerId, provider: 'google_calendar',
        provider_account_id: `${marker}-account`, access_token_encrypted: 'synthetic-test-only' });
      const event = (id: string, eventOrg: string, source: 'native' | 'ics' | 'google_calendar' | 'github',
        eventType: string, title: string, userId: string | null, connectedId: string | null = null) => ({
        id, org_id: eventOrg, source, event_type: eventType, title, timestamp: when,
        metadata: { synthetic: true }, user_id: userId, connected_account_id: connectedId,
      });
      await db.insert(events).values([
        event(ids.native, orgId, 'native', 'calendar_event', 'Native owner event', ownerId),
        event(ids.ics, orgId, 'ics', 'calendar_event', 'ICS owner event', ownerId),
        event(ids.connected, orgId, 'google_calendar', 'calendar_event', 'Connected owner event', null, accountId),
        event(ids.peer, orgId, 'native', 'calendar_event', 'Private peer event', peerId),
        event(ids.nonCalendar, orgId, 'github', 'pr_opened', 'Owner noncalendar event', ownerId),
        event(ids.foreign, foreignOrgId, 'native', 'calendar_event', 'Foreign event', null),
      ]);
      await db.insert(spaces).values([
        { id: spaceId, org_id: orgId, name: 'Private fixture space', type: 'private', created_by: ownerId },
        { id: foreignSpaceId, org_id: foreignOrgId, name: 'Malformed foreign parent',
          type: 'private', created_by: ownerId },
      ]);
      await db.insert(spaceMembers).values([
        { id: randomUUID(), space_id: spaceId, user_id: ownerId },
        { id: randomUUID(), space_id: foreignSpaceId, user_id: ownerId },
      ]);
      await db.insert(messages).values([
        { id: messageId, org_id: orgId, space_id: spaceId, user_id: ownerId,
          content: 'Private fixture parent' },
        { id: malformedMessageId, org_id: orgId, space_id: foreignSpaceId,
          user_id: ownerId, content: 'Malformed cross-org parent' },
      ]);
      await db.insert(projects).values([
        { id: projectId, org_id: orgId, name: 'Task parent', prefix: 'OWN', lead_id: ownerId },
        { id: foreignProjectId, org_id: foreignOrgId, name: 'Foreign Task parent',
          prefix: 'FRN', lead_id: ownerId },
      ]);
      await db.insert(tasks).values([
        { id: taskId, org_id: orgId, project_id: projectId, number: 1,
          title: 'Visible parent task', created_by: ownerId },
        { id: malformedTaskId, org_id: orgId, project_id: foreignProjectId, number: 1,
          title: 'Malformed cross-org task', created_by: ownerId },
      ]);
      await db.insert(files).values([
        { id: attachedId, org_id: orgId, uploaded_by: peerId,
          filename: 'private-attachment.txt', mime_type: 'text/plain', size_bytes: 10,
          storage_key: `synthetic-${attachedId}`, processing_status: 'ready' },
        { id: stagedId, org_id: orgId, uploaded_by: ownerId,
          filename: 'staged-owner.txt', mime_type: 'text/plain', size_bytes: 10,
          storage_key: `synthetic-${stagedId}`, processing_status: 'ready' },
        { id: taskFileId, org_id: orgId, uploaded_by: ownerId,
          filename: 'task-attachment.txt', mime_type: 'text/plain', size_bytes: 10,
          storage_key: `synthetic-${taskFileId}`, processing_status: 'ready' },
        { id: malformedMessageFileId, org_id: orgId, uploaded_by: ownerId,
          filename: 'wrong-space.txt', mime_type: 'text/plain', size_bytes: 10,
          storage_key: `synthetic-${malformedMessageFileId}`, processing_status: 'ready' },
        { id: malformedTaskFileId, org_id: orgId, uploaded_by: ownerId,
          filename: 'wrong-project.txt', mime_type: 'text/plain', size_bytes: 10,
          storage_key: `synthetic-${malformedTaskFileId}`, processing_status: 'ready' },
        { id: legacyBadId, org_id: orgId, uploaded_by: ownerId,
          filename: 'legacy-wrong-space.txt', mime_type: 'text/plain', size_bytes: 10,
          storage_key: `synthetic-${legacyBadId}`, processing_status: 'ready',
          message_id: malformedMessageId },
      ]);
      await db.insert(messageAttachments).values([
        { org_id: orgId, message_id: messageId, file_id: attachedId, position: 0 },
        { org_id: orgId, message_id: malformedMessageId, file_id: malformedMessageFileId, position: 0 },
      ]);
      await db.insert(taskAttachments).values([
        { org_id: orgId, task_id: taskId, file_id: taskFileId, position: 0 },
        { org_id: orgId, task_id: malformedTaskId, file_id: malformedTaskFileId, position: 0 },
      ]);

      for (const id of [ids.native, ids.ics, ids.connected]) {
        const display = await resolveNativeCalendarDisplay(owner, id);
        assert.ok(display?.label);
        assert.match(display.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(Object.keys(display).sort(), ['label', 'updated_at']);
      }
      for (const id of [ids.peer, ids.nonCalendar, ids.foreign]) {
        assert.equal(await resolveNativeCalendarDisplay(owner, id), null);
      }
      assert.equal(await resolveNativeCalendarDisplay(foreign, ids.native), null);
      assert.equal((await resolveNativeCalendarDisplay(peer, ids.peer))?.label, 'Private peer event');

      assert.equal((await resolveNativeFileDisplay(owner, attachedId))?.label, 'private-attachment.txt');
      assert.equal(await resolveNativeFileDisplay(peer, attachedId), null);
      assert.equal(await resolveNativeFileDisplay(foreign, attachedId), null);
      assert.equal((await resolveNativeFileDisplay(owner, stagedId))?.label, 'staged-owner.txt');
      assert.equal(await resolveNativeFileDisplay(peer, stagedId), null);
      assert.equal((await resolveNativeFileDisplay(owner, taskFileId))?.label, 'task-attachment.txt');
      // Existing direct owner helper does not validate Space/Project org on
      // these malformed parent rows; the App-facing leaf must fail closed.
      assert.ok(await getVisibleAttachment(malformedMessageFileId, orgId, ownerId));
      assert.ok(await getVisibleAttachment(malformedTaskFileId, orgId, ownerId));
      assert.ok(await getVisibleAttachment(legacyBadId, orgId, ownerId));
      assert.equal(await resolveNativeFileDisplay(owner, malformedMessageFileId), null);
      assert.equal(await resolveNativeFileDisplay(owner, malformedTaskFileId), null);
      assert.equal(await resolveNativeFileDisplay(owner, legacyBadId), null);
      const fileDisplay = await resolveNativeFileDisplay(owner, attachedId);
      assert.deepEqual(Object.keys(fileDisplay ?? {}).sort(), ['label', 'updated_at']);
      assert.equal(JSON.stringify(fileDisplay).includes('synthetic-'), false);
      await db.insert(taskAttachments).values({ org_id: orgId, task_id: taskId,
        file_id: attachedId, position: 1 });
      assert.equal(await resolveNativeFileDisplay(owner, attachedId), null);
      await db.delete(taskAttachments).where(and(eq(taskAttachments.org_id, orgId),
        eq(taskAttachments.file_id, attachedId)));
      await db.insert(spaceMembers).values({ id: randomUUID(), space_id: spaceId, user_id: peerId });
      assert.equal((await resolveNativeFileDisplay(peer, attachedId))?.label, 'private-attachment.txt');
      await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, peerId)));
      assert.equal(await resolveNativeFileDisplay(peer, attachedId), null);
      await db.update(files).set({ processing_status: 'blocked' }).where(eq(files.id, attachedId));
      assert.equal(await resolveNativeFileDisplay(owner, attachedId), null);

      await db.update(connectedAccounts).set({ user_id: peerId }).where(eq(connectedAccounts.id, accountId));
      assert.equal(await resolveNativeCalendarDisplay(owner, ids.connected), null);
      assert.equal((await resolveNativeCalendarDisplay(peer, ids.connected))?.label, 'Connected owner event');
      await db.update(orgMembers).set({ is_active: false }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerId)));
      assert.equal(await resolveNativeCalendarDisplay(owner, ids.native), null);
    } finally {
      const fileIds = [attachedId, stagedId, taskFileId, malformedMessageFileId,
        malformedTaskFileId, legacyBadId];
      await db.delete(messageAttachments).where(inArray(messageAttachments.file_id, fileIds));
      await db.delete(taskAttachments).where(inArray(taskAttachments.file_id, fileIds));
      await db.delete(files).where(inArray(files.id, fileIds));
      await db.delete(messages).where(inArray(messages.id, [messageId, malformedMessageId]));
      await db.delete(tasks).where(inArray(tasks.id, [taskId, malformedTaskId]));
      await db.delete(projects).where(inArray(projects.id, [projectId, foreignProjectId]));
      await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [spaceId, foreignSpaceId]));
      await db.delete(spaces).where(inArray(spaces.id, [spaceId, foreignSpaceId]));
      await db.delete(events).where(inArray(events.id, Object.values(ids)));
      await db.delete(connectedAccounts).where(eq(connectedAccounts.id, accountId));
      await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
      await db.delete(users).where(inArray(users.id, [ownerId, peerId]));
      await db.delete(orgs).where(inArray(orgs.id, [orgId, foreignOrgId]));
    }
  });
