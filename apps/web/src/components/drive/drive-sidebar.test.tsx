import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { DriveSidebarContent, DRIVES_KEY } from './drive-sidebar';

const drive = (over: Record<string, unknown>) => ({
  id: 'x', name: 'X', icon: null, kind: 'private', system_key: null, role: 'full', default_role: null,
  frozen: false, pinned: false, admin_listed: false, is_member: false, is_mine: false, ...over,
});
const drives = [
  drive({ id: 'w', name: 'Workspace', kind: 'open', system_key: 'workspace', role: 'edit', default_role: 'edit' }),
  drive({ id: 'p', name: 'My drive', kind: 'personal', is_mine: true, is_member: true }),
  drive({ id: 'm', name: 'Design team', kind: 'private', is_member: true }),
  drive({ id: 'e', name: 'Equal default', kind: 'open', role: 'edit', default_role: 'edit', is_member: true }),
  drive({ id: 'o', name: 'Pinned open', kind: 'open', role: 'edit', default_role: 'edit', pinned: true }),
  drive({ id: 'u', name: 'Unrelated open', kind: 'open', role: 'full', default_role: 'edit' }),
  drive({ id: 'a', name: 'Admin only listing', kind: 'private', role: null, admin_listed: true }),
];

const render = (role: string, list: unknown[] = drives) => renderToStaticMarkup(createElement(
  SWRConfig, { value: { fallback: { [DRIVES_KEY]: { drives: list } } } },
  createElement(DriveSidebarContent, { role, pathname: '/drive' }),
));

test('a personal drive shared by someone else is shown under its own name, never as My drive', () => {
  const markup = render('member', [drive({ id: 'sam', name: 'Sam’s drive', kind: 'personal', is_member: true })]);
  assert.match(markup, /Sam’s drive/);
  assert.doesNotMatch(markup, /My drive/);
});

test('the drive sidebar says it is loading before the list arrives', () => {
  const markup = renderToStaticMarkup(createElement(SWRConfig, { value: { fallback: {} } }, createElement(DriveSidebarContent, { role: 'member', pathname: '/drive' })));
  assert.match(markup, /Loading drives/);
});

test('the drive sidebar shows My drive, member and pinned drives, and hides + New drive for a guest', () => {
  const member = render('member');
  assert.match(member, /My drive/);
  assert.match(member, /Design team/);
  assert.match(member, /Pinned open/);
  assert.match(member, /Equal default/, 'a grant at the default role is still membership');
  assert.match(member, /Browse drives/);
  assert.match(member, /New drive/);
  // Not a member, not pinned: left to Browse (an admin's implicit full included). Admin-only listings can't be opened.
  assert.doesNotMatch(member, /Unrelated open/);
  assert.doesNotMatch(member, /Admin only listing/);
  const guest = render('guest');
  assert.match(guest, /My drive/);
  assert.match(guest, /Browse drives/);
  assert.doesNotMatch(guest, /New drive/);
});
