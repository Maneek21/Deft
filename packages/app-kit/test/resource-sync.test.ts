import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESOURCE_SYNC_LIMITS,
  canonicalSyncPageJson,
  parseSyncDescriptor,
  parseSyncPage,
  parseSyncRequest,
} from '../src/resource-sync.js';

const descriptor = {
  schema_version: 'deft.app_sync_descriptor.v1',
  key: 'mailbox', runtime_requirement_key: 'mail_runtime',
  resource_type: 'email_message', requested_visibility: 'user_private',
  record_schema: { type: 'object', properties: {
    subject: { type: 'string', maxLength: 200 },
    body: { type: 'string', maxLength: 16_384 },
    owner_id: { type: 'string', maxLength: 120 },
    url: { type: 'string', maxLength: 120 },
  }, required: ['subject'], additionalProperties: false },
  label_field: 'subject',
} as const;
const request = { schema_version: 'deft.app_sync_request.v1', cursor: 'cursor-1', max_items: 100 } as const;
const page = { schema_version: 'deft.app_sync_page.v1',
  upserts: [{ id: 'message-1', revision: 'rev:1',
    data: { subject: 'Hello', body: 'Private body', owner_id: 'inert-business-value',
      url: 'https://provider.example.invalid/item' } }],
  tombstones: [{ id: 'message-2', revision: 'rev:2' }],
  next_cursor: 'cursor-2', has_more: true } as const;

test('golden v1 page preserves only declared scalar data and stable canonical bytes', () => {
  assert.deepEqual(parseSyncDescriptor(descriptor).record_schema.required, ['subject']);
  assert.equal(parseSyncRequest(request).cursor, 'cursor-1');
  const parsed = parseSyncPage(descriptor, request, page);
  assert.deepEqual(parsed, page);
  assert.equal(canonicalSyncPageJson(parsed),
    '{"has_more":true,"next_cursor":"cursor-2","schema_version":"deft.app_sync_page.v1",'
    + '"tombstones":[{"id":"message-2","revision":"rev:2"}],'
    + '"upserts":[{"data":{"body":"Private body","owner_id":"inert-business-value",'
    + '"subject":"Hello","url":"https://provider.example.invalid/item"},'
    + '"id":"message-1","revision":"rev:1"}]}');
  assert.equal(canonicalSyncPageJson({ ...parsed, upserts: [{ ...parsed.upserts[0]!,
    data: { url: parsed.upserts[0]!.data.url!, subject: 'Hello',
      owner_id: 'inert-business-value', body: 'Private body' } }] }), canonicalSyncPageJson(parsed));
});

test('descriptor and request admit no authority, URL, owner, or executable envelope fields', () => {
  for (const extra of [{ org_id: 'other' }, { owner_id: 'other' }, { url: 'https://x' },
    { acl: ['anyone'] }, { endpoint: 'https://x' }, { filter: { any: true } }]) {
    assert.throws(() => parseSyncDescriptor({ ...descriptor, ...extra }));
    assert.throws(() => parseSyncRequest({ ...request, ...extra }));
    assert.throws(() => parseSyncPage(descriptor, request, { ...page, ...extra }));
  }
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    upserts: [{ ...page.upserts[0], owner_id: 'other' }] }));
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    tombstones: [{ ...page.tombstones[0], url: '/private' }] }));
  assert.equal(parseSyncPage(descriptor, request, page).upserts[0]!.data.url,
    'https://provider.example.invalid/item');
});

test('descriptor requires a declared, required, bounded string label and closed scalar fields', () => {
  for (const changed of [
    { ...descriptor, label_field: 'body' },
    { ...descriptor, label_field: 'missing' },
    { ...descriptor, record_schema: { ...descriptor.record_schema,
      properties: { ...descriptor.record_schema.properties,
        subject: { type: 'string', maxLength: 201 } } } },
    { ...descriptor, record_schema: { ...descriptor.record_schema,
      properties: { ...descriptor.record_schema.properties,
        subject: { type: 'boolean' } } } },
    { ...descriptor, record_schema: { ...descriptor.record_schema,
      additionalProperties: true } },
    { ...descriptor, record_schema: { ...descriptor.record_schema,
      properties: { subject: { type: 'string', maxLength: 200 },
        ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, { type: 'boolean' }])) } } },
  ]) assert.throws(() => parseSyncDescriptor(changed));
  const exact32 = { ...descriptor, record_schema: { ...descriptor.record_schema,
    properties: { subject: { type: 'string' as const, maxLength: 200 },
      ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, { type: 'boolean' }])) } } };
  assert.doesNotThrow(() => parseSyncDescriptor(exact32));
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    upserts: [{ id: 'message-1', revision: 'rev:1', data: { subject: 'Hello', extra: true } }] }));
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    upserts: [{ id: 'message-1', revision: 'rev:1', data: { subject: 4 } }] }));
  for (const subject of ['', ' \t ', '\u0000\n']) {
    assert.throws(() => parseSyncPage(descriptor, request, { ...page,
      upserts: [{ id: 'message-1', revision: 'rev:1', data: { subject } }] }));
  }
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    upserts: [{ id: 'message-1', revision: 'rev:1', data: { subject: 'x'.repeat(201) } }] }));
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    upserts: [{ id: 'message-1', revision: 'rev:1',
      data: { subject: 'Valid label', body: '\ud800' } }] }), /malformed Unicode/);
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    upserts: [{ id: 'message-1', revision: 'rev:1',
      data: { subject: 'Valid\ud800 label' } }] }), /malformed Unicode/);
});

