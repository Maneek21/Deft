import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseAttachmentAppManifest } from '@deft/app-kit/core';
import { createAppAuthorityManifestParser, APP_AUTHORITY_MANIFEST_CACHE_ENTRIES, APP_AUTHORITY_MANIFEST_CACHE_KEY_BYTES } from '../src/lib/app-authority-manifest.js';

const scope = { org_id: 'org-a', app_version_id: 'version-a' };
const scopedParser = (parser: typeof parseAttachmentAppManifest) => {
  const parse = createAppAuthorityManifestParser(parser);
  return (raw: unknown) => parse(raw, scope);
};
const manifest = () => JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8'));

test('exact full manifest JSON reuses only parsing, preserves parity and isolates every returned tree', () => {
  const parser = mock.fn(parseAttachmentAppManifest), parse = scopedParser(parser), raw = manifest();
  const first = parse(raw), second = parse(structuredClone(raw));
  assert.equal(parser.mock.callCount(), 1); assert.deepEqual(first, parseAttachmentAppManifest(raw));
  assert.deepEqual(second, first); assert.notStrictEqual(first, second);
  first.name = 'caller poison'; first.sync_descriptors[0]!.key = 'caller_poison';
  assert.deepEqual(parse(raw), parseAttachmentAppManifest(raw));
  const changed = structuredClone(raw); changed.name = 'Same ID, different exact bytes';
  assert.equal(parse(changed).name, changed.name); assert.equal(parser.mock.callCount(), 2);
  changed.sync_descriptors[0].attachments.max_attachment_bytes--;
  assert.deepEqual(parse(changed), parseAttachmentAppManifest(changed)); assert.equal(parser.mock.callCount(), 3);
});

test('invalid and lossy non-JSON inputs never bypass parsing or seed a reusable value', () => {
  const parser = mock.fn(parseAttachmentAppManifest), parse = scopedParser(parser), raw = manifest();
  parse(raw);
  for (const value of [{ ...raw, version: 42 }, { ...raw, version: undefined }]) {
    const before = parser.mock.callCount();
    for (let count = 0; count < 2; count++) assert.throws(() => parse(value));
    assert.equal(parser.mock.callCount(), before + 2);
  }
  const accepts = mock.fn((_value: unknown) => parseAttachmentAppManifest(raw)), uncached = scopedParser(accepts);
  for (const value of [{ ...raw, future: undefined }, { ...raw, future: () => {} }, { ...raw, future: NaN },
    { ...raw, future: new Date() }, { ...raw, future: Array(1) }]) {
    uncached(value); uncached(value);
  }
  assert.equal(accepts.mock.callCount(), 10, 'stringify collisions cannot reuse a prior parsed object');
});

test('cache has a fixed entry and exact-key byte budget; eviction and oversized inputs parse freshly', () => {
  const parser = mock.fn(parseAttachmentAppManifest), parse = scopedParser(parser), raw = manifest();
  parse(raw);
  for (let index = 0; index < APP_AUTHORITY_MANIFEST_CACHE_ENTRIES; index++) parse({ ...raw, version: '9.0.' + index });
  const before = parser.mock.callCount(); parse(raw); assert.equal(parser.mock.callCount(), before + 1);
  const accepts = mock.fn((_value: unknown) => parseAttachmentAppManifest(raw)), uncached = scopedParser(accepts);
  const oversized = { data: 'x'.repeat(APP_AUTHORITY_MANIFEST_CACHE_KEY_BYTES + 1) };
  uncached(oversized); uncached(oversized); assert.equal(accepts.mock.callCount(), 2);
});

test('negative zero cannot collide with zero through JSON stringify', () => {
  const raw = manifest(), parser = mock.fn((value: unknown) => ({ ...parseAttachmentAppManifest(raw), numeric: (value as { numeric: number }).numeric }));
  const parse = scopedParser(parser);
  const negative = parse({ ...raw, numeric: -0 }) as ReturnType<typeof parser>;
  const zero = parse({ ...raw, numeric: 0 }) as ReturnType<typeof parser>;
  assert.equal(Object.is(negative.numeric, -0), true); assert.equal(Object.is(zero.numeric, 0), true);
  parse({ ...raw, numeric: -0 }); assert.equal(parser.mock.callCount(), 3);
});


test('manifest validation never shares across organizations/versions and unscoped callers parse freshly', () => {
  const raw = manifest(), parser = mock.fn(parseAttachmentAppManifest), parse = createAppAuthorityManifestParser(parser);
  parse(raw, scope); parse(raw, scope);
  assert.equal(parser.mock.callCount(), 1);
  parse(raw, { ...scope, org_id: 'org-b' });
  parse(raw, { ...scope, app_version_id: 'version-b' });
  parse(raw); parse(raw);
  assert.equal(parser.mock.callCount(), 5);
});
