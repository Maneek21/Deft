import assert from 'node:assert/strict';
import test from 'node:test';
import { composerFileDigest, composerFileSelectionError, composerInputDigest, composerSnapshotCurrent,
  parseComposerDraftPolicy, parseComposerPrivateFiles, parseComposerSnapshot, privateFilesForControls,
  type ComposerPrivateFile } from './app-experience-compose-files.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-09-30T00:00:00.000Z'), expires = '2026-09-30T01:00:00.000Z';
const policy = { max_file_bytes: 2_097_152, max_files_per_record: 1,
  max_total_bytes_per_record: 2_097_152, allowed_media_types: ['application/pdf'] };
const file: ComposerPrivateFile = { file_id: id(2), upload_operation_id: id(3), filename: 'proof.pdf', media_type: 'application/pdf',
  byte_length: 80, digest: 'a'.repeat(64), expires_at: expires };
const ref = { draft_state_key: 'drafts', draft_id: id(1), expected_revision: 7 };
const input = { to: 'recipient@example.test', body: 'Plain\nbody' };
const response = { schema_version: 'deft.private_files.v1', draft: { record_id: id(1), revision: 7 }, files: [file] };

test('draft file discovery uses only exact reviewed state/policy and keeps absence compatible', () => {
  assert.equal(parseComposerDraftPolicy(undefined, 'drafts'), null);
  assert.deepEqual(parseComposerDraftPolicy({ draft_state_key: 'drafts', files: policy, max_payload_bytes: 4_194_304 }, 'drafts'),
    { draft_state_key: 'drafts', files: policy, max_payload_bytes: 4_194_304 });
  for (const value of [{ draft_state_key: 'other', files: policy }, { draft_state_key: 'drafts', files: { ...policy, max_file_bytes: 2_097_153 } },
    { draft_state_key: 'drafts', max_payload_bytes: 8_388_609 }, { draft_state_key: 'drafts', files: { ...policy, allowed_media_types: ['text/html'] } },
    { draft_state_key: 'drafts', files: { ...policy, allowed_media_types: ['application/pdf', 'application/pdf'] } },
    { draft_state_key: 'drafts', provider_url: 'https://example.test' }]) assert.throws(() => parseComposerDraftPolicy(value, 'drafts'));
});

test('file list requires exact draft identity, live complete metadata, limits and opaque IDs', () => {
  assert.deepEqual(parseComposerPrivateFiles(response, id(1), policy, now), response);
  for (const value of [{ ...response, draft: { record_id: id(4), revision: 7 } }, { ...response, draft: { record_id: id(1), revision: 0 } },
    { ...response, files: [file, file] }, { ...response, files: [{ ...file, byte_length: 2_097_153 }] },
    { ...response, files: [{ ...file, file_id: 'https://example.test/file' }] }, { ...response, files: [{ ...file, digest: 'sha256:' + file.digest }] },
    { ...response, files: [{ ...file, expires_at: '2026-09-30T00:00:00.000Z' }] },
    { ...response, files: [{ ...file, filename: '../proof.pdf' }] }, { ...response, files: [{ ...file, storage_key: 'private' }] }]) {
    assert.throws(() => parseComposerPrivateFiles(value, id(1), policy, now));
  }
  const ui = privateFilesForControls(response.files, { draftId: id(1), revision: 8, resourceTargetKey: 'work' });
  assert.equal(ui[0].status, 'ready'); if (ui[0].status === 'ready') { assert.equal(ui[0].handle, file.file_id); assert.equal(ui[0].draft.revision, 8); }
});

test('selection limits fail before upload, preserve bytes, and reject file-name/header injection', () => {
  const selection = { name: 'proof.pdf', size: 2_097_152, type: 'application/pdf' };
  assert.equal(composerFileSelectionError(selection, [], policy), null);
  for (const changed of [{ ...selection, size: 0 }, { ...selection, size: 2_097_153 }, { ...selection, type: 'text/html' },
    { ...selection, name: 'x\r\nBcc: other@example.test' }, { ...selection, name: '\ud800.pdf' }]) {
    assert.ok(composerFileSelectionError(changed, [], policy));
  }
  assert.ok(composerFileSelectionError(selection, [file], policy)); assert.equal(selection.size, 2_097_152);
});

test('client digests use canonical scalar input and exact file bytes', async () => {
  const a = await composerInputDigest({ body: 'Plain\nbody', to: 'recipient@example.test' });
  assert.equal(a, await composerInputDigest(input)); assert.match(a, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(a, await composerInputDigest({ ...input, body: input.body + ' ' }));
  assert.equal(await composerFileDigest(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('snapshot accepts only exact current draft, input digest, full file catalog and bounded preview', async () => {
  const input_digest = await composerInputDigest(input);
  const raw = { schema_version: 'deft.experience_human_action_snapshot.v1', snapshot_ref: { snapshot_id: id(5), digest: 'b'.repeat(64) },
    draft_ref: ref, input_digest, expires_at: expires,
    preview: { items: [{ key: 'from', label: 'From', value: 'trusted@example.test' }, { key: 'body', label: 'Message', value: '<img>\nPlain body' }], files: [file] } };
  const snapshot = parseComposerSnapshot(raw, ref, input, input_digest, [file], policy, now);
  assert.equal(snapshot.preview.items[1].value, '<img>\nPlain body'); assert.equal(composerSnapshotCurrent(snapshot, ref, input, [file], now), true);
  assert.equal(composerSnapshotCurrent(snapshot, { ...ref, expected_revision: 8 }, input, [file], now), false);
  assert.equal(composerSnapshotCurrent(snapshot, ref, { ...input, body: 'edit' }, [file], now), false);
  assert.equal(composerSnapshotCurrent(snapshot, ref, input, [], now), false);
  assert.equal(composerSnapshotCurrent(snapshot, ref, input, [file], Date.parse(expires)), false);
  for (const changed of [{ ...raw, input_digest: 'sha256:' + '0'.repeat(64) }, { ...raw, draft_ref: { ...ref, expected_revision: 6 } },
    { ...raw, expires_at: '2026-09-30T00:00:00.000Z' }, { ...raw, preview: { ...raw.preview, files: [] } },
    { ...raw, preview: { ...raw.preview, files: [{ ...file, digest: 'c'.repeat(64) }] } },
    { ...raw, preview: { ...raw.preview, items: [raw.preview.items[0], raw.preview.items[0]] } },
    { ...raw, preview: { ...raw.preview, items: [{ key: 'body', label: 'Body', value: 'x'.repeat(16_385) }] } },
    { ...raw, snapshot_ref: { ...raw.snapshot_ref, provider_url: 'https://example.test' } }]) {
    assert.throws(() => parseComposerSnapshot(changed, ref, input, input_digest, [file], policy, now));
  }
});

test('payload-only snapshot needs no file policy and cannot smuggle a file', async () => {
  const input_digest = await composerInputDigest(input);
  const raw = { schema_version: 'deft.experience_human_action_snapshot.v1', snapshot_ref: { snapshot_id: id(5), digest: 'b'.repeat(64) },
    draft_ref: ref, input_digest, expires_at: expires, preview: { items: [], files: [] } };
  assert.ok(parseComposerSnapshot(raw, ref, input, input_digest, [], undefined, now));
  assert.throws(() => parseComposerSnapshot({ ...raw, preview: { items: [], files: [file] } }, ref, input, input_digest, [], undefined, now));
});
