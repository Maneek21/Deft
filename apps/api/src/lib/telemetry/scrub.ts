/**
 * Telemetry scrubbing (telemetry contract, section 1).
 *
 * Everything an error event carries out of the cell passes through here
 * first. The rule is operational data only: what broke, where in the code,
 * which release. Never message text, file names, email addresses, names,
 * workspace names, keys, tokens, setup or invite links, request bodies,
 * headers, cookies or query strings. The control plane re-validates with a
 * strict allowlist; this is the first and main line.
 *
 * Pure: no database, no network, no clock.
 */
import { createHash } from 'node:crypto';

export const MESSAGE_MAX = 300;
export const ERROR_CLASS_MAX = 100;
export const FN_MAX = 80;
export const FILE_MAX = 200;
export const FRAMES_MAX = 20;
export const REQUEST_IDS_MAX = 10;

export type TelemetryFrame = { file: string; line: number; fn: string };

/** Placeholders: plain words in angle brackets, so a placeholder never looks like data. */
const P = {
  quoted: '<quoted>',
  email: '<email>',
  jwt: '<jwt>',
  key: '<key>',
  secret: '<redacted>',
  number: '<n>',
  host: '<host>',
  ip: '<ip>',
  file: '<file>',
  name: '<name>',
  param: '<param>',
} as const;

