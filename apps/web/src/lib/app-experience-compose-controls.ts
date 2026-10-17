/** Trusted-host UI values. These types grant no authority: the host must validate
 * current identity, consent, draft CAS and file custody again before confirming. */
export type ComposeAddress = Readonly<{ address: string; displayName: string }>;
export type ComposeDraftReference = Readonly<{ draftId: string; revision: number; resourceTargetKey: string }>;
export type ComposeIdentityOption = Readonly<{ key: string; label: string; address: ComposeAddress }>;
export type ComposeAddressList = Readonly<{ key: string; label: string; values: readonly ComposeAddress[] }>;
export type ComposePlainContent = Readonly<{ format: 'plain'; text: string }>;
export type ComposeFile = Readonly<{ key: string; filename: string; byteCount: number }> & (
  | Readonly<{ status: 'pending' | 'uploading' | 'failed'; notice?: string }>
  | Readonly<{ status: 'ready'; handle: string; draft: ComposeDraftReference; mediaType: string; digest: string; expiresAt: string }>
);
export type ComposeFilePolicy = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number; allowedMediaTypes: readonly string[] }>;
export type ComposeRevisionStatus = 'current' | 'saving' | 'conflict' | 'unavailable';
export type ComposeAddressEdit = ComposeAddressList & Readonly<{ pendingText: string }>;
export type ComposeDraftContent = Readonly<{
  draft: ComposeDraftReference; identityKey: string; addressLists: readonly ComposeAddressList[];
  content: ComposePlainContent; fileHandles: readonly string[];
}>;
export type ComposeControlErrorCode = 'COMPOSE_ADDRESS_INVALID' | 'COMPOSE_ADDRESS_LIMIT' | 'COMPOSE_IDENTITY_UNAVAILABLE'
  | 'COMPOSE_CONTENT_INVALID' | 'COMPOSE_CONTENT_LIMIT' | 'COMPOSE_FILE_UNAVAILABLE' | 'COMPOSE_FILE_LIMIT' | 'COMPOSE_DRAFT_CONFLICT';
export type ComposeControlError = Readonly<{ code: ComposeControlErrorCode; error: string }>;
type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false } & ComposeControlError>;
const fail = (code: ComposeControlErrorCode, error: string): Readonly<{ ok: false } & ComposeControlError> => ({ ok: false, code, error });
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const clean = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !controls.test(value);
const validLimit = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;

/** A bounded mailbox form, rather than RFC header text. Header folding, groups,
 * comments, quoted local parts and provider locators are deliberately not inputs. */
function normalizeAddress(value: ComposeAddress): ComposeAddress | null {
  if (!value || typeof value.address !== 'string' || typeof value.displayName !== 'string') return null;
  const address = value.address.trim(), at = address.lastIndexOf('@');
  if (!clean(address, 200) || at < 1 || at > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(address)) return null;
  const local = address.slice(0, at), domain = address.slice(at + 1).toLowerCase();
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.')
    || domain.split('.').some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) return null;
  const displayName = value.displayName.trim().normalize('NFC');
  if (!clean(displayName, 128, true) || /[<>]/u.test(displayName)) return null;
  return { address: `${local}@${domain}`, displayName };
}

export function composeAddressLabel(value: ComposeAddress): string {
  return value.displayName ? `${value.displayName} <${value.address}>` : value.address;
}

function addressToken(token: string): ComposeAddress | null {
  const value = token.trim();
  const bracket = value.indexOf('<');
  if (bracket < 0) return normalizeAddress({ address: value, displayName: '' });
  if (!value.endsWith('>') || value.indexOf('<', bracket + 1) >= 0 || value.indexOf('>') !== value.length - 1) return null;
  let displayName = value.slice(0, bracket).trim();
  if (displayName.startsWith('"') || displayName.endsWith('"')) {
    if (!/^"[^"\\]*"$/u.test(displayName)) return null;
    displayName = displayName.slice(1, -1);
  } else if (displayName.includes('"')) return null;
  return normalizeAddress({ address: value.slice(bracket + 1, -1), displayName });
}

