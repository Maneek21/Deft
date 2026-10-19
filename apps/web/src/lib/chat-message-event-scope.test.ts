import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatMessageEventScope, createChatMessageNewHandler, type ChatEventMessage } from './chat-message-event-scope';
function fixture() {
  const scope = new ChatMessageEventScope(); scope.commit('hermes-dm', 'session-a');
  const visit = scope.capture('hermes-dm', 'session-a');
  let messages: ChatEventMessage[] = [{ id: 'parent', space_id: 'hermes-dm' }];
  const pending: (() => void)[] = []; const opened: string[] = []; let scrolls = 0;
  const handler = createChatMessageNewHandler({ visit, update: update => { pending.push(() => { messages = update(messages); }); }, normalize: message => message, openThread: parent => { opened.push(parent.id); }, scroll: () => { scrolls++; }, schedule: callback => { pending.push(callback); } });
  return { scope, visit, handler, flushOne: () => pending.shift()?.(), flush: () => { while (pending.length) pending.shift()!(); }, messages: () => messages, opened, scrolls: () => scrolls };
}
test('actual message:new handler excludes ordinary General events and missing room identity from a Hermes DM', () => {
  const f = fixture(); f.handler({ id: 'standup', space_id: 'general' }); f.handler({ id: 'unknown' }); f.flush();
  assert.deepEqual(f.messages().map(message => message.id), ['parent']); assert.equal(f.scrolls(), 0);
});
test('same-room append deduplicates and an agent thread reply opens its existing parent', () => {
  const f = fixture(); f.handler({ id: 'new', space_id: 'hermes-dm' }); f.handler({ id: 'new', space_id: 'hermes-dm' });
  f.handler({ id: 'reply', space_id: 'hermes-dm', parent_id: 'parent', metadata: { is_agent_reply: true } }); f.flush();
  assert.deepEqual(f.messages().map(message => message.id), ['parent', 'new']); assert.deepEqual(f.opened, ['parent']);
});
test('committed navigation and session changes fence queued state and delayed thread/scroll work including A to B to A', () => {
  const f = fixture(); f.handler({ id: 'new', space_id: 'hermes-dm' }); f.handler({ id: 'reply', space_id: 'hermes-dm', parent_id: 'parent', metadata: { is_agent_reply: true } });
  f.scope.commit('general', 'session-a'); f.scope.commit('hermes-dm', 'session-a'); f.flush();
  assert.deepEqual(f.messages().map(message => message.id), ['parent']); assert.deepEqual(f.opened, []); assert.equal(f.scrolls(), 0);
  assert.equal(f.visit.isCurrent(), false);
  const newVisit = f.scope.capture('hermes-dm', 'session-a'); f.scope.commit('hermes-dm', 'session-b'); assert.equal(newVisit.isCurrent(), false);
});
test('only committed identity changes invalidate a captured visit; cleanup and unknown session deny it', () => {
 const scope = new ChatMessageEventScope(); const cleanup = scope.commit('a', 'session'); const visit = scope.capture('a', 'session');
 assert.equal(visit.isCurrent(), true); // An abandoned render never calls commit.
 visit.dispose(); assert.equal(visit.isCurrent(), false); const next = scope.capture('a', 'session'); cleanup(); assert.equal(next.isCurrent(), false);
 scope.commit('a', null); assert.equal(scope.capture('a', null).isCurrent(), false);
});

test('a previously scheduled thread open and scroll do not run after committed session change', () => {
 const f = fixture();
 f.handler({ id: 'reply', space_id: 'hermes-dm', parent_id: 'parent', metadata: { is_agent_reply: true } });
 f.flushOne(); // The state updater has scheduled the thread callback.
 f.handler({ id: 'new', space_id: 'hermes-dm' });
 f.scope.commit('hermes-dm', 'replacement-session'); f.flush();
 assert.deepEqual(f.opened, []); assert.equal(f.scrolls(), 0); assert.deepEqual(f.messages().map(message => message.id), ['parent']);
});
