/**
 * Run: pnpm --filter @deft/web exec tsx --test src/lib/module-collection-nav.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModuleCollectionNav } from './module-collection-nav';

const contacts = [
  { key: 'contacts', name: 'Contacts' },
  { key: 'companies', name: 'Companies' },
  { key: 'deals', name: 'Deals' },
  { key: 'activities', name: 'Activities' },
];

test('hides collection chrome for a single-collection module', () => {
  const nav = buildModuleCollectionNav([{ key: 'entries', name: 'Entries' }], 'entries');
  assert.equal(nav.show, false);
  assert.deepEqual(nav.items, []);
});

test('shows Contacts collection tabs with the active collection marked current', () => {
  const nav = buildModuleCollectionNav(contacts, 'companies');
  assert.equal(nav.show, true);
  assert.deepEqual(nav.items.map((item) => item.key), ['contacts', 'companies', 'deals', 'activities']);
  assert.equal(nav.items.filter((item) => item.current).length, 1);
  assert.equal(nav.items.find((item) => item.key === 'companies')?.current, true);
});

test('keeps eight collections as tabs instead of collapsing to a sidebar', () => {
  const collections = Array.from({ length: 8 }, (_, index) => ({
    key: `col_${index + 1}`,
    name: `Collection ${index + 1}`,
  }));
  const nav = buildModuleCollectionNav(collections, 'col_8');
  assert.equal(nav.show, true);
  assert.equal(nav.items.length, 8);
  assert.equal(nav.items.at(-1)?.current, true);
});
