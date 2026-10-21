/** Bounded named-principal syntax for trusted controls. URI admission belongs
 * to the independent URI safety gate; provider payloads use app-owned parsers. */
import {canonicalSafeUri} from './safe-uri.js';
export type StructuredAddress = Readonly<{ address: string; displayName: string }>;
export type StructuredAddressOptions = Readonly<{ maxItems?: number; allowEmpty?: boolean; scheme?: 'opaque' | 'mailto' }>;
export class StructuredAddressError extends Error {
  readonly code: 'ADDRESS_LIST_INVALID' | 'ADDRESS_LIST_LIMIT';
  constructor(code: 'ADDRESS_LIST_INVALID' | 'ADDRESS_LIST_LIMIT') {
    super(code === 'ADDRESS_LIST_LIMIT' ? 'Address list exceeds its limit' : 'Invalid address list');
    this.name = 'StructuredAddressError'; this.code = code;
  }
}
const invalid = (): never => { throw new StructuredAddressError('ADDRESS_LIST_INVALID'); };
const limited = (): never => { throw new StructuredAddressError('ADDRESS_LIST_LIMIT'); };
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
function normalizeAddress(address: string, displayName: string, options: StructuredAddressOptions): StructuredAddress {
  if (controls.test(address) || controls.test(displayName) || !wellFormed(displayName)) invalid();
  address = address.trim(); displayName = displayName.trim().normalize('NFC');
  if (!address || address.length > 200 || !wellFormed(address) || /[<>,;"\\]/u.test(address)) invalid();
  if (options.scheme !== undefined && options.scheme !== 'opaque' && options.scheme !== 'mailto') invalid();
  // The retained scalar field profile defaults to a mailto URI target. Opaque
  // principals use the same label/list grammar without adopting URI semantics.
  if (options.scheme !== 'opaque') {
    try { address = decodeURIComponent(canonicalSafeUri('mailto:' + encodeURIComponent(address).replaceAll('%40','@')).slice(7)); }
    catch { invalid(); }
  }
  if (displayName.length > 128 || controls.test(displayName) || /[<>]/u.test(displayName) || !wellFormed(displayName)) invalid();
  return { address, displayName };
}
function addressToken(token: string, options: StructuredAddressOptions): StructuredAddress {
  const value = token.trim(), bracket = value.indexOf('<');
  if (bracket < 0) return normalizeAddress(value, '', options);
  if (!value.endsWith('>') || value.indexOf('<', bracket + 1) >= 0 || value.indexOf('>') !== value.length - 1) invalid();
  let name = value.slice(0, bracket).trim();
  if (name.startsWith('"') || name.endsWith('"')) {
    if (!/^"(?:[^"\\]|\\["\\])*"$/u.test(name)) invalid();
    name = name.slice(1, -1).replace(/\\(["\\])/gu, '$1');
  } else if (name.includes('"')) invalid();
  return normalizeAddress(value.slice(bracket + 1, -1), name, options);
}

/** Does not deduplicate or change the caller's scalar. Empty optional fields
 * are admitted explicitly; maxItems counts every supplied address. */
function parseProfile(value: string, options: StructuredAddressOptions, native: boolean): readonly StructuredAddress[] {
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
  return tokens.map(token => addressToken(token, options));
}
export function parseAddressList(value: string, options: StructuredAddressOptions = {}): readonly StructuredAddress[] {
  return parseProfile(value, options, false);
}
/** Explicit native profile; legacy admission stays at 32 / 2048 characters. */
export function parseExtendedAddressList(value: string, options: StructuredAddressOptions = {}): readonly StructuredAddress[] {
  return parseProfile(value, options, true);
}

/** Canonical text only after an explicit UI edit/commit. Display names are
 * safely quoted; roundtrip preserves names, recipient order and duplicates. */
function formatProfile(addresses: readonly StructuredAddress[], native: boolean, options: StructuredAddressOptions): string {
  if (!Array.isArray(addresses) || addresses.length > (native ? 200 : 32)) limited();
  const result = addresses.map(value => {
    if (!value || typeof value.address !== 'string' || typeof value.displayName !== 'string') invalid();
    const address = normalizeAddress(value.address, value.displayName, options);
    const name = /[,;"\\]/u.test(address.displayName)
      ? `"${address.displayName.replace(/["\\]/gu, '\\$&')}"` : address.displayName;
    return name ? `${name} <${address.address}>` : address.address;
  }).join(', ');
  if (native && new TextEncoder().encode(result).length > 16384) limited();
  return result;
}
export function formatAddressList(addresses: readonly StructuredAddress[], options: StructuredAddressOptions = {}): string {
  return formatProfile(addresses, false, options);
}
export function formatExtendedAddressList(addresses: readonly StructuredAddress[], options: StructuredAddressOptions = {}): string {
  return formatProfile(addresses, true, options);
}
