import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDriveTree, driveLabel, isDriveNavActive, sidebarDrives, type DocumentDto, type DriveListItem, type FolderDto } from './drive-tree';

const folder = (id: string, name: string, position: number, parent: string | null = null): FolderDto => ({
  id, name, position, parent_folder_id: parent,
});
const doc = (
  id: string, title: string, position: number, where: { folder?: string | null; parent?: string | null } = {},
): DocumentDto => ({
  id, title, icon: null, position, folder_id: where.folder ?? null, parent_document_id: where.parent ?? null, updated_at: '2026-11-26T00:00:00Z',
});

test('buildDriveTree nests folders and sub-pages and orders by position, then title', () => {
  const tree = buildDriveTree({
    folders: [folder('f2', 'Zeta', 1), folder('f1', 'Alpha', 1), folder('f3', 'Inner', 0, 'f1')],
    documents: [
      doc('d3', 'Beta', 2), doc('d1', 'Apple', 2), doc('d0', 'First', 1),
      doc('d4', 'In folder', 0, { folder: 'f1' }), doc('d5', 'Sub-page b', 5, { parent: 'd1' }), doc('d6', 'Sub-page a', 5, { parent: 'd1' }),
      doc('d7', 'Deep', 0, { folder: 'f3' }),
    ],
  });
  // Folders first (position, then title), then documents (position, then title).
  assert.deepEqual(tree.map((n) => [n.type, n.id]), [['folder', 'f1'], ['folder', 'f2'], ['document', 'd0'], ['document', 'd1'], ['document', 'd3']]);
  const f1 = tree[0]!;
  assert.deepEqual(f1.children.map((n) => n.id), ['f3', 'd4']);
  assert.deepEqual(f1.children[0]!.children.map((n) => n.id), ['d7']);
  const d1 = tree[3]!;
  assert.deepEqual(d1.children.map((n) => n.id), ['d6', 'd5']);
  assert.equal(d1.title, 'Apple');
});

const item = (over: Partial<DriveListItem>): DriveListItem => ({
  id: 'd', name: 'D', icon: null, kind: 'private', system_key: null, role: 'full', default_role: null, frozen: false, pinned: false,
  admin_listed: false, is_member: false, is_mine: false, owner_name: null, ...over,
});

test('driveLabel never shows the stored name "My drive" for a drive that is not the caller’s own', () => {
  assert.equal(driveLabel(item({ kind: 'personal', name: 'My drive', is_mine: true })), 'My drive');
  assert.equal(driveLabel(item({ kind: 'personal', name: 'My drive', owner_name: 'Sam' })), 'Sam\'s drive');
  assert.equal(driveLabel(item({ kind: 'personal', name: 'My drive', owner_name: null })), 'A shared personal drive');
  assert.equal(driveLabel(item({ kind: 'private', name: 'Design team' })), 'Design team');
});

test('sidebarDrives picks My drive by is_mine and lists member or pinned drives, not implicit access', () => {
  const { mine, others } = sidebarDrives([
    item({ id: 'sam', name: 'Sam', kind: 'personal', is_member: true }),
    item({ id: 'me', name: 'My drive', kind: 'personal', is_mine: true, is_member: true }),
    item({ id: 'eq', name: 'Equal', kind: 'open', role: 'edit', default_role: 'edit', is_member: true }),
    item({ id: 'adm', name: 'Admin implicit', kind: 'open', role: 'full', default_role: 'edit' }),
    item({ id: 'pin', name: 'Pinned', kind: 'open', role: 'edit', default_role: 'edit', pinned: true }),
    item({ id: 'ws', name: 'Workspace', kind: 'open', system_key: 'workspace', role: 'edit', default_role: 'edit' }),
    item({ id: 'frz', name: 'Frozen', is_member: true, frozen: true }),
    item({ id: 'lst', name: 'Listed only', role: null, admin_listed: true, is_member: false }),
  ]);
  assert.equal(mine?.id, 'me');
  assert.deepEqual(others.map((d) => d.id), ['sam', 'eq', 'pin']);
});

test('the Drive nav item is active on document routes too', () => {
  assert.equal(isDriveNavActive('/d/abc', '/drive'), true);
  assert.equal(isDriveNavActive('/drive/x', '/drive'), false, 'the generic check already covers /drive/…');
  assert.equal(isDriveNavActive('/d/abc', '/tasks'), false);
});

test('buildDriveTree puts an orphan at the root instead of dropping it', () => {
  const tree = buildDriveTree({ folders: [], documents: [doc('d1', 'Lost', 0, { parent: 'hidden' }), doc('d2', 'Lost too', 1, { folder: 'gone' })] });
  assert.deepEqual(tree.map((n) => n.id), ['d1', 'd2']);
});
