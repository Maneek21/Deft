import assert from 'node:assert/strict';
import test from 'node:test';
import { composeDraftRevisionStatus, normalizeComposeAddressLists, parseComposeAddresses, prepareComposeDraftContent,
  selectedComposeIdentity, validateComposeFiles, validateComposePlainContent,
  type ComposeAddress, type ComposeFile, type ComposeFilePolicy, type ComposeIdentityOption } from './app-experience-compose-controls.js';

const draft = { draftId: 'draft-a', revision: 7, resourceTargetKey: 'work' };
const identities: ComposeIdentityOption[] = [{ key: 'work-main', label: 'Work', address: { address: 'sender@example.test', displayName: 'Sender' } }];
const policy: ComposeFilePolicy = { maxFiles: 2, maxFileBytes: 100, maxTotalBytes: 150, allowedMediaTypes: ['application/pdf'] };
const now = Date.parse('2026-09-30T00:00:00.000Z');
const file: ComposeFile = { key: 'file-a', filename: 'quote.pdf', byteCount: 80, status: 'ready', handle: 'opaque-file-a', draft,
  mediaType: 'application/pdf', digest: 'a'.repeat(64), expiresAt: '2026-09-30T01:00:00.000Z' };

test('tokenized recipients normalize domains and names while preserving local parts and first occurrence', () => {
  const result = parseComposeAddresses(' Alice <Alice@EXAMPLE.test>; "Doe, Jane" <jane@example.test>\r\nbob@example.test, alice@example.test');
  assert.ok(result.ok);
  assert.deepEqual(result.value.addresses, [{ address: 'Alice@example.test', displayName: 'Alice' },
    { address: 'jane@example.test', displayName: 'Doe, Jane' }, { address: 'bob@example.test', displayName: '' }]);
  assert.equal(result.value.duplicates, 1);
  const withExisting = parseComposeAddresses('ALICE@example.test, other@example.test', result.value.addresses);
  assert.ok(withExisting.ok); assert.equal(withExisting.value.addresses.length, 4); assert.equal(withExisting.value.duplicates, 1);
});

test('invalid pasted recipients fail atomically, including header injection and incomplete names', () => {
  const existing = [{ address: 'saved@example.test', displayName: '' }];
  for (const input of ['valid@example.test, broken', 'valid@example.test\r\nBcc:injected@example.test', 'a..b@example.test',
    'a@bad..test', 'a@-bad.test', '"unfinished <a@example.test>', 'Name <a@example.test', 'Name <a@example.test>>',
    'a@example.test\0', '"hidden\nname" <a@example.test>', 'Group: a@example.test;', 'Name (comment) <a@example.test> extra']) {
    const result = parseComposeAddresses(input, existing);
    assert.equal(result.ok, false, input);
  }
  assert.deepEqual(existing, [{ address: 'saved@example.test', displayName: '' }]);
});

test('recipient limits apply after deduplication within and across reviewed ordered fields', () => {
  const parsed = parseComposeAddresses('a@example.test, A@example.test', [], 1); assert.ok(parsed.ok);
  assert.equal(parseComposeAddresses('a@example.test, b@example.test', [], 1).ok, false);
  const normalized = normalizeComposeAddressLists([
    { key: 'primary', label: 'To', values: [{ address: 'a@example.test', displayName: 'First' }] },
    { key: 'copy', label: 'Cc', values: [{ address: 'A@example.test', displayName: 'Duplicate' }, { address: 'b@example.test', displayName: '' }] },
    { key: 'hidden', label: 'Bcc', values: [{ address: 'B@example.test', displayName: '' }] },
  ], 2);
  assert.ok(normalized.ok); assert.deepEqual(normalized.value.map(row => row.values.length), [1, 1, 0]);
  assert.equal(normalizeComposeAddressLists([{ key: 'to', label: 'To', values: parsed.value.addresses },
    { key: 'cc', label: 'Cc', values: [{ address: 'b@example.test', displayName: '' }] }], 1).ok, false);
  assert.equal(normalizeComposeAddressLists([{ key: 'same', label: 'To', values: [] }, { key: 'same', label: 'Cc', values: [] }]).ok, false);
  assert.equal(parseComposeAddresses('x'.repeat(65_537)).ok, false);
});

