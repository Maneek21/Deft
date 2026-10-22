import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, mock } from 'node:test';
import { digestResourceSyncDescriptorV2 } from '@deft/app-kit/core';
import { createAppAuthorityDescriptorDigester, APP_AUTHORITY_DESCRIPTOR_CACHE_ENTRIES,
  APP_AUTHORITY_DESCRIPTOR_CACHE_KEY_BYTES } from '../src/lib/app-authority-descriptor.js';

const scope = { org_id: 'org-a', app_version_id: 'version-a' };
const descriptor = () => JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8')).sync_descriptors[0];

test('complete current descriptor bytes reuse only the exact Kit digest in one org/version', async () => {
  const digester = mock.fn(digestResourceSyncDescriptorV2), digest = createAppAuthorityDescriptorDigester(digester), raw = descriptor();
  const expected = await digestResourceSyncDescriptorV2(raw);
  assert.equal(await digest(raw, scope), expected);
  assert.equal(await digest(structuredClone(raw), scope), expected);
  assert.equal(digester.mock.callCount(), 1);
  await digest(raw, { ...scope, org_id: 'org-b' });
  await digest(raw, { ...scope, app_version_id: 'version-b' });
  assert.equal(digester.mock.callCount(), 3, 'identical content cannot cross organization/version scope');
});

test('every changed descriptor subtree recomputes under unchanged descriptor identity', async () => {
  const raw = descriptor(), digester = mock.fn(digestResourceSyncDescriptorV2), digest = createAppAuthorityDescriptorDigester(digester);
  const initial = await digest(raw, scope);
  const changes = [
    (value: typeof raw) => { value.record_schema.properties.body.maxLength--; },
    (value: typeof raw) => { value.record_schema.required = ['subject']; },
    (value: typeof raw) => { value.attachments.max_attachment_bytes--; },
    (value: typeof raw) => { value.attachments.allowed_media_types = ['text/plain']; },
    (value: typeof raw) => { value.attachments.retention_days++; },
    (value: typeof raw) => { value.runtime_requirement_key = 'other_provider'; },
    (value: typeof raw) => { value.resource_type = 'other_record'; },
  ];
  for (const change of changes) {
    const changed = structuredClone(raw); change(changed);
    assert.equal(changed.key, raw.key);
    const expected = await digestResourceSyncDescriptorV2(changed);
    assert.notEqual(expected, initial);
    assert.equal(await digest(changed, scope), expected);
  }
  assert.equal(digester.mock.callCount(), changes.length + 1);
  assert.equal(await digest(raw, scope), initial, 'mutating caller input cannot poison retained content');
});

test('malformed content never reuses valid content and failures never seed a digest', async () => {
  const raw = descriptor(), digester = mock.fn(digestResourceSyncDescriptorV2), digest = createAppAuthorityDescriptorDigester(digester);
  await digest(raw, scope);
  for (const changed of [{ ...raw, unexpected: true }, { ...raw, schema_version: 'wrong' },
    { ...raw, attachments: { ...raw.attachments, max_attachment_bytes: -1 } },
    { ...raw, record_schema: { ...raw.record_schema, properties: { subject: { type: 'invalid' } } } }]) {
    const before = digester.mock.callCount();
    await assert.rejects(digest(changed, scope)); await assert.rejects(digest(changed, scope));
    assert.equal(digester.mock.callCount(), before + 2);
  }
});

test('non-JSON, lossy and oversized evidence always runs the original digester without retention', async () => {
  const expected = await digestResourceSyncDescriptorV2(descriptor());
  const digester = mock.fn(async (_raw: unknown): Promise<typeof expected> => expected), digest = createAppAuthorityDescriptorDigester(digester);
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'do not inspect' });
  const symbol = { [Symbol('key')]: true }, prototype = Object.create({ inherited: true });
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const raw of [{ value: undefined }, { value: NaN }, { value: -0 }, { value: new Date() },
    { value: () => {} }, { value: Array(1) }, accessor, symbol, prototype, cyclic,
    { value: 'x'.repeat(APP_AUTHORITY_DESCRIPTOR_CACHE_KEY_BYTES + 1) }]) {
    const before = digester.mock.callCount();
    assert.equal(await digest(raw, scope), expected); assert.equal(await digest(raw, scope), expected);
    assert.equal(digester.mock.callCount(), before + 2);
  }
});

test('async mutation cannot seed an earlier content fingerprint', async () => {
  const raw = descriptor(), original = structuredClone(raw);
  let release!: () => void, captured!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { captured = resolve; });
  const digest = createAppAuthorityDescriptorDigester(async value => {
    calls++; const result = await digestResourceSyncDescriptorV2(structuredClone(value));
    if (calls === 1) { captured(); await gate; }
    return result;
  });
  const first = digest(raw, scope); await started;
  raw.attachments.max_attachment_bytes--; release(); await first;
  assert.equal(await digest(raw, scope), await digestResourceSyncDescriptorV2(raw));
  await digest(original, scope);
  assert.equal(calls, 3, 'changed-in-flight evidence must not retain the first digest');
});

test('real Kit captures bytes synchronously and an ABA caller mutation cannot poison the digest', async () => {
  const raw = descriptor(), expected = await digestResourceSyncDescriptorV2(raw);
  let returned = false, reads = 0;
  const guarded = new Proxy(raw, { get(target, key, receiver) {
    assert.equal(returned, false, 'Kit must not read caller JSON after its first await'); reads++;
    return Reflect.get(target, key, receiver);
  } });
  const pendingKit = digestResourceSyncDescriptorV2(guarded);
  returned = true; assert.ok(reads > 0, 'real schema parsing starts before returning the promise');
  assert.equal(await pendingKit, expected);
  const digester = mock.fn(digestResourceSyncDescriptorV2), digest = createAppAuthorityDescriptorDigester(digester);
  const pending = digest(raw, scope);
  raw.attachments.max_attachment_bytes--; raw.attachments.max_attachment_bytes++;
  assert.equal(await pending, expected);
  assert.equal(await digest(raw, scope), expected); assert.equal(digester.mock.callCount(), 1);
  raw.attachments.max_attachment_bytes--;
  assert.equal(await digest(raw, scope), await digestResourceSyncDescriptorV2(raw));
  assert.equal(digester.mock.callCount(), 2);
});

test('concurrent misses retain no promise and bounded eviction computes again', async () => {
  const raw = descriptor(), digester = mock.fn(digestResourceSyncDescriptorV2), digest = createAppAuthorityDescriptorDigester(digester);
  await Promise.all([digest(raw, scope), digest(structuredClone(raw), scope)]);
  assert.equal(digester.mock.callCount(), 2);
  await digest(raw, scope); assert.equal(digester.mock.callCount(), 2);
  for (let index = 0; index < APP_AUTHORITY_DESCRIPTOR_CACHE_ENTRIES; index++) await digest({ ...raw, key: 'resource_' + index }, scope);
  const before = digester.mock.callCount(); await digest(raw, scope);
  assert.equal(digester.mock.callCount(), before + 1);
});
