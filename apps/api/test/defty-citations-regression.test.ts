import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAgentCitations, resolveAgentCitationLink } from '../../web/src/lib/agent-citations.js';
import { formatRoomContextPackWithSources } from '../src/lib/defty-room-context.js';

test('room sources survive citation normalization and resolve their chat links', () => {
  const packed = formatRoomContextPackWithSources({
    spaceId: 'room', triggerTime: new Date('2026-10-22T10:00:00Z'), people: [], projects: [], tasks: [],
    messages: [{ id: 'message', author: 'Mehta, Rahul', content: 'I will ship this tomorrow.',
      createdAt: new Date('2026-10-22T09:58:00Z'), parentId: null, replyCount: 0 }], thread: [],
  });
  assert.equal(packed.citations.length, 1);
  assert.equal(normalizeAgentCitations(packed.citations).length, 1);
  assert.equal(resolveAgentCitationLink('/chat?space=room&message=message', packed.citations), '/chat?space=room&message=message');
});

test('room sources remain clickable when member names contain commas', () => {
  const packed = formatRoomContextPackWithSources({
    spaceId: 'room', triggerTime: new Date('2026-10-22T10:00:00Z'), people: [], projects: [], tasks: [],
    messages: [
      { id: 'one', author: 'Mehta, Rahul', content: 'Shipping the rollback.', createdAt: new Date('2026-10-22T09:58:00Z'), parentId: null, replyCount: 0 },
      { id: 'two', author: 'Shah, Priya', content: 'Reviewing it now.', createdAt: new Date('2026-10-22T09:59:00Z'), parentId: null, replyCount: 0 },
      { id: 'three', author: 'Rao, Arjun', content: 'Blocked on staging.', createdAt: new Date('2026-10-22T09:59:30Z'), parentId: null, replyCount: 0 },
    ], thread: [],
  });
  assert.equal(packed.citations.length, 3);
  assert.equal(normalizeAgentCitations(packed.citations).length, packed.citations.length);
  for (const citation of packed.citations) {
    assert.ok(!citation.title.includes(','), `citation title must stay renderer-safe: ${citation.title}`);
    assert.equal(resolveAgentCitationLink(citation.url, packed.citations), citation.url);
  }
});

test('room source metadata includes only messages that fit the actual context pack', () => {
  const packed = formatRoomContextPackWithSources({
    spaceId: 'room', triggerTime: new Date('2026-10-22T10:00:00Z'), people: [], projects: [], tasks: [],
    messages: Array.from({ length: 40 }, (_, index) => ({ id: `message-${index}`, author: 'Rahul',
      content: 'x'.repeat(400), createdAt: new Date('2026-10-22T09:58:00Z'), parentId: null, replyCount: 0 })), thread: [],
  });
  assert.ok(packed.content.length <= 12_000);
  assert.ok(packed.citations.length > 0 && packed.citations.length <= 30);
  for (const citation of packed.citations) assert.ok(packed.content.includes(`](${citation.url})`));
});
