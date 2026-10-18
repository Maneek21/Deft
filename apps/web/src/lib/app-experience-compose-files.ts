import { canonicalCapabilityJson } from '@deft/shared';
import type { ComposerInput } from './app-experience-action-composer';
import type { ComposeFile } from './app-experience-compose-controls';

export type ComposerFilesPolicy = Readonly<{ max_file_bytes: number; max_files_per_record: number;
  max_total_bytes_per_record: number; allowed_media_types: readonly string[] }>;
export type ComposerDraftPolicy = Readonly<{ draft_state_key: string; files?: ComposerFilesPolicy; max_payload_bytes?: number }>;
export type ComposerPrivateFile = Readonly<{ file_id: string; upload_operation_id: string; filename: string;
  media_type: string; byte_length: number; digest: string; expires_at: string }>;
export type ComposerPrivateFiles = Readonly<{ schema_version: 'deft.private_files.v1';
  draft: Readonly<{ record_id: string; revision: number }>; files: readonly ComposerPrivateFile[] }>;
export type ComposerDraftRef = Readonly<{ draft_state_key: string; draft_id: string; expected_revision: number }>;
export type ComposerSnapshot = Readonly<{ snapshot_ref: Readonly<{ snapshot_id: string; digest: string }>;
  draft_ref: ComposerDraftRef; input_digest: string; expires_at: string; inputFingerprint: string;
  preview: Readonly<{ items: readonly Readonly<{ key: string; label: string; value: string }>[]; files: readonly ComposerPrivateFile[] }> }>;

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const key = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/u.test(value);
const limit = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const mediaTypes = ['text/plain', 'text/csv', 'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
const closed = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name) || optional.includes(name));
const expiry = (value: unknown, now: number): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export const validComposerFileName = (value: unknown): value is string => text(value, 200)
  && new TextEncoder().encode(value).byteLength <= 800 && !/[\\/]/u.test(value) && value !== '.' && value !== '..'
  && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);

export function parseComposerDraftPolicy(value: unknown, stateKey: string): ComposerDraftPolicy | null {
  if (value === undefined) return null;
  if (!object(value) || !closed(value, ['draft_state_key'], ['files', 'max_payload_bytes']) || value.draft_state_key !== stateKey
    || !key(value.draft_state_key) || (Object.hasOwn(value, 'max_payload_bytes') && !limit(value.max_payload_bytes, 8_388_608))) throw Error('Invalid draft policy');
  let files: ComposerFilesPolicy | undefined;
  if (Object.hasOwn(value, 'files')) {
    const row = value.files;
    if (!object(row) || !closed(row, ['max_file_bytes', 'max_files_per_record', 'max_total_bytes_per_record', 'allowed_media_types'])
      || !limit(row.max_file_bytes, 2_097_152) || !limit(row.max_files_per_record, 8) || !limit(row.max_total_bytes_per_record, 8_388_608)
      || row.max_file_bytes > row.max_total_bytes_per_record || !Array.isArray(row.allowed_media_types)
      || !row.allowed_media_types.length || row.allowed_media_types.length > 8
      || row.allowed_media_types.some(type => !mediaTypes.includes(type)) || new Set(row.allowed_media_types).size !== row.allowed_media_types.length) throw Error('Invalid file policy');
    files = { max_file_bytes: row.max_file_bytes, max_files_per_record: row.max_files_per_record,
      max_total_bytes_per_record: row.max_total_bytes_per_record, allowed_media_types: [...row.allowed_media_types] };
  }
  return { draft_state_key: value.draft_state_key, ...(files ? { files } : {}),
    ...(Object.hasOwn(value, 'max_payload_bytes') ? { max_payload_bytes: Number(value.max_payload_bytes) } : {}) };
}

function parseFileRows(value: unknown, policy: ComposerFilesPolicy | undefined, now: number): readonly ComposerPrivateFile[] {
  if (!Array.isArray(value) || value.length > (policy?.max_files_per_record ?? 0)) throw Error('Invalid files');
  const ids = new Set<string>(), operations = new Set<string>(); let total = 0;
  return value.map(raw => {
    if (!object(raw) || !closed(raw, ['file_id', 'upload_operation_id', 'filename', 'media_type', 'byte_length', 'digest', 'expires_at'])
      || !uuid(raw.file_id) || !uuid(raw.upload_operation_id) || ids.has(raw.file_id) || operations.has(raw.upload_operation_id)
      || !validComposerFileName(raw.filename) || typeof raw.media_type !== 'string' || !policy?.allowed_media_types.includes(raw.media_type)
      || !limit(raw.byte_length, policy.max_file_bytes) || !digest(raw.digest) || !expiry(raw.expires_at, now)) throw Error('Invalid file');
    total += raw.byte_length; if (total > policy.max_total_bytes_per_record) throw Error('File quota exceeded');
    ids.add(raw.file_id); operations.add(raw.upload_operation_id);
    return { file_id: raw.file_id, upload_operation_id: raw.upload_operation_id, filename: raw.filename,
      media_type: raw.media_type, byte_length: raw.byte_length, digest: raw.digest, expires_at: raw.expires_at };
  });
}

