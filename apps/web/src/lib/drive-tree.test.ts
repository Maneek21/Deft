import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDriveTree, type DocumentDto, type FolderDto } from './drive-tree';

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

test('buildDriveTree puts an orphan at the root instead of dropping it', () => {
  const tree = buildDriveTree({ folders: [], documents: [doc('d1', 'Lost', 0, { parent: 'hidden' }), doc('d2', 'Lost too', 1, { folder: 'gone' })] });
  assert.deepEqual(tree.map((n) => n.id), ['d1', 'd2']);
});
