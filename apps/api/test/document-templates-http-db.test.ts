/**
 * Document templates over HTTP (M1; routes/documents.ts, lib/documents.ts):
 * GET /api/document-templates lists the built-in templates, the workspace
 * templates (is_template documents in open drives the caller can see) and the
 * caller's personal templates; POST /api/documents with `template` copies a
 * built-in template, or a template document the caller can see, with every
 * block id regenerated.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-templates-http-db.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { closeDb } from '../src/lib/db.js';
import { documentRoutes, documentTemplateRoutes } from '../src/routes/documents.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let fx: DrivesFixture | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('document-templates', {
    routes: [
      { path: '/api/documents', app: documentRoutes },
      { path: '/api/document-templates', app: documentTemplateRoutes },
    ],
  });
});

after(async () => {
  try {
    await fx?.teardown();
  } finally {
    await closeDb();
  }
});

async function call(userId: string, method: string, path: string, body: unknown, status: number): Promise<any> {
  const res = await fx!.request(userId, method, path, body);
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  assert.equal(res.status, status, `${method} ${path}: ${text}`);
  return parsed;
}

const withBlocks = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2, id: 'fixed-heading-id' }, content: [{ type: 'text', text: 'Plan' }] },
    { type: 'paragraph', attrs: { id: 'fixed-paragraph-id' }, content: [{ type: 'text', text: 'Body' }] },
  ],
};

async function markTemplate(documentId: string) {
  await fx!.client.query('UPDATE documents SET is_template = true WHERE id = $1', [documentId]);
}

const blockIds = (json: any): string[] => (json.content as any[]).map((node) => node.attrs?.id);

test('GET /api/document-templates lists built-in, workspace (open drives only) and personal templates', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const open = await fx.insertDrive({ kind: 'open', name: 'Company' });
  const privateDrive = await fx.insertDrive({ kind: 'private' });
  await fx.addDriveMember(privateDrive, { user: member }, 'full');
  const mine = await fx.insertDrive({ kind: 'personal', ownerUserId: member, name: 'Mine' });
  const others = await fx.insertDrive({ kind: 'personal', ownerUserId: member2, name: 'Theirs' });

  const workspace = await fx.insertDocument({ driveId: open, title: 'Weekly sync' });
  const notTemplate = await fx.insertDocument({ driveId: open, title: 'Plain page' });
  const inPrivate = await fx.insertDocument({ driveId: privateDrive, title: 'Private template' });
  const personal = await fx.insertDocument({ driveId: mine, title: 'My template' });
  const theirs = await fx.insertDocument({ driveId: others, title: 'Their template' });
  const deleted = await fx.insertDocument({ driveId: open, title: 'Deleted template', deleted: true });
  for (const id of [workspace, inPrivate, personal, theirs, deleted]) await markTemplate(id);

  const listed = await call(member, 'GET', '/api/document-templates', undefined, 200);
  assert.deepEqual(listed.builtin.map((b: any) => b.key),
    ['meeting_notes', 'spec', 'one_on_one', 'retro', 'proposal', 'handbook_page']);
  assert.ok(listed.builtin.every((b: any) => typeof b.title === 'string' && Object.keys(b).length === 2));
  assert.deepEqual(listed.workspace, [{ id: workspace, title: 'Weekly sync', drive_name: 'Company' }],
    'open drives only, no private-drive template, no non-template, no deleted one');
  assert.ok(!listed.workspace.some((w: any) => [notTemplate, inPrivate, deleted].includes(w.id)));
  assert.deepEqual(listed.personal, [{ id: personal, title: 'My template' }], 'only my own personal drive');

  const other = await call(member2, 'GET', '/api/document-templates', undefined, 200);
  assert.deepEqual(other.personal, [{ id: theirs, title: 'Their template' }]);
  assert.deepEqual(other.workspace.map((w: any) => w.id), [workspace]);
});

test('creating from a template copies its content with new block ids', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await fx.insertDrive({ kind: 'open' });
  const source = await fx.insertDocument({ driveId: drive, title: 'Kickoff', json: withBlocks as any });
  await markTemplate(source);

  const copy = (await call(member, 'POST', '/api/documents', { drive_id: drive, template: { document_id: source } }, 201)).document;
  assert.equal(copy.title, 'Kickoff', 'the title defaults to the template title');
  assert.notEqual(copy.id, source);
  const { rows: [stored] } = await fx.client.query('SELECT content_json, content_text, is_template FROM documents WHERE id = $1', [copy.id]);
  assert.match(stored.content_text, /Plan/);
  assert.match(stored.content_text, /Body/);
  assert.deepEqual((stored.content_json.content as any[]).map((n) => n.type), ['heading', 'paragraph']);
  const ids = blockIds(stored.content_json);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  assert.ok(!ids.includes('fixed-heading-id') && !ids.includes('fixed-paragraph-id'), 'no id is carried over');
  assert.equal(stored.is_template, false, 'a copy is a plain document');
  const { rows: [original] } = await fx.client.query('SELECT content_json FROM documents WHERE id = $1', [source]);
  assert.deepEqual(blockIds(original.content_json), ['fixed-heading-id', 'fixed-paragraph-id'], 'the template is unchanged');

  const named = (await call(member, 'POST', '/api/documents', { drive_id: drive, title: 'Mine', template: { builtin: 'retro' } }, 201)).document;
  assert.equal(named.title, 'Mine');
  const builtin = (await call(member, 'POST', '/api/documents', { drive_id: drive, template: { builtin: 'meeting_notes' } }, 201)).document;
  assert.equal(builtin.title, 'Meeting notes');
  const { rows: [built] } = await fx.client.query('SELECT content_json FROM documents WHERE id = $1', [builtin.id]);
  const headings = (built.content_json.content as any[]).filter((n) => n.type === 'heading').map((n) => n.content[0].text);
  assert.deepEqual(headings, ['Attendees', 'Agenda', 'Notes', 'Decisions', 'Action items']);

  await call(member, 'POST', '/api/documents', { drive_id: drive, template: { builtin: 'nope' } }, 400);
  await call(member, 'POST', '/api/documents', { drive_id: drive, template: { builtin: 'spec' }, json: withBlocks }, 400);
});

test("creating from a template you can't see is a 404", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const hidden = await fx.insertDrive({ kind: 'private' });
  await fx.addDriveMember(hidden, { user: member }, 'full');
  const secret = await fx.insertDocument({ driveId: hidden, title: 'Secret template', json: withBlocks as any });
  await markTemplate(secret);

  const count = async () => (await fx!.client.query('SELECT count(*)::int AS count FROM documents WHERE org_id = $1', [fx!.orgId])).rows[0].count;
  const before = await count();
  const refused = await call(member2, 'POST', '/api/documents', { template: { document_id: secret } }, 404);
  assert.equal(refused.code, 'NOT_FOUND');
  const missing = await call(member2, 'POST', '/api/documents', { template: { document_id: 'no-such-id' } }, 404);
  assert.deepEqual(missing, refused, 'a missing template answers the same way');
  assert.equal(await count(), before, 'nothing was created');
});
