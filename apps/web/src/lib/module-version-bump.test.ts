import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bumpPatchIfUnchanged,
  checkModuleManifestEdit,
  nextPatchVersion,
  saveModuleManifestEdit,
} from './module-version-bump';

const DIGEST = `sha256:${'b'.repeat(64)}`;

function source(version: string, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    schema_version: '1',
    id: 'workspace.hiring',
    slug: 'hiring',
    version,
    name: 'Hiring',
    collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] }],
    ...extra,
  }, null, 2)}\n`;
}

test('the next patch version follows the active one', () => {
  assert.equal(nextPatchVersion('1.2.3'), '1.2.4');
  assert.equal(nextPatchVersion('1.2.3-beta.1'), '1.2.3');
  assert.equal(nextPatchVersion('not a version'), null);
});

test('an unchanged version is bumped in place, keeping the rest of the text', () => {
  const edited = source('1.0.0').replace('"Hiring"', '"Hiring team"');
  const bumped = bumpPatchIfUnchanged(edited, '1.0.0');
  assert.equal(bumped, edited.replace('"version": "1.0.0"', '"version": "1.0.1"'));
  // A version the person changed, and text that is not JSON, are left alone.
  assert.equal(bumpPatchIfUnchanged(source('2.0.0'), '1.0.0'), source('2.0.0'));
  assert.equal(bumpPatchIfUnchanged('{ not json', '1.0.0'), '{ not json');
});

test('only the top-level version is bumped, even when a nested value is also called version', () => {
  const edited = `{"collections":[{"key":"c","name":"C","fields":[{"key":"version","label":"Version","type":"text","default":"1.0.0"}]}],"schema_version":"1","id":"workspace.hiring","slug":"hiring","version":"1.0.0","name":"Hiring"}`;
  const bumped = JSON.parse(bumpPatchIfUnchanged(edited, '1.0.0')) as { version: string; collections: Array<{ fields: Array<{ default: string }> }> };
  assert.equal(bumped.version, '1.0.1');
  assert.equal(bumped.collections[0]!.fields[0]!.default, '1.0.0');
});

test('the check explains a bad edit in plain lines and refuses an identity change', async () => {
  const bad = await checkModuleManifestEdit(source('1.0.0', { script: 'x' }), { version: '1.0.0', moduleId: 'workspace.hiring', slug: 'hiring' });
  assert.equal(bad.ok, false);
  assert.deepEqual(!bad.ok && bad.lines, ['App file: unknown key "script": remove it']);

  const renamed = await checkModuleManifestEdit(source('1.0.0').replace('"slug": "hiring"', '"slug": "hiring-new"'), {
    version: '1.0.0', moduleId: 'workspace.hiring', slug: 'hiring',
  });
  assert.equal(renamed.ok, false);
  assert.match(!renamed.ok ? renamed.lines[0]! : '', /id and slug cannot change/);

  const good = await checkModuleManifestEdit(source('1.0.0'), { version: '1.0.0', moduleId: 'workspace.hiring', slug: 'hiring' });
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.preview.version, '1.0.1');
  assert.equal(good.ok && good.bumped, true);
});

test('save posts the bumped file with If-Match and returns the saved text', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetch = async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ module: { slug: 'hiring' } }), { status: 200 });
  };
  const result = await saveModuleManifestEdit({ slug: 'hiring', source: source('1.0.0'), activeDigest: DIGEST, activeVersion: '1.0.0', fetch });
  assert.equal(result.version, '1.0.1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/api/modules/hiring/upgrade');
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get('If-Match'), DIGEST);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(JSON.parse(String(calls[0]!.init.body)).version, '1.0.1');
  assert.equal(result.source, calls[0]!.init.body);
});

test('save never sends a file the check refused', async () => {
  let called = false;
  const fetch = async () => { called = true; return new Response('{}'); };
  await assert.rejects(
    () => saveModuleManifestEdit({ slug: 'hiring', source: '{ nope', activeDigest: DIGEST, activeVersion: '1.0.0', fetch }),
    /isn't valid JSON near line 1/,
  );
  assert.equal(called, false);
});

test('a stale digest and records that do not fit come back as readable text', async () => {
  const stale = async () => new Response(JSON.stringify({
    error: 'The app changed before the update started. Refresh and try again.', code: 'MODULE_MANIFEST_STALE',
  }), { status: 409 });
  await assert.rejects(
    () => saveModuleManifestEdit({ slug: 'hiring', source: source('1.0.0'), activeDigest: DIGEST, activeVersion: '1.0.0', fetch: stale }),
    (error: unknown) => error instanceof Error && error.message === 'The app changed before the update started. Refresh and try again.',
  );
  const lines = ['Candidates → Email: now required, but empty in "Dana Example" and "Sam Sample"'];
  const misfit = async () => new Response(JSON.stringify({
    error: lines[0], code: 'MODULE_VALIDATION_ERROR', details: { lines, record_count: 2 },
  }), { status: 400 });
  await assert.rejects(
    () => saveModuleManifestEdit({ slug: 'hiring', source: source('1.0.0'), activeDigest: DIGEST, activeVersion: '1.0.0', fetch: misfit }),
    (error: unknown) => error instanceof Error && error.message === lines[0],
  );
});
