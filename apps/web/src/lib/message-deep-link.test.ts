import test from 'node:test';
import assert from 'node:assert/strict';
import { messageDeepLinkDestination } from './message-deep-link';

test('an existing message-only reminder opens its actual visible DM and preserves its highlight', () => {
  assert.equal(messageDeepLinkDestination({ parent: { id: 'message-1', space_id: 'leo-dm' } }, 'message-1', ['general', 'leo-dm'], 'message=message-1'),
    '/chat?message=message-1&space=leo-dm');
  assert.equal(messageDeepLinkDestination({ parent: { id: 'other', space_id: 'leo-dm' } }, 'message-1', ['leo-dm'], 'message=message-1'), null);
  assert.equal(messageDeepLinkDestination({ parent: { id: 'message-1', space_id: 'unknown' } }, 'message-1', ['general'], 'message=message-1'), null);
  assert.equal(messageDeepLinkDestination({ parent: { id: 'message-1', space_id: 'leo-dm' } }, 'message-1', ['leo-dm'], 'message=later-navigation'), null);
});