export function parseComposerPrivateFiles(value: unknown, draftId: string, policy: ComposerFilesPolicy, now = Date.now()): ComposerPrivateFiles {
  if (!object(value) || !closed(value, ['schema_version', 'draft', 'files']) || value.schema_version !== 'deft.private_files.v1'
    || !object(value.draft) || !closed(value.draft, ['record_id', 'revision']) || value.draft.record_id !== draftId
    || !uuid(value.draft.record_id) || !limit(value.draft.revision, 2147483646)) throw Error('Invalid saved files');
  return { schema_version: 'deft.private_files.v1', draft: { record_id: draftId, revision: value.draft.revision }, files: parseFileRows(value.files, policy, now) };
}

export function sameComposerFileCatalog(a: readonly ComposerPrivateFile[], b: readonly ComposerPrivateFile[]): boolean {
  return canonicalCapabilityJson(a) === canonicalCapabilityJson(b);
}
export function composerInputFingerprint(input: ComposerInput): string { return canonicalCapabilityJson(input); }
export async function composerInputDigest(input: ComposerInput): Promise<string> {
  const bytes = new TextEncoder().encode(composerInputFingerprint(input));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function composerFileDigest(file: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function composerFileSelectionError(file: Pick<File, 'name' | 'size' | 'type'>, saved: readonly ComposerPrivateFile[], policy: ComposerFilesPolicy): string | null {
  if (!validComposerFileName(file.name) || !limit(file.size, policy.max_file_bytes) || !policy.allowed_media_types.includes(file.type)) return 'Choose a supported file within the reviewed size limit.';
  if (saved.length >= policy.max_files_per_record || saved.reduce((bytes, row) => bytes + row.byte_length, file.size) > policy.max_total_bytes_per_record) return 'Remove a file before adding another.';
  return null;
}

export function privateFilesForControls(files: readonly ComposerPrivateFile[], draft: Readonly<{ draftId: string; revision: number; resourceTargetKey: string }>): readonly ComposeFile[] {
  return files.map(row => ({ key: row.file_id, filename: row.filename, byteCount: row.byte_length, status: 'ready' as const,
    handle: row.file_id, draft, mediaType: row.media_type, digest: row.digest, expiresAt: row.expires_at }));
}

export function parseComposerSnapshot(value: unknown, draft: ComposerDraftRef, input: ComposerInput, inputDigest: string,
  files: readonly ComposerPrivateFile[], policy: ComposerFilesPolicy | undefined, now = Date.now()): ComposerSnapshot {
  if (!object(value) || !closed(value, ['schema_version', 'snapshot_ref', 'draft_ref', 'input_digest', 'expires_at', 'preview'])
    || value.schema_version !== 'deft.experience_human_action_snapshot.v1' || !object(value.snapshot_ref)
    || !closed(value.snapshot_ref, ['snapshot_id', 'digest']) || !uuid(value.snapshot_ref.snapshot_id) || !digest(value.snapshot_ref.digest)
    || !object(value.draft_ref) || !closed(value.draft_ref, ['draft_state_key', 'draft_id', 'expected_revision'])
    || canonicalCapabilityJson(value.draft_ref) !== canonicalCapabilityJson(draft) || value.input_digest !== inputDigest
    || !/^sha256:[a-f0-9]{64}$/u.test(inputDigest) || !expiry(value.expires_at, now) || !object(value.preview)
    || !closed(value.preview, ['items', 'files']) || !Array.isArray(value.preview.items) || value.preview.items.length > 32
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) throw Error('Invalid saved preview');
  const keys = new Set<string>();
  const items = value.preview.items.map(raw => {
    if (!object(raw) || !closed(raw, ['key', 'label', 'value']) || !key(raw.key) || keys.has(raw.key)
      || !text(raw.label, 200) || typeof raw.value !== 'string' || raw.value.length > 16_384) throw Error('Invalid preview item');
    keys.add(raw.key); return { key: raw.key, label: raw.label, value: raw.value };
  });
  const ready = parseFileRows(value.preview.files, policy, now);
  if (!sameComposerFileCatalog(ready, files)) throw Error('Files changed');
  return { snapshot_ref: { snapshot_id: value.snapshot_ref.snapshot_id, digest: value.snapshot_ref.digest },
    draft_ref: { ...draft }, input_digest: inputDigest, expires_at: value.expires_at, inputFingerprint: composerInputFingerprint(input),
    preview: { items, files: ready } };
}

export function composerSnapshotCurrent(snapshot: ComposerSnapshot | null, draft: ComposerDraftRef, input: ComposerInput,
  files: readonly ComposerPrivateFile[], now = Date.now()): boolean {
  return Boolean(snapshot && expiry(snapshot.expires_at, now) && snapshot.inputFingerprint === composerInputFingerprint(input)
    && canonicalCapabilityJson(snapshot.draft_ref) === canonicalCapabilityJson(draft) && sameComposerFileCatalog(snapshot.preview.files, files)
    && files.every(row => expiry(row.expires_at, now)));
}
