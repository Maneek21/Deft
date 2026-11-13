import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browsePublicSpacesPath,
  canBrowsePublicSpaces,
  joinPublicSpacePath,
  leaveSpacePath,
  onMemberJoined,
  type MemberJoinedEvent,
} from './public-spaces';

test('only owners, admins and members may browse public spaces', () => {
  assert.equal(canBrowsePublicSpaces('owner'), true);
  assert.equal(canBrowsePublicSpaces('admin'), true);
  assert.equal(canBrowsePublicSpaces('member'), true);
  assert.equal(canBrowsePublicSpaces('guest'), false);
  assert.equal(canBrowsePublicSpaces(undefined), false);
  assert.equal(canBrowsePublicSpaces(null), false);
});

test('builds browse, join and leave paths', () => {
  assert.equal(browsePublicSpacesPath(''), '/api/spaces/browse?include_joined=1&limit=100');
  assert.equal(browsePublicSpacesPath('  eng & ops '), '/api/spaces/browse?include_joined=1&limit=100&q=eng+%26+ops');
  assert.ok(browsePublicSpacesPath('x'.repeat(200)).endsWith(`q=${'x'.repeat(100)}`));
  assert.equal(joinPublicSpacePath('a/b'), '/api/spaces/a%2Fb/join');
  assert.equal(leaveSpacePath('s1'), '/api/spaces/s1/members/me');
});

test('member-joined subscription filters events and unsubscribes', () => {
  const listeners = new Set<(data: MemberJoinedEvent) => void>();
  const socket = {
    on: (_event: string, l: (data: MemberJoinedEvent) => void) => listeners.add(l),
    off: (_event: string, l: (data: MemberJoinedEvent) => void) => listeners.delete(l),
  };
  const seen: MemberJoinedEvent[] = [];
  const stop = onMemberJoined(socket, (e) => e.user_id === 'me', (e) => seen.push(e));
  for (const l of listeners) {
    l({ space_id: 's1', user_id: 'me' });
    l({ space_id: 's2', user_id: 'someone' });
    l({ space_id: 7 as unknown as string, user_id: 'me' });
  }
  assert.deepEqual(seen, [{ space_id: 's1', user_id: 'me' }]);
  stop();
  assert.equal(listeners.size, 0);
});
