import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFollowThread, type ThreadFollowContext, type ThreadFollowInput } from '../src/lib/defty-thread-follow.js';

const now = new Date('2026-10-22T09:30:00.000Z');
const input: ThreadFollowInput = {
  orgId: 'org', spaceId: 'space', triggerMessageId: 'trigger',
  spaceType: 'public', parentId: 'root', authorId: 'human',
  content: 'Deft v1', mentionsHuman: false,
};
const deftyMessage = { userId: 'defty', createdAt: new Date('2026-10-22T09:29:00.000Z') };
function context(overrides: Partial<ThreadFollowContext> = {}): ThreadFollowContext {
  return { deftyUserId: 'defty', authorIsHuman: true, latest: deftyMessage, pending: null, ...overrides };
}
async function follows(overrides: Partial<ThreadFollowInput> = {}, state = context()): Promise<boolean> {
  return shouldFollowThread({ ...input, ...overrides }, { loadContext: async () => state, now: () => now });
}

test('human reply directly after a Defty message in a channel thread dispatches agent-reply', async () => {
  assert.equal(await follows(), true);
  assert.equal(await follows({ spaceType: 'private' }), true);
  assert.equal(await follows({ spaceType: 'group_dm' }), true);
});
test("human reply after another human's message in the same thread does not dispatch", async () => {
  assert.equal(await follows({}, context({ latest: { ...deftyMessage, userId: 'another-human' } })), false);
});
test('reply that @mentions another human does not dispatch', async () => {
  assert.equal(await follows({ content: '<@another-human|Rahul> what do you think?', mentionsHuman: true }), false);
});
test('reply structurally addressed to another agent does not dispatch', async () => {
  assert.equal(await follows({ content: '<@byoa-agent|Build Agent> please inspect this', mentionsHuman: false }), false);
  assert.equal(await follows({ content: '<span data-mention-uuid="byoa-agent">@Build Agent</span>', mentionsHuman: false }), false);
});

test('reply addressing another thread participant by first name does not dispatch', async () => {
  const state = context({ participantFirstNames: ['Rahul'] });
  assert.equal(await follows({ content: 'Rahul, can you pair with me on that tomorrow?' }, state), false);
  assert.equal(await follows({ content: '<p>rahul: can you pair with me?</p>' }, state), false);
  assert.equal(await follows({ content: 'Deft v1; Rahul can take it' }, state), true);
});
test('reply after the 30-minute window does not dispatch', async () => {
  assert.equal(await follows({}, context({ latest: { ...deftyMessage, createdAt: new Date('2026-10-22T08:59:59.999Z') } })), false);
  assert.equal(await follows({}, context({ latest: { ...deftyMessage, createdAt: new Date('2026-10-22T09:00:00.000Z') } })), false);
});
test('an unresolved Defty question follows its requester after an intervening human reply', async () => {
  const pending: NonNullable<ThreadFollowContext['pending']> = { requesterId: 'human', createdAt: deftyMessage.createdAt, resolvedAt: null };
  assert.equal(await follows({}, context({ latest: { ...deftyMessage, userId: 'another-human' }, pending })), true);
  assert.equal(await follows({ mentionsHuman: true }, context({ pending })), false);
  assert.equal(await follows({}, context({ latest: { ...deftyMessage, userId: 'another-human' }, pending: { ...pending, requesterId: 'another-human' } })), false);
});
test('resolved or stale Defty questions do not keep a human conversation engaged', async () => {
  const state = context({ latest: { ...deftyMessage, userId: 'another-human' } });
  assert.equal(await follows({}, { ...state, pending: { requesterId: 'human', createdAt: deftyMessage.createdAt, resolvedAt: now } }), false);
  assert.equal(await follows({}, { ...state, pending: { requesterId: 'human', createdAt: new Date('2026-10-22T08:59:00Z'), resolvedAt: null } }), false);
});
test('only Defty identity and human authors can continue a thread', async () => {
  assert.equal(await follows({}, context({ latest: { ...deftyMessage, userId: 'byoa-agent' } })), false);
  assert.equal(await follows({ authorId: 'defty' }), false);
  assert.equal(await follows({}, context({ authorIsHuman: false })), false);
});
test('top-level messages, other space types and inaccessible threads cannot follow', async () => {
  assert.equal(await follows({ parentId: null }), false);
  assert.equal(await follows({ spaceType: 'dm' }), false);
  assert.equal(await follows({ spaceType: 'agent_conversation' }), false);
  assert.equal(await shouldFollowThread(input, { loadContext: async () => null, now: () => now }), false);
});