// Quoted text: '…', "…", `…`, and typographic quotes. Customer text in error
// messages is nearly always quoted (Postgres, Zod, fs, JSON.parse, TypeError).
const QUOTED = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»/g;
// A quote with no partner runs to the end of the line: drop the rest.
const UNPAIRED_QUOTE = /["'`“”‘’«»][^\n]*/g;
// Anything with a scheme: keep the scheme; the host becomes a placeholder (a
// hosted workspace's address can carry its name); drop path, query, fragment.
const URL_WITH_SCHEME = /\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s<>]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// An address part with no dot in its domain ("bob@acme").
const AT_HANDLE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
// Well-known key and token shapes, caught even when shorter than 16 characters.
const KEY_PREFIXES = /\b(?:sk-ant|sk-proj|sk|pk|rk|xox[abposr]|ghp|gho|ghu|ghs|ghr|github_pat|glpat|whsec|ya29)[-_.][A-Za-z0-9_-]{6,}|\b(?:AKIA|ASIA)[A-Z0-9]{12,}|\bAIza[A-Za-z0-9_-]{20,}/g;
// Credential-bearing parameters left over without a scheme (acme.example/signup#setup=…).
const SECRET_PARAM = /([#?&;]|\b)(setup|token|code|key|secret|password|passwd|pwd|invite|auth|access_token|refresh_token|sig|signature)=[^\s&#;]*/gi;
const HEX_RUN = /[0-9a-fA-F]{16,}/g;
const BASE64_RUN = /[A-Za-z0-9+/=_-]{16,}/g;
const DIGIT_RUN = /\d{6,}/g;
// A bare host name: dot-separated labels ending in a common top-level domain
// ("mail.acme.com"), so code such as "JSON.parse" or "x.map" is left alone.
const TLDS = [
  'com', 'net', 'org', 'io', 'ai', 'dev', 'app', 'co', 'in', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'se', 'no', 'fi', 'dk',
  'ch', 'at', 'be', 'pl', 'cz', 'pt', 'ie', 'ru', 'cn', 'jp', 'kr', 'au', 'nz', 'ca', 'us', 'eu', 'me', 'tv', 'cc', 'xyz',
  'ing', 'cloud', 'tech', 'site', 'online', 'info', 'biz', 'edu', 'gov', 'mil', 'int', 'test', 'invalid', 'local',
  'localhost', 'internal', 'lan', 'home', 'example', 'so', 'sh', 'gg', 'ly', 'to', 'fm', 'is', 'id', 'sg', 'hk', 'tw',
  'br', 'mx', 'ar', 'za', 'ae', 'sa', 'il', 'tr', 'ua', 'ro', 'hu', 'gr', 'bg', 'si', 'hr', 'lt', 'lv', 'ee',
].join('|');
const HOSTNAME = new RegExp(`\\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+(?:${TLDS})\\b`, 'gi');
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b/g;
// File names by extension.
const FILE_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'tif', 'tiff', 'ico',
  'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv', 'flac', 'aac',
  'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'eml', 'msg', 'ics', 'vcf', 'json', 'xml', 'html', 'htm', 'key', 'pem',
  'pages', 'numbers', 'sql', 'log', 'yaml', 'yml',
].join('|');
const FILE_NAME = new RegExp(`[^\\s<>()\\[\\]{},;:]+\\.(?:${FILE_EXTENSIONS})\\b`, 'gi');
// Characters that never belong in a one-line message.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Known values to remove wherever they appear: the workspace's own name and
 * slug, and the names of its people.
 *
 * - `words`: each value as whole words, ignoring case ("Acme Robotics").
 * - `compact`: each value with everything but letters and digits removed
 *   ("acmerobotics"), found inside any token however it was written
 *   ("AcmeRobotics", "acme_robotics.upload"). Only values of 4 or more
 *   letters and digits, so a short name cannot blank common words.
 */
export type KnownValues = { words: RegExp; compact: RegExp | null };

function compactForm(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

export function knownValuesPattern(values: Iterable<string>): KnownValues | null {
  const cleaned = [...new Set([...values]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length >= 3 && value.length <= 200))]
    // Longest first, so "Acme Robotics" wins over "Acme".
    .sort((a, b) => b.length - a.length)
    .slice(0, 5000);
  if (cleaned.length === 0) return null;
  const compact = [...new Set(cleaned.map(compactForm).filter((value) => value.length >= 4))];
  return {
    words: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${cleaned.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu'),
    compact: compact.length > 0 ? new RegExp(compact.map(escapeRegExp).join('|'), 'u') : null,
  };
}

/** True when `text`, squeezed to letters and digits, contains a known value. */
export function containsKnownValue(text: string, known: KnownValues | null): boolean {
  return Boolean(known?.compact && known.compact.test(compactForm(text)));
}

/**
 * Scrub one free-text message. Order matters: whole structures (URLs, quoted
 * text, emails, tokens) go before the coarser run rules break them up.
 */
export function scrubMessage(raw: unknown, known: KnownValues | null = null): string {
  let text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
  // Bound the work before any regular expression runs.
  text = text.slice(0, 8_000).replace(CONTROL, ' ');
  text = text
    .replace(URL_WITH_SCHEME, (_match, scheme: string) => `${scheme.toLowerCase()}://${P.host}`)
    .replace(QUOTED, P.quoted)
    .replace(UNPAIRED_QUOTE, P.quoted)
    .replace(EMAIL, P.email)
    .replace(AT_HANDLE, P.email)
    .replace(JWT, P.jwt)
    .replace(KEY_PREFIXES, P.key)
    .replace(SECRET_PARAM, (_match, lead: string) => `${lead}${P.param}`)
    .replace(FILE_NAME, P.file)
    .replace(HOSTNAME, P.host)
    // A link without a scheme keeps no path either ("<host>/signup#...").
    .replace(/<host>[/#?][^\s<>]*/g, P.host)
    .replace(IPV4, P.ip)
    .replace(IPV6, P.ip)
    .replace(HEX_RUN, P.secret)
    .replace(BASE64_RUN, P.secret)
    .replace(DIGIT_RUN, P.number);
  if (known) {
    // Names last, once the rules above have taken out whole structures.
    text = text.replace(known.words, P.name);
    if (known.compact) text = text.replace(/[^\s<>]+/g, (token) => (containsKnownValue(token, known) ? P.name : token));
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, MESSAGE_MAX);
}

/**
 * An error's class name: a code identifier, never free text. A name that the
 * message rules would change in any way is data, and becomes "Error".
 */
export function scrubErrorClass(raw: unknown, known: KnownValues | null = null): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > ERROR_CLASS_MAX) return 'Error';
  return isCodeIdentifier(text, known) ? text : 'Error';
}

/**
 * A code identifier or dotted path ("SessionRefreshUnavailableError",
 * "Hono.fetch", "Object.<anonymous>"): no spaces, "@", "/", "-" or ":", so no
 * address, link, key or path fits. Still refused when it holds a known
 * name, a JWT, a long hex or digit run, or a long segment mixing letters and
 * digits (a token).
 */
function isCodeIdentifier(text: string, known: KnownValues | null): boolean {
  if (!/^[A-Za-z_$<][A-Za-z0-9_$<>]*(?:\.[A-Za-z_$<][A-Za-z0-9_$<>]*)*$/.test(text)) return false;
  if (containsKnownValue(text, known) || /[0-9a-fA-F]{16,}|\d{6,}|^eyJ/.test(text)) return false;
  return !text.split('.').some((segment) => segment.length >= 24 && /\d/.test(segment) && /[A-Za-z]/.test(segment));
}

/** A function name from a stack frame: a code identifier as it is, anything else under the message rules. */
export function scrubFunctionName(raw: string, known: KnownValues | null = null): string {
  if (containsKnownValue(raw, known)) return P.name;
  if (raw.length <= FN_MAX && isCodeIdentifier(raw, known)) return raw;
  const scrubbed = scrubMessage(raw, known);
  const name = scrubbed.replace(/[^A-Za-z0-9_$.<>[\] ]/g, '').replace(/\s+/g, ' ').trim().slice(0, FN_MAX);
  return name || '<anonymous>';
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// The web app's own bundles, by path on the web app: folders, then one file
// name with no dot but its ".js".
const WEB_BUNDLE = /^_next\/static\/(?:[A-Za-z0-9_()[\]@-]+\/)*[A-Za-z0-9_-]+\.js$/;

/**
 * A frame's file: a code file relative to the app root, a `node:` module, or
 * one of the web app's own bundles (its path only, never host or query).
 * Anything else is dropped: a frame never names a directory outside the app
 * or a file that is not code.
 */
export function scrubFramePath(raw: string, appRoot: string | null): string | null {
  let file = raw.trim();
  if (!file) return null;
  if (/^node:[A-Za-z0-9_/.:-]+$/.test(file)) return file.slice(0, FILE_MAX);
  let web = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    let parsed: URL;
    try { parsed = new URL(file); } catch { return null; }
    if (parsed.protocol === 'file:') {
      try { file = decodeURIComponent(parsed.pathname); } catch { return null; }
      if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
    } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      file = parsed.pathname.replace(/^\/+/, '');
      web = true;
    } else {
      // Extensions, blob: and data: frames are not the app's code.
      return null;
    }
  }
  file = file.replace(/\\/g, '/');
  if (!web) {
    if (!appRoot) return null;
    const root = appRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
    file = file.slice(root.length + 1);
    if (!CODE_FILE.test(file) || !/^[A-Za-z0-9_./@+-]+$/.test(file) || file.includes('..')) return null;
  } else if (!WEB_BUNDLE.test(file) || file.includes('..')) {
    return null;
  }
  // Content hashes vary per build; one placeholder keeps fingerprints stable.
  file = file.replace(/[0-9a-fA-F]{16,}/g, '<hash>');
  return file.slice(0, FILE_MAX);
}

// V8: "    at fn (file:line:col)" or "    at file:line:col".
const V8_FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// Firefox and Safari: "fn@file:line:col".
const GECKO_FRAME = /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/;

/** Parse a stack trace into file, line and function only (no locals, no text). */
export function parseStack(stack: unknown, appRoot: string | null, known: KnownValues | null = null): TelemetryFrame[] {
  if (typeof stack !== 'string') return [];
  const frames: TelemetryFrame[] = [];
  for (const line of stack.slice(0, 16_000).split('\n')) {
    const match = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
    if (!match) continue;
    const [, fnRaw, fileRaw, lineRaw] = match;
    const file = scrubFramePath(fileRaw ?? '', appRoot);
    if (!file || containsKnownValue(file, known)) continue;
    // V8 "at async fn (...)" and "at new Foo (...)".
    const fnName = (fnRaw ?? '').replace(/^(?:async|new) /, '');
    const lineNumber = Number.parseInt(lineRaw ?? '', 10);
    frames.push({
      file,
      line: Number.isFinite(lineNumber) && lineNumber >= 0 ? Math.min(lineNumber, 10_000_000) : 0,
      fn: scrubFunctionName(fnName, known),
    });
    if (frames.length >= FRAMES_MAX) break;
  }
  return frames;
}

/** True for a frame in the app's own code (not a dependency, not the runtime). */
export function isInAppFrame(frame: TelemetryFrame): boolean {
  return !frame.file.startsWith('node:')
    && !frame.file.includes('node_modules/')
    && !/^_next\/static\/chunks\/(?:framework|main|webpack|polyfills)/.test(frame.file);
}

/**
 * sha256 hex of kind + error_class + top in-app frame (file:function). With
 * no in-app frame (a 5xx response rather than an exception), the route
 * template stands in for the frame.
 */
export function fingerprint(kind: string, errorClass: string, frames: TelemetryFrame[], fallback: string | null): string {
  const top = frames.find(isInAppFrame);
  const where = top ? `${top.file}:${top.fn}` : `route:${fallback ?? ''}`;
  return createHash('sha256').update(`${kind}\n${errorClass}\n${where}`).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Request IDs are the cell's own error references: UUIDs only, at most ten. */
export function scrubRequestIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const value of raw) {
    if (isUuid(value) && !ids.includes(value.toLowerCase())) ids.push(value.toLowerCase());
    if (ids.length >= REQUEST_IDS_MAX) break;
  }
  return ids;
}