test('identity choice requires the exact host verified option and cannot fall back to a different sender', () => {
  assert.ok(selectedComposeIdentity(identities, 'work-main').ok);
  for (const key of ['', 'personal', 'sender@example.test']) assert.equal(selectedComposeIdentity(identities, key).ok, false);
  assert.equal(selectedComposeIdentity([], 'work-main').ok, false);
  assert.equal(selectedComposeIdentity([...identities, identities[0]], 'work-main').ok, false);
  assert.equal(selectedComposeIdentity([{ ...identities[0], address: { address: 'other@example.test\r\nX: y', displayName: '' } }], 'work-main').ok, false);
});

test('plain editor validates actual UTF-8 bytes without truncation or HTML interpretation', () => {
  assert.equal(validateComposePlainContent({ format: 'plain', text: 'é🙂' }, 6), null);
  assert.equal(validateComposePlainContent({ format: 'plain', text: 'é🙂' }, 5)?.code, 'COMPOSE_CONTENT_LIMIT');
  assert.equal(validateComposePlainContent({ format: 'plain', text: '<img src="https://example.test">\ntext\t' }, 100), null);
  for (const text of ['nul\0', 'bad\u000b', 'bad\u007f', '\ud800']) assert.equal(validateComposePlainContent({ format: 'plain', text }, 100)?.code, 'COMPOSE_CONTENT_INVALID');
  assert.equal(validateComposePlainContent({ format: 'rich', text: '<p>text</p>' } as never, 100)?.code, 'COMPOSE_CONTENT_INVALID');
});

test('plain editor character budget matches Runtime string length and retains over-limit content for correction', () => {
  const content = { format: 'plain' as const, text: 'é🙂' };
  assert.equal(validateComposePlainContent(content, 12, 3), null);
  assert.equal(validateComposePlainContent(content, 12, 2)?.error, 'The content exceeds its 2 character limit.');
  assert.equal(validateComposePlainContent(content, 5, 3)?.error, 'The content exceeds its 5 byte limit.');
  assert.equal(content.text, 'é🙂');
  assert.equal(validateComposePlainContent(content, 12, 0)?.code, 'COMPOSE_CONTENT_INVALID');
});

test('record-form plaintext accepts its declared262144-character ceiling without a false control-character warning', () => {
  const short = { format: 'plain' as const, text: 'This template is a controlled UI check. No email will be sent.' };
  assert.equal(validateComposePlainContent(short, 1_048_576, 262_144), null);
  const maximum = { format: 'plain' as const, text: 'x'.repeat(262_144) };
  assert.equal(validateComposePlainContent(maximum, 1_048_576, 262_144), null);
  assert.equal(validateComposePlainContent({ ...maximum, text: maximum.text + 'x' }, 1_048_576, 262_144)?.code, 'COMPOSE_CONTENT_LIMIT');
  assert.equal(validateComposePlainContent(maximum, 1_048_576, 16_384)?.code, 'COMPOSE_CONTENT_LIMIT');
  assert.equal(validateComposePlainContent(short, 1_048_576, 262_145)?.code, 'COMPOSE_CONTENT_INVALID');
  assert.equal(validateComposePlainContent({ ...short, text: 'bad\u000b' }, 1_048_576, 262_144)?.code, 'COMPOSE_CONTENT_INVALID');
});

test('draft replacement, target switching and cross-tab revisions remain conflicts', () => {
  assert.equal(composeDraftRevisionStatus(draft, { ...draft }), 'current');
  for (const current of [{ ...draft, revision: 8 }, { ...draft, revision: 6 }, { ...draft, draftId: 'draft-b' }, { ...draft, resourceTargetKey: 'personal' }]) {
    assert.equal(composeDraftRevisionStatus(draft, current), 'conflict');
  }
  assert.equal(composeDraftRevisionStatus(draft, null), 'unavailable');
  assert.equal(composeDraftRevisionStatus({ ...draft, revision: 0 }, draft), 'unavailable');
});