/** All-or-nothing parsing keeps an invalid pasted recipient visible and prevents
 * a partially accepted list from being mistaken for the intended send list. */
export function parseComposeAddresses(text: string, existing: readonly ComposeAddress[] = [], maxItems = 200): Result<Readonly<{ addresses: readonly ComposeAddress[]; duplicates: number }>> {
  if (!validLimit(maxItems, 200) || typeof text !== 'string' || text.length > 65_536 || !Array.isArray(existing) || existing.length > maxItems) {
    return fail('COMPOSE_ADDRESS_LIMIT', 'This recipient list exceeds its limit.');
  }
  const tokens: string[] = []; let token = '', quoted = false, bracket = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') { if (bracket) return fail('COMPOSE_ADDRESS_INVALID', 'Enter valid email addresses.'); bracket = true; }
    if (!quoted && char === '>') { if (!bracket) return fail('COMPOSE_ADDRESS_INVALID', 'Enter valid email addresses.'); bracket = false; }
    if (!quoted && !bracket && /[,;\r\n]/u.test(char)) { if (token.trim()) tokens.push(token); token = ''; }
    else token += char;
  }
  if (quoted || bracket) return fail('COMPOSE_ADDRESS_INVALID', 'Finish the recipient name and address.');
  if (token.trim()) tokens.push(token);
  const addresses: ComposeAddress[] = [], seen = new Set<string>(); let duplicates = 0;
  for (const value of [...existing, ...tokens.map(addressToken)]) {
    const normalized = value && normalizeAddress(value);
    if (!normalized) return fail('COMPOSE_ADDRESS_INVALID', 'Enter valid email addresses. Your input is kept for correction.');
    const key = normalized.address.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); addresses.push(normalized);
    if (addresses.length > maxItems) return fail('COMPOSE_ADDRESS_LIMIT', `Use at most ${maxItems} recipients.`);
  }
  return { ok: true, value: { addresses, duplicates } };
}

/** Order belongs to the reviewed contract (for example To, Cc, Bcc). The first
 * appearance wins, matching the frozen outgoing envelope's deduplication rule. */
export function normalizeComposeAddressLists(lists: readonly ComposeAddressList[], maxItems = 200): Result<readonly ComposeAddressList[]> {
  if (!Array.isArray(lists) || lists.length > 8 || !validLimit(maxItems, 200)) return fail('COMPOSE_ADDRESS_LIMIT', 'This recipient list exceeds its limit.');
  const seen = new Set<string>(), keys = new Set<string>(); let count = 0;
  const normalized: ComposeAddressList[] = [];
  for (const list of lists) {
    if (!list || !clean(list.key, 80) || !clean(list.label, 80) || keys.has(list.key)) return fail('COMPOSE_ADDRESS_INVALID', 'Recipient fields are unavailable.');
    keys.add(list.key);
    const result = parseComposeAddresses('', list.values, maxItems);
    if (!result.ok) return result;
    const values = result.value.addresses.filter(value => {
      const key = value.address.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true;
    });
    count += values.length;
    if (count > maxItems) return fail('COMPOSE_ADDRESS_LIMIT', `Use at most ${maxItems} recipients across all fields.`);
    normalized.push({ key: list.key, label: list.label, values });
  }
  return { ok: true, value: normalized };
}

/** Options come only from the authenticated host's current verified identities.
 * Free text and an address supplied by an App cannot select a sender. */
