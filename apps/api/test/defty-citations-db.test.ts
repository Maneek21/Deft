import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { messages, orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { scopeDeftyMessageSearch } from '../src/lib/agent-runner.js';
import { normalizeAgentCitations, resolveAgentCitationLink } from '../../web/src/lib/agent-citations.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
const orgId = randomUUID(), userId = randomUUID(), spaceId = randomUUID(), otherSpaceId = randomUUID(), messageId = randomUUID();

describe('clickable message source regressions', { skip: !canRun }, () => {
  before(async () => {
    await db.insert(orgs).values({ id: orgId, name: 'Sources', slug: `sources-${orgId}` });
    await db.insert(users).values({ id: userId, name: 'Mehta, Rahul' });
    await db.insert(orgMembers).values({ org_id: orgId, user_id: userId });
    await db.insert(spaces).values([spaceId, otherSpaceId].map(id => ({ id, org_id: orgId, name: 'engineering', type: 'public' })));
    await db.insert(spaceMembers).values([spaceId, otherSpaceId].map(id => ({ space_id: id, user_id: userId })));
    await db.insert(messages).values({ id: messageId, org_id: orgId, space_id: spaceId, user_id: userId, content: 'rollback source' });
  });
  after(async () => {
    await db.delete(messages).where(eq(messages.org_id, orgId));
    await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [spaceId, otherSpaceId]));
    await db.delete(spaces).where(eq(spaces.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await closeDb();
  });
  test('search message source metadata survives the actual renderer link resolver', async () => {
    const response = await executeToolCall('search_messages', { space_id: spaceId, query: 'rollback' }, orgId, userId);
    const url = `/chat?space=${spaceId}&message=${messageId}`;
    assert.equal(response.citations.length, 1);
    assert.equal(normalizeAgentCitations(response.citations).length, 1);
    assert.equal(resolveAgentCitationLink(url, response.citations), url);
  });
  test('blocker message citations survive the actual renderer link resolver', async () => {
    const response = await executeToolCall('search_blockers', { query: 'rollback' }, orgId, userId);
    const url = `/chat?space=${spaceId}&message=${messageId}`;
    assert.equal(response.citations.length, 1);
    assert.equal(response.result[0].space_id, spaceId);
    assert.equal(normalizeAgentCitations(response.citations).length, 1);
    assert.equal(resolveAgentCitationLink(url, response.citations), url);
  });
  test('verified current-room searches succeed when readable rooms share a name', async () => {
    const params = scopeDeftyMessageSearch({ query: 'rollback' }, 'Find the rollback source here',
      { type: 'public', name: 'engineering' }, spaceId);
    const response = await executeToolCall('search_messages', params, orgId, userId, spaceId);
    assert.equal(response.result?.code, undefined);
    assert.deepEqual(response.result.map((row: { id: string }) => row.id), [messageId]);
  });
});
