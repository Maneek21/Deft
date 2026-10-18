/** A bounded mailbox list, not arbitrary RFC headers. Shared unchanged by
 * Runtime validation, native controls and provider payload construction. */
export type MailboxAddress = Readonly<{ address: string; displayName: string }>;
export type MailboxListOptions = Readonly<{ maxItems?: number; allowEmpty?: boolean }>;
export class MailboxListError extends Error {
  readonly code: 'MAILBOX_LIST_INVALID' | 'MAILBOX_LIST_LIMIT';
  constructor(code: 'MAILBOX_LIST_INVALID' | 'MAILBOX_LIST_LIMIT') {
    super(code === 'MAILBOX_LIST_LIMIT' ? 'Mailbox list exceeds its limit' : 'Invalid mailbox list');
    this.name = 'MailboxListError'; this.code = code;
  }
}
const invalid = (): never => { throw new MailboxListError('MAILBOX_LIST_INVALID'); };
const limited = (): never => { throw new MailboxListError('MAILBOX_LIST_LIMIT'); };
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function normalizeMailbox(address: string, displayName: string): MailboxAddress {
  if (controls.test(address) || controls.test(displayName) || !wellFormed(displayName)) invalid();
  address = address.trim(); displayName = displayName.trim().normalize('NFC');
  const at = address.lastIndexOf('@');
  if (address.length > 200 || at < 1 || at > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(address)) invalid();
  const local = address.slice(0, at), domain = address.slice(at + 1).toLowerCase();
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.')
    || domain.split('.').some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) invalid();
  if (displayName.length > 128 || controls.test(displayName) || /[<>]/u.test(displayName) || !wellFormed(displayName)) invalid();
  return { address: `${local}@${domain}`, displayName };
}
function mailboxToken(token: string): MailboxAddress {
  const value = token.trim(), bracket = value.indexOf('<');
  if (bracket < 0) return normalizeMailbox(value, '');
  if (!value.endsWith('>') || value.indexOf('<', bracket + 1) >= 0 || value.indexOf('>') !== value.length - 1) invalid();
  let name = value.slice(0, bracket).trim();
  if (name.startsWith('"') || name.endsWith('"')) {
    if (!/^"(?:[^"\\]|\\["\\])*"$/u.test(name)) invalid();
    name = name.slice(1, -1).replace(/\\(["\\])/gu, '$1');
  } else if (name.includes('"')) invalid();
  return normalizeMailbox(value.slice(bracket + 1, -1), name);
}

/** Does not deduplicate or change the caller's scalar. Empty optional fields
 * are admitted explicitly; maxItems counts every supplied mailbox. */
function parseProfile(value: string, options: MailboxListOptions, native: boolean): readonly MailboxAddress[] {
  const ceiling = native ? 200 : 32, maxItems = options.maxItems ?? ceiling;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > ceiling) limited();
  if (typeof value !== 'string' || !wellFormed(value)) invalid();
  if (native ? new TextEncoder().encode(value).length > 16384 : value.length > 2048) limited();
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) invalid();
  if (!value.trim()) { if (options.allowEmpty) return []; invalid(); }
  const tokens: string[] = []; let token = '', quoted = false, bracket = false, escaped = false;
  for (const char of value) {
    if (escaped) { token += char; escaped = false; continue; }
    if (quoted && char === '\\') { token += char; escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') { if (bracket) invalid(); bracket = true; }
    if (!quoted && char === '>') { if (!bracket) invalid(); bracket = false; }
    if (!quoted && !bracket && /[,;]/u.test(char)) { if (token.trim()) tokens.push(token); token = ''; }
    else token += char;
    if (tokens.length > maxItems) limited();
  }
  if (quoted || bracket || escaped) invalid();
  if (token.trim()) tokens.push(token);
  if (!tokens.length) invalid();
  if (tokens.length > maxItems) limited();
  return tokens.map(mailboxToken);
}
export function parseMailboxList(value: string, options: MailboxListOptions = {}): readonly MailboxAddress[] {
  return parseProfile(value, options, false);
}
/** Explicit native profile; legacy admission stays at 32 / 2048 characters. */
export function parseNativeMailboxList(value: string, options: MailboxListOptions = {}): readonly MailboxAddress[] {
  return parseProfile(value, options, true);
}

/** Canonical text only after an explicit UI edit/commit. Display names are
 * safely quoted; roundtrip preserves names, recipient order and duplicates. */
function formatProfile(addresses: readonly MailboxAddress[], native: boolean): string {
  if (!Array.isArray(addresses) || addresses.length > (native ? 200 : 32)) limited();
  const result = addresses.map(value => {
    if (!value || typeof value.address !== 'string' || typeof value.displayName !== 'string') invalid();
    const mailbox = normalizeMailbox(value.address, value.displayName);
    const name = /[,;"\\]/u.test(mailbox.displayName)
      ? `"${mailbox.displayName.replace(/["\\]/gu, '\\$&')}"` : mailbox.displayName;
    return name ? `${name} <${mailbox.address}>` : mailbox.address;
  }).join(', ');
  if (native && new TextEncoder().encode(result).length > 16384) limited();
  return result;
}
export function formatMailboxList(addresses: readonly MailboxAddress[]): string {
  return formatProfile(addresses, false);
}
export function formatNativeMailboxList(addresses: readonly MailboxAddress[]): string {
  return formatProfile(addresses, true);
}
