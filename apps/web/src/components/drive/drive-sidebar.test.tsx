import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { DriveSidebarContent, DRIVES_KEY } from './drive-sidebar';

const drive = (over: Record<string, unknown>) => ({
  id: 'x', name: 'X', icon: null, kind: 'private', system_key: null, role: 'full', default_role: null,
  frozen: false, pinned: false, admin_listed: false, ...over,
});
const drives = [
  drive({ id: 'w', name: 'Workspace', kind: 'open', system_key: 'workspace', role: 'edit', default_role: 'edit' }),
  drive({ id: 'p', name: 'Mine alone', kind: 'personal' }),
  drive({ id: 'm', name: 'Design team', kind: 'private' }),
  drive({ id: 'o', name: 'Pinned open', kind: 'open', role: 'edit', default_role: 'edit', pinned: true }),
  drive({ id: 'u', name: 'Unrelated open', kind: 'open', role: 'edit', default_role: 'edit' }),
  drive({ id: 'a', name: 'Admin only listing', kind: 'private', role: null, admin_listed: true }),
];

const render = (role: string) => renderToStaticMarkup(createElement(
  SWRConfig, { value: { fallback: { [DRIVES_KEY]: { drives } } } },
  createElement(DriveSidebarContent, { role, pathname: '/drive' }),
));

test('the drive sidebar shows My drive, member and pinned drives, and hides + New drive for a guest', () => {
  const member = render('member');
  assert.match(member, /My drive/);
  assert.match(member, /Design team/);
  assert.match(member, /Pinned open/);
  assert.match(member, /Browse drives/);
  assert.match(member, /New drive/);
  // Not a member, not pinned: left to Browse. Admin-only listings can't be opened.
  assert.doesNotMatch(member, /Unrelated open/);
  assert.doesNotMatch(member, /Admin only listing/);
  assert.doesNotMatch(member, /Mine alone/);
  const guest = render('guest');
  assert.match(guest, /My drive/);
  assert.match(guest, /Browse drives/);
  assert.doesNotMatch(guest, /New drive/);
});