test('only finalized current-draft file handles pass; pending, stale, expired and URL rows are blocked', () => {
  assert.equal(validateComposeFiles([file], draft, policy, now), null);
  for (const status of ['pending', 'uploading', 'failed'] as const) {
    assert.equal(validateComposeFiles([{ key: 'local', filename: 'quote.pdf', byteCount: 80, status }], draft, policy, now)?.code, 'COMPOSE_FILE_UNAVAILABLE');
  }
  assert.equal(validateComposeFiles([{ ...file, draft: { ...draft, revision: 6 } }], draft, policy, now)?.code, 'COMPOSE_DRAFT_CONFLICT');
  assert.equal(validateComposeFiles([{ ...file, draft: { ...draft, resourceTargetKey: 'personal' } }], draft, policy, now)?.code, 'COMPOSE_DRAFT_CONFLICT');
  for (const changed of [{ ...file, handle: 'https://provider.test/file' }, { ...file, filename: '../quote.pdf' }, { ...file, mediaType: 'text/html' },
    { ...file, digest: 'changed' }, { ...file, expiresAt: '2026-09-30T00:00:00.000Z' }, { ...file, byteCount: NaN }]) {
    assert.equal(validateComposeFiles([changed], draft, policy, now)?.code, 'COMPOSE_FILE_UNAVAILABLE');
  }
  assert.equal(validateComposeFiles([file, file], draft, policy, now)?.code, 'COMPOSE_FILE_UNAVAILABLE');
  assert.equal(validateComposeFiles([{ ...file, byteCount: 101 }], draft, policy, now)?.code, 'COMPOSE_FILE_LIMIT');
  assert.equal(validateComposeFiles([file, { ...file, key: 'b', handle: 'opaque-b' }], draft, policy, now)?.code, 'COMPOSE_FILE_LIMIT');
});

test('typed draft proposal flushes pending tokens and copies exact selected handles while guarding every blocked state', () => {
  const addresses: ComposeAddress[] = [{ address: 'recipient@example.test', displayName: 'Recipient' }];
  const input = { draft: { ...draft }, revisionStatus: 'current' as const, identityOptions: identities, identityKey: 'work-main',
    addressLists: [{ key: 'primary', label: 'To', values: addresses, pendingText: 'second@example.test' }],
    content: { format: 'plain' as const, text: 'hello' }, files: [file] };
  const bounds = { maxRecipients: 2, maxContentBytes: 10, files: policy };
  const prepared = prepareComposeDraftContent(input, bounds, now); assert.ok(prepared.ok);
  assert.deepEqual(prepared.value.fileHandles, ['opaque-file-a']); assert.equal(prepared.value.addressLists[0].values.length, 2);
  addresses[0] = { address: 'substituted@example.test', displayName: '' }; input.content.text = 'changed'; input.draft.revision = 8;
  assert.equal(prepared.value.addressLists[0].values[0].address, 'recipient@example.test');
  assert.equal(prepared.value.content.text, 'hello'); assert.equal(prepared.value.draft.revision, 7);
  const original = { ...input, draft, content: { format: 'plain' as const, text: 'hello' }, addressLists: [] };
  for (const revisionStatus of ['saving', 'conflict', 'unavailable'] as const) assert.equal(prepareComposeDraftContent({ ...original, revisionStatus }, bounds, now).ok, false);
  assert.equal(prepareComposeDraftContent({ ...original, identityKey: 'unknown' }, bounds, now).ok, false);
  assert.equal(prepareComposeDraftContent({ ...original, addressLists: [{ key: 'to', label: 'To', values: [], pendingText: 'invalid' }] }, bounds, now).ok, false);
  assert.equal(prepareComposeDraftContent(original, { ...bounds, maxContentBytes: 4 }, now).ok, false);
  assert.equal(prepareComposeDraftContent(original, { maxRecipients: 2, maxContentBytes: 10 }, now).ok, false);
});
