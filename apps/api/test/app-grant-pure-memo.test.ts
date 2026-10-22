import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import * as core from '@deft/app-kit/core';
import * as crypto from 'node:crypto';

const project = mock.fn(core.projectDeftAppRequestedAuthority), hash = mock.fn(crypto.createHash);
mock.module('@deft/app-kit/core', { namedExports: { ...core, projectDeftAppRequestedAuthority: project } });
mock.module('node:crypto', { namedExports: { ...Object.fromEntries(Object.entries(crypto).filter(([key]) => key !== 'default')), createHash: hash } });
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: {} } });
const { digestAppGrantValue, canonicalizeAppGrantValue, buildRequestedAppGrantProjection } = await import('../src/lib/app-grant-service.js');
const expectedDigest = (value: unknown) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonicalizeAppGrantValue(value)), 'utf8').digest('hex');

test('exact JSON digest reuse preserves canonical output and reevaluates changed or lossy input', () => {
  const value = { nonce: crypto.randomUUID(), value: 'e\u0301', nested: { b: 2, a: ['x', true, null] } };
  const before = hash.mock.callCount();
  assert.equal(digestAppGrantValue(value), expectedDigest(value));
  assert.equal(digestAppGrantValue(structuredClone(value)), expectedDigest(value));
  assert.equal(hash.mock.callCount() - before, 1, 'an exact safe payload should be hashed only once');
  value.nested.b++; assert.equal(digestAppGrantValue(value), expectedDigest(value));
  assert.equal(hash.mock.callCount() - before, 2, 'identity reuse must not hide changed bytes');
  for (const nonJson of [new Date(), { ignored: undefined }, -0]) {
    const at = hash.mock.callCount(); digestAppGrantValue(nonJson); digestAppGrantValue(nonJson);
    assert.equal(hash.mock.callCount() - at, 2, 'non-JSON inputs retain their original canonical behavior without reuse');
  }
  let reads = 0; const getter = { get changing() { return ++reads; } };
  assert.notEqual(digestAppGrantValue(getter), digestAppGrantValue(getter)); assert.equal(reads, 2);
  assert.throws(() => digestAppGrantValue({ bad: Number.NaN }), TypeError);
});

test('requested projections reuse only exact complete input and return isolated results', () => {
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8'));
  const input = { organization_id: crypto.randomUUID(), app_installation_id: crypto.randomUUID(), app_version_id: crypto.randomUUID(),
    manifest, manifest_digest: 'sha256:' + 'a'.repeat(64), package_digest: 'sha256:' + 'b'.repeat(64) };
  const before = project.mock.callCount(), first = buildRequestedAppGrantProjection(input), expected = structuredClone(first);
  first.classification.provider_access = true; (first.canonical_snapshot.app as any).id = 'changed-by-caller';
  assert.deepEqual(buildRequestedAppGrantProjection(structuredClone(input)), expected);
  assert.equal(project.mock.callCount() - before, 1);
  for (const changed of [{ ...input, organization_id: crypto.randomUUID() }, { ...input, app_installation_id: crypto.randomUUID() },
    { ...input, app_version_id: crypto.randomUUID() }, { ...input, manifest_digest: 'sha256:' + 'c'.repeat(64) },
    { ...input, package_digest: 'sha256:' + 'd'.repeat(64) }, { ...input, manifest: { ...manifest, name: 'Different manifest bytes' } }]) {
    buildRequestedAppGrantProjection(changed);
  }
  assert.equal(project.mock.callCount() - before, 7, 'every scope, advertised digest and manifest byte remains part of the key');
  const invalid = { ...input, manifest: { ...manifest, unexpected_authority: true } };
  assert.throws(() => buildRequestedAppGrantProjection(invalid)); assert.throws(() => buildRequestedAppGrantProjection(invalid));
  assert.equal(project.mock.callCount() - before, 9, 'invalid results must never be cached');
  for (let i = 0; i < 9; i++) buildRequestedAppGrantProjection({ ...input, organization_id: crypto.randomUUID() });
  const at = project.mock.callCount(); assert.deepEqual(buildRequestedAppGrantProjection(input), expected);
  assert.equal(project.mock.callCount(), at + 1, 'the bounded projection cache must evict old complete inputs');
});