export function selectedComposeIdentity(options: readonly ComposeIdentityOption[], key: string): Result<ComposeIdentityOption> {
  if (!Array.isArray(options) || options.length < 1 || options.length > 32 || typeof key !== 'string') return fail('COMPOSE_IDENTITY_UNAVAILABLE', 'The selected identity is unavailable.');
  const keys = new Set<string>(); let selected: ComposeIdentityOption | undefined;
  for (const option of options) {
    const address = option && normalizeAddress(option.address);
    if (!option || !clean(option.key, 256) || !clean(option.label, 128) || !address || keys.has(option.key)) return fail('COMPOSE_IDENTITY_UNAVAILABLE', 'Verified identities need to be refreshed.');
    keys.add(option.key);
    if (option.key === key) selected = { ...option, address };
  }
  return selected ? { ok: true, value: selected } : fail('COMPOSE_IDENTITY_UNAVAILABLE', 'The selected identity is unavailable.');
}

export function validateComposePlainContent(content: ComposePlainContent, maxBytes: number, maxCharacters?: number): ComposeControlError | null {
  if (!content || content.format !== 'plain' || typeof content.text !== 'string' || !validLimit(maxBytes, 1_048_576)
    || (maxCharacters !== undefined && !validLimit(maxCharacters, 262_144))
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content.text) || !content.text.isWellFormed()) {
    return { code: 'COMPOSE_CONTENT_INVALID', error: 'Use plain text without unsupported control characters.' };
  }
  if (maxCharacters !== undefined && content.text.length > maxCharacters) {
    return { code: 'COMPOSE_CONTENT_LIMIT', error: `The content exceeds its ${maxCharacters.toLocaleString()} character limit.` };
  }
  return new TextEncoder().encode(content.text).byteLength > maxBytes
    ? { code: 'COMPOSE_CONTENT_LIMIT', error: `The content exceeds its ${maxBytes.toLocaleString()} byte limit.` } : null;
}

function validDraft(draft: ComposeDraftReference): boolean {
  return Boolean(draft) && typeof draft.draftId === 'string' && clean(draft.draftId, 256)
    && typeof draft.resourceTargetKey === 'string' && clean(draft.resourceTargetKey, 256)
    && Number.isSafeInteger(draft.revision) && draft.revision >= 1;
}
export function composeDraftRevisionStatus(editing: ComposeDraftReference, current: ComposeDraftReference | null): 'current' | 'conflict' | 'unavailable' {
  if (!validDraft(editing) || !current || !validDraft(current)) return 'unavailable';
  return editing.draftId === current.draftId && editing.resourceTargetKey === current.resourceTargetKey && editing.revision === current.revision ? 'current' : 'conflict';
}

/** A ready row is metadata from the host, not a URL or a client-generated file
 * ID. The host must resolve the opaque handle and recheck exact bytes itself. */
export function validateComposeFiles(files: readonly ComposeFile[], draft: ComposeDraftReference, policy: ComposeFilePolicy, now: number): ComposeControlError | null {
  if (!validDraft(draft) || !Number.isFinite(now) || !policy || !validLimit(policy.maxFiles, 16) || !validLimit(policy.maxFileBytes, 8_388_608)
    || !validLimit(policy.maxTotalBytes, 16_777_216) || !Array.isArray(policy.allowedMediaTypes) || policy.allowedMediaTypes.length < 1
    || policy.allowedMediaTypes.length > 32 || policy.allowedMediaTypes.some(type => typeof type !== 'string' || !/^[-\w.+]+\/[-\w.+]+$/u.test(type))) {
    return { code: 'COMPOSE_FILE_UNAVAILABLE', error: 'File attachment settings are unavailable.' };
  }
  if (!Array.isArray(files) || files.length > policy.maxFiles) return { code: 'COMPOSE_FILE_LIMIT', error: `Use at most ${policy.maxFiles} files.` };
  const keys = new Set<string>(), handles = new Set<string>(); let total = 0;
  for (const file of files) {
    if (!file || file.status !== 'ready') return { code: 'COMPOSE_FILE_UNAVAILABLE', error: 'Wait until every selected file is ready, or remove it.' };
    if (!clean(file.key, 256) || !clean(file.filename, 200) || /[\\/]/u.test(file.filename) || keys.has(file.key)
      || !clean(file.handle, 512) || /[\s:/\\]/u.test(file.handle) || handles.has(file.handle) || !policy.allowedMediaTypes.includes(file.mediaType)
      || !/^[a-f0-9]{64}$/u.test(file.digest) || !Number.isSafeInteger(file.byteCount) || file.byteCount < 0) {
      return { code: 'COMPOSE_FILE_UNAVAILABLE', error: 'A file needs to be selected again.' };
    }
    if (composeDraftRevisionStatus(draft, file.draft) !== 'current') return { code: 'COMPOSE_DRAFT_CONFLICT', error: 'Files belong to a different draft version. Refresh the saved draft.' };
    const expiry = Date.parse(file.expiresAt);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== file.expiresAt || expiry <= now) return { code: 'COMPOSE_FILE_UNAVAILABLE', error: 'A file expired. Select it again.' };
    keys.add(file.key); handles.add(file.handle); total += file.byteCount;
    if (file.byteCount > policy.maxFileBytes || total > policy.maxTotalBytes) return { code: 'COMPOSE_FILE_LIMIT', error: 'The selected files exceed the attachment limit.' };
  }
  return null;
}

