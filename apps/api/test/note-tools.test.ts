/**
 * Block 2.1 — note agent tools tests, since notes became documents (F15).
 *
 * Run: pnpm --filter @deft/api test test/note-tools.test.ts
 *
 * Exercises the executeAction switch cases for search_notes, create_note,
 * read_note and note_to_wiki: they keep their names and parameters and read
 * and write documents (lib/legacy-notes.ts). Runs in its own fixture
 * workspace (setupDrivesFixture), removed afterwards.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb } from '../src/lib/db.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const skip = !safeTestDatabaseUrl();
let fx: DrivesFixture;
let user: string;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('note-tools');
  user = fx.people.member;
});

after(async () => {
  if (skip) return;
  if (fx) {
    for (const table of ['action_receipts', 'agent_action_approvers']) {
      await fx.client.query(`DELETE FROM ${table} WHERE action_id IN (SELECT id FROM agent_actions WHERE org_id = $1)`, [fx.orgId]).catch(() => {});
    }
    await fx.client.query('DELETE FROM agent_actions WHERE org_id = $1', [fx.orgId]);
    await fx.client.query('DELETE FROM wiki_pages WHERE org_id = $1', [fx.orgId]);
    await fx.teardown();
  }
  await closeDb();
});

const run = (action: string, params: Record<string, unknown>, tier: 'auto' | 'quick' = 'quick') =>
  executeActionDirect(action, params, fx.orgId, user, null, tier);

test('create_note creates a document in My drive and returns its id', { skip }, async () => {
  const r = await run('create_note', { title: 'Block 2.1 test note', content: '<p>body</p>' });
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  assert.ok(r.result.note_id, 'note_id returned');
  assert.equal(r.result.document_id, r.result.note_id);
  const { rows: [row] } = await fx.client.query(`SELECT d.title, d.content_text, drive.kind, drive.owner_user_id
    FROM documents d JOIN drives drive ON drive.id = d.drive_id WHERE d.id = $1`, [r.result.note_id]);
  assert.equal(row.title, 'Block 2.1 test note');
  assert.equal(row.content_text.trim(), 'body');
  assert.deepEqual([row.kind, row.owner_user_id], ['personal', user], 'private by default: My drive');
  assert.equal((await fx.client.query('SELECT 1 FROM notes WHERE org_id = $1', [fx.orgId])).rowCount, 0, 'no note row');
});

test('create_note rejects empty title', { skip }, async () => {
  const r = await run('create_note', { title: '' });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('title is required'));
});

test('create_note rejects visibility=space without space id', { skip }, async () => {
  const r = await run('create_note', { title: 'bad', visibility: 'space' });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('visibility_space_id'));
});

test('search_notes matches on title + content + scope', { skip }, async () => {
  const mark = `FOO${randomUUID().slice(0, 6)}`;
  const c1 = await run('create_note', { title: `Unique ${mark} marker`, content: '' });
  const c2 = await run('create_note', { title: `Another with ${mark} inside`, content: `<p>Also ${mark} in content</p>`, visibility: 'org' });
  assert.ok(c1.success && c2.success);

  const r = await run('search_notes', { query: mark }, 'auto');
  assert.equal(r.success, true);
  const titles = r.result.notes.map((n: any) => n.title);
  assert.ok(titles.includes(`Unique ${mark} marker`));
  assert.ok(titles.includes(`Another with ${mark} inside`));

  // Both are mine.
  const rMine = await run('search_notes', { query: mark, scope: 'mine' }, 'auto');
  assert.equal(rMine.result.count, 2);

  // Scope org: documents in open drives (an org note is in Shared notes).
  const rOrg = await run('search_notes', { query: mark, scope: 'org' }, 'auto');
  const orgTitles = rOrg.result.notes.map((n: any) => n.title);
  assert.ok(orgTitles.includes(`Another with ${mark} inside`));
  assert.ok(!orgTitles.includes(`Unique ${mark} marker`), 'private note excluded from org scope');
});

test('search_notes rejects empty query', { skip }, async () => {
  const r = await run('search_notes', { query: '' }, 'auto');
  assert.equal(r.success, false);
});

test('read_note returns the document, its content as Markdown', { skip }, async () => {
  const c = await run('create_note', { title: 'Readable', content: '<p>body</p>' });
  const r = await run('read_note', { note_id: c.result.note_id }, 'auto');
  assert.equal(r.success, true);
  assert.equal(r.result.title, 'Readable');
  assert.equal(r.result.content.trim(), 'body');
  assert.equal(r.result.content_format, 'markdown');
  assert.equal(r.result.url, `/d/${c.result.note_id}`);
});

test('read_note rejects non-existent id with a clear error', { skip }, async () => {
  const r = await run('read_note', { note_id: randomUUID() }, 'auto');
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Note not found'));
});

test('note_to_wiki promotes a document and returns the new wiki slug', { skip }, async () => {
  const c = await run('create_note', { title: 'Quarterly OKRs summary', content: '<p>Q2 priorities…</p>', visibility: 'org' });
  const r = await run('note_to_wiki', { note_id: c.result.note_id, type: 'resource' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.result.wiki_page_id);
  assert.equal(r.result.slug, 'quarterly-okrs-summary');
  const { rows: [page] } = await fx.client.query('SELECT title, content, type FROM wiki_pages WHERE id = $1', [r.result.wiki_page_id]);
  assert.equal(page.title, 'Quarterly OKRs summary');
  assert.equal(page.content.trim(), 'Q2 priorities…', 'the document\'s Markdown');
  assert.equal(page.type, 'resource');
});

test('note_to_wiki generates a unique slug when one collides', { skip }, async () => {
  const c1 = await run('create_note', { title: 'Colliding name', content: 'a', visibility: 'org' });
  const c2 = await run('create_note', { title: 'Colliding name', content: 'b', visibility: 'org' });
  const w1 = await run('note_to_wiki', { note_id: c1.result.note_id });
  const w2 = await run('note_to_wiki', { note_id: c2.result.note_id });
  assert.notEqual(w1.result.slug, w2.result.slug, 'second slug disambiguated');
  assert.equal(w1.result.slug, 'colliding-name');
  assert.match(w2.result.slug, /^colliding-name-\d+$/);
});

test('note_to_wiki refuses a document shared with the caller alone', { skip }, async () => {
  const theirs = await executeActionDirect('create_note', { title: 'Their private note', content: 'x' }, fx.orgId, fx.people.member2, null, 'quick');
  await fx.share(theirs.result.note_id, { user }, 'view');
  const r = await run('note_to_wiki', { note_id: theirs.result.note_id });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Note not found'));
});