test('cursor progression and UTF-8 byte bounds are exact', () => {
  assert.equal(parseSyncRequest({ ...request, cursor: '🙂'.repeat(512) }).cursor,
    '🙂'.repeat(512));
  assert.throws(() => parseSyncRequest({ ...request, cursor: '🙂'.repeat(513) }));
  assert.throws(() => parseSyncRequest({ ...request, cursor: 'x'.repeat(1_000_000) }));
  assert.throws(() => parseSyncRequest({ ...request, cursor: '\ud800' }));
  assert.throws(() => parseSyncRequest({ ...request, cursor: 'x\n' }));
  assert.equal(parseSyncPage(descriptor, request,
    { ...page, next_cursor: '🙂'.repeat(512) }).next_cursor, '🙂'.repeat(512));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, next_cursor: '🙂'.repeat(513) }));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, next_cursor: 'cursor-1' }));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, next_cursor: null }));
  assert.doesNotThrow(() => parseSyncPage(descriptor, request,
    { ...page, upserts: [], tombstones: [], next_cursor: 'cursor-2' }));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, upserts: [], tombstones: [], next_cursor: 'cursor-1' }));
  assert.doesNotThrow(() => parseSyncPage(descriptor, request,
    { ...page, has_more: false, next_cursor: null }));
});

test('item count, duplicate IDs, exact resource identities and version fields are closed', () => {
  const tombstones = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, revision: 'r:1' }));
  assert.equal(parseSyncPage(descriptor, request,
    { ...page, upserts: [], tombstones }).tombstones.length, 100);
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, tombstones }));
  assert.throws(() => parseSyncPage(descriptor, { ...request, max_items: 1 }, page));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, tombstones: [{ id: 'message-1', revision: 'r:2' }] }));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, tombstones: [page.tombstones[0], page.tombstones[0]] }));
  for (const badId of ['', ' spaced ', 'x'.repeat(257), 'not/a/path', 'x\n']) {
    assert.throws(() => parseSyncPage(descriptor, request, { ...page,
      tombstones: [{ id: badId, revision: 'r:2' }] }));
  }
  assert.doesNotThrow(() => parseSyncPage(descriptor, request, { ...page,
    tombstones: [{ id: 'x'.repeat(256), revision: 'r'.repeat(128) }] }));
  assert.throws(() => parseSyncPage(descriptor, request, { ...page,
    tombstones: [{ id: 'x', revision: 'r'.repeat(129) }] }));
  assert.throws(() => parseSyncDescriptor({ ...descriptor, resource_type: 'x'.repeat(65) }));
  assert.throws(() => parseSyncDescriptor({ ...descriptor, resource_type: 'Email/URL' }));
  assert.throws(() => parseSyncRequest({ ...request, schema_version: 'deft.app_runtime_channel.v1' }));
  assert.throws(() => parseSyncPage(descriptor, request,
    { ...page, schema_version: 'deft.app_runtime_channel.v1' }));
  assert.throws(() => canonicalSyncPageJson({ ...page, owner_id: 'not a page field' }));
});

test('canonical full-page 512 KiB ceiling accepts the boundary and rejects one byte more', () => {
  const large = { ...page, upserts: Array.from({ length: 100 }, (_, i) => ({
    id: `item-${i}`, revision: 'r:1', data: { subject: 'Label', body: 'x'.repeat(4_000) },
  })), tombstones: [] };
  const deficit = RESOURCE_SYNC_LIMITS.page_bytes - Buffer.byteLength(canonicalSyncPageJson(large));
  assert.ok(deficit > 0 && deficit < 100 * 16_384);
  const perItem = Math.floor(deficit / 100);
  const remainder = deficit % 100;
  for (const [index, row] of large.upserts.entries()) {
    row.data.body += 'x'.repeat(perItem + (index === 0 ? remainder : 0));
  }
  assert.equal(Buffer.byteLength(canonicalSyncPageJson(large)), RESOURCE_SYNC_LIMITS.page_bytes);
  assert.doesNotThrow(() => parseSyncPage(descriptor, request, large));
  large.upserts[0]!.data.body += 'x';
  assert.equal(Buffer.byteLength(canonicalSyncPageJson(large)), RESOURCE_SYNC_LIMITS.page_bytes + 1);
  assert.throws(() => parseSyncPage(descriptor, request, large), /512 KiB/);
});
