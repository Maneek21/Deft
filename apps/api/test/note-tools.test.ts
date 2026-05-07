/**
 * Block 2.1 — note agent tools tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/note-tools.test.ts
 *
 * Exercises the executeAction switch cases for search_notes, create_note,
 * read_note, note_to_wiki against a real dev DB. Cleans up inserted rows.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { db, notes, wikiPages, orgs, users } from '@deft/db';
import { executeActionDirect } from '../src/lib/agent-actions.js';

let testOrgId: string;
let testUserId: string;
const noteIds: string[] = [];
const wikiIds: string[] = [];

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) {
    await db.insert(orgs).values({ id: testOrgId, name: 'b21-org', slug: 'b21-org' });
  }
  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) {
    await db.insert(users).values({ id: testUserId, email: `b21-${Date.now()}@t.local`, name: 'b21' });
  }
});

afterEach(async () => {
  if (noteIds.length > 0) {
    await db.delete(notes).where(inArray(notes.id, noteIds));
    noteIds.length = 0;
  }
  if (wikiIds.length > 0) {
    await db.delete(wikiPages).where(inArray(wikiPages.id, wikiIds));
    wikiIds.length = 0;
  }
});

test('create_note inserts a note and returns the id', async () => {
  const r = await executeActionDirect(
    'create_note',
    { title: 'Block 2.1 test note', content: '<p>body</p>' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  assert.ok(r.result.note_id, 'note_id returned');
  noteIds.push(r.result.note_id);

  const [row] = await db.select().from(notes).where(eq(notes.id, r.result.note_id));
  assert.ok(row);
  assert.equal(row!.title, 'Block 2.1 test note');
  assert.equal(row!.visibility, 'private', 'default visibility is private');
});

test('create_note rejects empty title', async () => {
  const r = await executeActionDirect(
    'create_note',
    { title: '' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('title is required'));
});

test('create_note rejects visibility=space without space id', async () => {
  const r = await executeActionDirect(
    'create_note',
    { title: 'bad', visibility: 'space' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('visibility_space_id'));
});

test('search_notes matches on title + content + scope', async () => {
  // Seed 3 notes: own-private, own-org, other-org (different user).
  const c1 = await executeActionDirect(
    'create_note',
    { title: 'Unique FOO marker', content: '' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  noteIds.push(c1.result.note_id);
  const c2 = await executeActionDirect(
    'create_note',
    { title: 'Another with FOO inside', content: '<p>Also FOO in content</p>', visibility: 'org' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  noteIds.push(c2.result.note_id);

  const r = await executeActionDirect(
    'search_notes',
    { query: 'FOO' },
    testOrgId,
    testUserId,
    null,
    'auto',
  );
  assert.equal(r.success, true);
  assert.ok(r.result.count >= 2, `expected >=2, got ${r.result.count}`);
  const titles = r.result.notes.map((n: any) => n.title);
  assert.ok(titles.includes('Unique FOO marker'));
  assert.ok(titles.includes('Another with FOO inside'));

  // Scope=mine excludes org-only notes? Both are mine — both should appear
  const rMine = await executeActionDirect(
    'search_notes',
    { query: 'FOO', scope: 'mine' },
    testOrgId,
    testUserId,
    null,
    'auto',
  );
  assert.ok(rMine.result.count >= 2);

  // Scope=org only returns org visibility
  const rOrg = await executeActionDirect(
    'search_notes',
    { query: 'FOO', scope: 'org' },
    testOrgId,
    testUserId,
    null,
    'auto',
  );
  const orgTitles = rOrg.result.notes.map((n: any) => n.title);
  assert.ok(orgTitles.includes('Another with FOO inside'));
  assert.ok(!orgTitles.includes('Unique FOO marker'), 'private note excluded from org scope');
});

test('search_notes rejects empty query', async () => {
  const r = await executeActionDirect('search_notes', { query: '' }, testOrgId, testUserId, null, 'auto');
  assert.equal(r.success, false);
});

test('read_note returns own-visible rows', async () => {
  const c = await executeActionDirect(
    'create_note',
    { title: 'Readable', content: '<p>body</p>' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  noteIds.push(c.result.note_id);

  const r = await executeActionDirect(
    'read_note',
    { note_id: c.result.note_id },
    testOrgId,
    testUserId,
    null,
    'auto',
  );
  assert.equal(r.success, true);
  assert.equal(r.result.title, 'Readable');
  assert.equal(r.result.content, '<p>body</p>');
});

test('read_note rejects non-existent id with a clear error', async () => {
  const r = await executeActionDirect('read_note', { note_id: crypto.randomUUID() }, testOrgId, testUserId, null, 'auto');
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Note not found'));
});

test('note_to_wiki promotes a note and returns the new wiki slug', async () => {
  const c = await executeActionDirect(
    'create_note',
    { title: 'Quarterly OKRs summary', content: '<p>Q2 priorities…</p>', visibility: 'org' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  noteIds.push(c.result.note_id);

  const r = await executeActionDirect(
    'note_to_wiki',
    { note_id: c.result.note_id, type: 'resource' },
    testOrgId,
    testUserId,
    null,
    'quick',
  );
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.result.wiki_page_id);
  wikiIds.push(r.result.wiki_page_id);
  assert.equal(r.result.slug, 'quarterly-okrs-summary');

  const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, r.result.wiki_page_id));
  assert.ok(page);
  assert.equal(page!.title, 'Quarterly OKRs summary');
  assert.equal(page!.content, '<p>Q2 priorities…</p>');
  assert.equal(page!.type, 'resource');
});

test('note_to_wiki generates a unique slug when one collides', async () => {
  const c1 = await executeActionDirect(
    'create_note',
    { title: 'Colliding name', content: 'a', visibility: 'org' },
    testOrgId, testUserId, null, 'quick',
  );
  noteIds.push(c1.result.note_id);
  const c2 = await executeActionDirect(
    'create_note',
    { title: 'Colliding name', content: 'b', visibility: 'org' },
    testOrgId, testUserId, null, 'quick',
  );
  noteIds.push(c2.result.note_id);

  const w1 = await executeActionDirect('note_to_wiki', { note_id: c1.result.note_id }, testOrgId, testUserId, null, 'quick');
  wikiIds.push(w1.result.wiki_page_id);
  const w2 = await executeActionDirect('note_to_wiki', { note_id: c2.result.note_id }, testOrgId, testUserId, null, 'quick');
  wikiIds.push(w2.result.wiki_page_id);

  assert.notEqual(w1.result.slug, w2.result.slug, 'second slug disambiguated');
  assert.equal(w1.result.slug, 'colliding-name');
  assert.match(w2.result.slug, /^colliding-name-\d+$/);
});
