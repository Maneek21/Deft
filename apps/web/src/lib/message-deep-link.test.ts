import test from 'node:test';
import assert from 'node:assert/strict';
import { messageDeepLinkDestination } from './message-deep-link';

test('an existing message-only reminder opens its actual visible DM and preserves its highlight', () => {
  assert.equal(messageDeepLinkDestination({ parent: { id: 'message-1', space_id: 'leo-dm' } }, 'message-1', 'message=message-1'),
    '/chat?message=message-1&space=leo-dm');
  assert.equal(messageDeepLinkDestination({ parent: { id: 'other', space_id: 'leo-dm' } }, 'message-1', 'message=message-1'), null);
  assert.equal(messageDeepLinkDestination({ parent: { id: 'message-1', space_id: '' } }, 'message-1', 'message=message-1'), null);
  assert.equal(messageDeepLinkDestination({ parent: { id: 'message-1', space_id: 'leo-dm' } }, 'message-1', 'message=later-navigation'), null);
});

test('an authorized public message can resolve before the reader has joined any spaces', () => {
  assert.equal(messageDeepLinkDestination({ parent: { id: 'public-message', space_id: 'public-space' } }, 'public-message', 'message=public-message'),
    '/chat?message=public-message&space=public-space');
  assert.equal(messageDeepLinkDestination(null, 'private-message', 'message=private-message'), null);
});