export function composeByteLabel(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Size unavailable';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** A bounded typed save proposal, never a confirmed snapshot. Host request Zod
 * validation and CAS remain authoritative. Addresses have no routing semantics:
 * their keys and ordering come from the reviewed App/host control contract. */
export function prepareComposeDraftContent(value: Readonly<{
  draft: ComposeDraftReference; revisionStatus: ComposeRevisionStatus;
  identityOptions: readonly ComposeIdentityOption[]; identityKey: string;
  addressLists: readonly ComposeAddressEdit[]; content: ComposePlainContent; files: readonly ComposeFile[];
}>, policy: Readonly<{ maxRecipients: number; maxContentBytes: number; maxContentCharacters?: number; files?: ComposeFilePolicy }>, now: number): Result<ComposeDraftContent> {
  if (!validDraft(value.draft) || value.revisionStatus !== 'current') return fail('COMPOSE_DRAFT_CONFLICT', 'Verify the current saved draft before continuing.');
  const identity = selectedComposeIdentity(value.identityOptions, value.identityKey);
  if (!identity.ok) return identity;
  if (!Array.isArray(value.addressLists) || value.addressLists.length > 8) return fail('COMPOSE_ADDRESS_LIMIT', 'Recipient fields exceed their limit.');
  const lists: ComposeAddressList[] = [];
  for (const list of value.addressLists) {
    const parsed = parseComposeAddresses(list.pendingText, list.values, policy.maxRecipients);
    if (!parsed.ok) return parsed;
    lists.push({ key: list.key, label: list.label, values: parsed.value.addresses });
  }
  const recipients = normalizeComposeAddressLists(lists, policy.maxRecipients);
  if (!recipients.ok) return recipients;
  const contentError = validateComposePlainContent(value.content, policy.maxContentBytes, policy.maxContentCharacters);
  if (contentError) return { ok: false, ...contentError };
  if (!Array.isArray(value.files)) return fail('COMPOSE_FILE_UNAVAILABLE', 'Files are unavailable.');
  if (policy.files) {
    const fileError = validateComposeFiles(value.files, value.draft, policy.files, now);
    if (fileError) return { ok: false, ...fileError };
  } else if (value.files.length) return fail('COMPOSE_FILE_UNAVAILABLE', 'Files are unavailable for this draft.');
  return { ok: true, value: {
    draft: { ...value.draft }, identityKey: identity.value.key, addressLists: recipients.value,
    content: { format: 'plain', text: value.content.text }, fileHandles: value.files.map(file => file.status === 'ready' ? file.handle : ''),
  } };
}