/**
 * A route template from the code ("/api/spaces/:id"). Code-defined static
 * segments stay; anything that does not look like one becomes a parameter,
 * so a raw path can never pass as a template.
 */
export function scrubRouteTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').slice(1).map((segment) => {
    if (segment === '' || segment === '*') return segment;
    if (/^:[A-Za-z_][A-Za-z0-9_]*(?:\{[^}]*\})?\??$/.test(segment)) return segment.replace(/\{[^}]*\}/, '').replace(/\?$/, '');
    if (/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/.test(segment) && segment.length <= 40 && !/\d{3,}/.test(segment)) return segment;
    return ':param';
  });
  return `/${segments.join('/')}`.slice(0, 200);
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export type TelemetryMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function scrubMethod(raw: unknown): TelemetryMethod | null {
  const method = typeof raw === 'string' ? raw.toUpperCase() : '';
  return HTTP_METHODS.has(method) ? method as TelemetryMethod : null;
}

export function scrubStatus(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
}

/** "Chrome 131", "Firefox 132", "Safari 18", "Edge 131" or "Other". Never the raw User-Agent. */
export function browserFamily(userAgent: string | undefined | null): string {
  const ua = (userAgent ?? '').slice(0, 512);
  const pick = (pattern: RegExp, family: string): string | null => {
    const match = pattern.exec(ua);
    return match ? `${family} ${match[1]}` : null;
  };
  return pick(/\bEdg(?:e|A|iOS)?\/(\d{1,4})\./, 'Edge')
    ?? pick(/\bOPR\/(\d{1,4})\./, 'Opera')
    ?? pick(/\bSamsungBrowser\/(\d{1,4})\./, 'Samsung Internet')
    ?? pick(/\bFxiOS\/(\d{1,4})\./, 'Firefox')
    ?? pick(/\bFirefox\/(\d{1,4})\./, 'Firefox')
    ?? pick(/\bCriOS\/(\d{1,4})\./, 'Chrome')
    ?? pick(/\bChrome\/(\d{1,4})\./, 'Chrome')
    ?? (/\bSafari\//.test(ua) ? pick(/\bVersion\/(\d{1,4})\./, 'Safari') : null)
    ?? 'Other';
}
