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
import { constants as osConstants } from 'node:os';
import { isRouteWord, webBundlePath } from './web-paths.js';

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

// Quote characters. An apostrophe inside a word ("can't") is not one.
const QUOTE_CHAR = /["`“”«»]|['‘’](?!\p{L})|(?<!\p{L})['‘’]/gu;

/**
 * Quoted text, which in error messages is nearly always customer text
 * (Postgres, Zod, fs, JSON.parse). On each line everything from the first
 * quote character to the last becomes one placeholder, so quotes nested in a
 * value (`"my "secret" plan"`) or escaped in JSON hide nothing; a single
 * quote hides the rest of its line.
 */
function removeQuoted(text: string): string {
  return text.split('\n').map((line) => {
    const positions = [...line.matchAll(QUOTE_CHAR)].map((match) => match.index!);
    if (positions.length === 0) return line;
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    return first === last ? `${line.slice(0, first)}<quoted>` : `${line.slice(0, first)}<quoted>${line.slice(last + 1)}`;
  }).join('\n');
}
// Anything with a scheme: keep the scheme; the host becomes a placeholder (a
// hosted workspace's address can carry its name); drop path, query, fragment.
const URL_WITH_SCHEME = /\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s<>]*/gi;
// Addresses in any script ("josé@acme.com", "bob@münchen.de").
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// An address part with no dot in its domain ("bob@acme").
const AT_HANDLE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+/gu;
// An authorization value after its scheme name.
const AUTH_VALUE = /\b(Bearer|Basic|Digest)\s+\S+/gi;
// Seven or more digits split by spaces, dots or dashes: card and phone numbers.
const DIGIT_GROUPS = /\d(?:[ .-]?\d){6,}/g;
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

function cleanValues(values: Iterable<string>): string[] {
  return [...new Set([...values]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length >= 3 && value.length <= 200))];
}

/**
 * `values`: whole names ("Priya Raman", "Acme Robotics"), matched as words and
 * found inside tokens. `wordsOnly`: their parts ("Priya", "Raman"), matched
 * as whole words only, so a short first name does not blank code identifiers.
 */
export function knownValuesPattern(values: Iterable<string>, wordsOnly: Iterable<string> = []): KnownValues | null {
  const whole = cleanValues(values);
  // Longest first, so "Acme Robotics" wins over "Acme".
  const words = [...new Set([...whole, ...cleanValues(wordsOnly)])].sort((a, b) => b.length - a.length).slice(0, 80_000);
  if (words.length === 0) return null;
  const compact = [...new Set(whole.map(compactForm).filter((value) => value.length >= 4))].slice(0, 40_000);
  return {
    words: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu'),
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
  text = removeQuoted(text.replace(URL_WITH_SCHEME, (_match, scheme: string) => `${scheme.toLowerCase()}://${P.host}`))
    .replace(EMAIL, P.email)
    .replace(AT_HANDLE, P.email)
    .replace(AUTH_VALUE, (_match, scheme: string) => `${scheme} ${P.secret}`)
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
    .replace(DIGIT_GROUPS, P.number)
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

/** The classes a browser report may name (JavaScript, DOMException, a failed chunk load); any other becomes "Error". */
const BROWSER_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'ChunkLoadError',
  'AbortError', 'TimeoutError', 'NetworkError', 'NotAllowedError', 'NotFoundError', 'NotSupportedError',
  'NotReadableError', 'QuotaExceededError', 'SecurityError', 'InvalidStateError', 'InvalidAccessError',
  'DataCloneError', 'OperationError', 'UnknownError', 'UnhandledRejection', 'ApiRequestFailed',
]);

/**
 * Messages a JavaScript engine, Node or a browser writes, each with the fixed
 * text that is sent in its place. Nothing of the original message is ever
 * sent: a variable part (a quoted value, an expression, a value V8 prints
 * unquoted such as `'id' in bluechair`) is always a placeholder, and only
 * "undefined"/"null" or a status code is carried over. A message that
 * matches none of these was written by the app, a provider or a caller, and
 * never leaves the cell.
 */
const ANY = String.raw`[^\n]{1,300}`;
const NULLISH = '(undefined|null)';
type RuntimeForm = [source: string, text: (m: RegExpExecArray) => string];
const RUNTIME_MESSAGES: ReadonlyArray<{ match: RegExp; text: (m: RegExpExecArray) => string }> = ([
  [`Cannot read properties of ${NULLISH} \\(reading ${ANY}\\)`, (m) => `Cannot read properties of ${m[1]} (reading <quoted>)`],
  [`Cannot set properties of ${NULLISH} \\(setting ${ANY}\\)`, (m) => `Cannot set properties of ${m[1]} (setting <quoted>)`],
  [`Cannot destructure ${ANY} as it is ${NULLISH}\\.?`, (m) => `Cannot destructure <quoted> as it is ${m[1]}.`],
  [`${ANY} is not a function`, () => '<expr> is not a function'],
  [`${ANY} is not a constructor`, () => '<expr> is not a constructor'],
  [`${ANY} is not iterable`, () => '<expr> is not iterable'],
  [`${ANY} is not defined`, () => '<expr> is not defined'],
  [`${NULLISH} is not an object \\(evaluating ${ANY}\\)`, (m) => `${m[1]} is not an object (evaluating <expr>)`],
  [`can't access property ${ANY}, ${ANY} is ${NULLISH}`, (m) => `can't access property <quoted>, <expr> is ${m[1]}`],
  [`[\\w$.]{1,120} is ${NULLISH}`, (m) => `<expr> is ${m[1]}`],
  [`Cannot access ${ANY} before initialization`, () => 'Cannot access <quoted> before initialization'],
  ['Cannot convert (undefined or null|undefined|null) to object', (m) => `Cannot convert ${m[1]} to object`],
  [`Cannot use 'in' operator to search for ${ANY}`, () => "Cannot use 'in' operator to search for <quoted> in <expr>"],
  ['Assignment to constant variable\\.', () => 'Assignment to constant variable.'],
  ['Maximum call stack size exceeded\\.?', () => 'Maximum call stack size exceeded'],
  ['too much recursion', () => 'Maximum call stack size exceeded'],
  ['Invalid (array length|time value|Date|string length|URL|character)', (m) => `Invalid ${m[1]}`],
  [`Invalid code point ${ANY}`, () => 'Invalid code point'],
  [`Unexpected (?:token|identifier|number|string)${ANY}`, () => 'Unexpected token in JSON'],
  ['Unexpected end of JSON input', () => 'Unexpected end of JSON input'],
  [`Unexpected non-whitespace character after JSON${ANY}`, () => 'Unexpected non-whitespace character after JSON'],
  [`${ANY} is not valid JSON`, () => 'Unexpected token in JSON'],
  [`Converting circular structure to JSON${String.raw`[^\n]{0,300}`}`, () => 'Converting circular structure to JSON'],
  ['Do not know how to serialize a BigInt', () => 'Do not know how to serialize a BigInt'],
  ['(Failed to fetch|Load failed|fetch failed|Network request failed)', (m) => m[1]!],
  ['NetworkError when attempting to fetch resource\\.', () => 'NetworkError when attempting to fetch resource.'],
  ['(?:The operation was aborted\\.?|This operation was aborted|The user aborted a request\\.?|signal is aborted without reason)', () => 'The operation was aborted'],
  ['The operation timed out\\.?', () => 'The operation timed out'],
  [`Loading (?:CSS )?chunk ${ANY} failed${String.raw`[^\n]{0,300}`}`, () => 'Loading chunk failed'],
  [`ResizeObserver loop${ANY}`, () => 'ResizeObserver loop'],
  ['Request failed with status code ([1-5]\\d{2})', (m) => `Request failed with status code ${m[1]}`],
] satisfies RuntimeForm[]).map(([source, text]: RuntimeForm) => ({ match: new RegExp(`^${source}$`), text }));

/** The fixed text for a runtime-written message, or null when no runtime wrote it. */
export function runtimeMessageText(line: string): string | null {
  if (line.length > 400) return null;
  for (const form of RUNTIME_MESSAGES) {
    const match = form.match.exec(line);
    if (match) return form.text(match);
  }
  return null;
}

export function browserErrorClass(raw: unknown): string {
  return typeof raw === 'string' && BROWSER_CLASSES.has(raw) ? raw : 'Error';
}

/** The operating system's error names ("ECONNREFUSED", "ENOENT"), from Node itself. */
const ERRNO_NAMES: ReadonlySet<string> = new Set(Object.keys(osConstants.errno));
const DNS_CODES: ReadonlySet<string> = new Set([
  'EAI_ADDRFAMILY', 'EAI_AGAIN', 'EAI_BADFLAGS', 'EAI_BADHINTS', 'EAI_CANCELED', 'EAI_FAIL', 'EAI_FAMILY', 'EAI_MEMORY',
  'EAI_NODATA', 'EAI_NONAME', 'EAI_OVERFLOW', 'EAI_PROTOCOL', 'EAI_SERVICE', 'EAI_SOCKTYPE', 'ENOTFOUND', 'ETIMEOUT',
  'ECONNREFUSED', 'ESERVFAIL', 'EREFUSED', 'ENODATA', 'EBADRESP',
]);

/** PostgreSQL's SQLSTATE classes (Appendix A of its manual): a code's first two characters. */
const SQLSTATE_CLASSES: ReadonlySet<string> = new Set([
  '00', '01', '02', '03', '08', '09', '0A', '0B', '0F', '0L', '0P', '0Z', '20', '21', '22', '23', '24', '25', '26', '27',
  '28', '2B', '2D', '2F', '34', '38', '39', '3B', '3D', '3F', '40', '42', '44', '53', '54', '55', '57', '58', '72', 'F0',
  'HV', 'P0', 'XX',
]);

/**
 * A real error code, or null: an operating-system or DNS error name, a
 * Node.js internal code ("ERR_STREAM_PREMATURE_CLOSE"), an undici code
 * ("UND_ERR_CONNECT_TIMEOUT"), or a Postgres SQLSTATE ("23505", "42P01",
 * "XX000": one of Postgres's classes, then three characters with a digit
 * somewhere in the code). A code that holds one of the workspace's names is
 * not sent either ("ERR_ORCHID_EXPORT" in a workspace called Orchid).
 * Anything else an error's `code` holds is not sent.
 */
export function systemErrorCode(raw: unknown, known: KnownValues | null = null): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  if (containsKnownValue(raw, known)) return null;
  if (ERRNO_NAMES.has(raw) || DNS_CODES.has(raw)) return raw;
  if (/^ERR_[A-Z0-9]+(?:_[A-Z0-9]+){1,10}$/.test(raw) || /^UND_ERR_[A-Z]+(?:_[A-Z]+){0,6}$/.test(raw)) return raw;
  if (/^[0-9A-Z]{5}$/.test(raw) && SQLSTATE_CLASSES.has(raw.slice(0, 2)) && /\d/.test(raw)) return raw;
  return null;
}

/** The first line of a message, cut before a database driver's parameters. */
export function firstLine(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  const cut = text.search(/\bparams:|\bparameters:|\bdetail:/i);
  return (cut >= 0 ? text.slice(0, cut) : text).split('\n', 1)[0] ?? '';
}

/**
 * The message an event may carry. Free text the app or a provider wrote can
 * hold anything a person typed ("Could not save note: move the blue chair"),
 * and no pattern can tell it from code, so it never leaves the cell. Only
 * the fixed text for a known runtime form, or else a real error code, or
 * nothing. No part of the original message is ever sent.
 */
export function eventMessage(input: { message: unknown; code?: unknown }, known: KnownValues | null = null): string {
  const line = firstLine(input.message).replace(/^Uncaught (?:\(in promise\) )?(?:[A-Za-z]*Error: )?/, '').trim();
  const text = line ? runtimeMessageText(line) : null;
  if (text) return text;
  const code = systemErrorCode(input.code, known);
  return code ? `code ${code}` : '';
}

/** On the way out, with the newest names: a code message that now holds a name is dropped. */
export function recheckEventMessage(message: string, known: KnownValues | null): string {
  return message.startsWith('code ') && containsKnownValue(message.slice(5), known) ? '' : message;
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

/**
 * Where a stack comes from. The server's own stacks: frames under `appRoot`.
 * A browser's: frames of the web app's own bundles, served from one of
 * `webOrigins`; their function names are dropped (the browser is not
 * trusted, and production bundles are minified anyway).
 */
export type StackSource = { appRoot: string; webOrigins?: undefined } | { appRoot?: undefined; webOrigins: readonly string[] };

/**
 * A frame's file: a code file relative to the app root, a `node:` module, or
 * one of the web app's own bundles (its path only, never host or query).
 * Anything else is dropped: a frame never names a directory outside the app,
 * a file that is not code, or another site's script.
 */
export function scrubFramePath(raw: string, source: StackSource): string | null {
  let file = raw.trim();
  if (!file) return null;
  if (source.webOrigins) {
    // A browser frame: one of the web app's own bundles, from its own address.
    let parsed: URL;
    try { parsed = new URL(file); } catch { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!source.webOrigins.includes(parsed.origin)) return null;
    return webBundlePath(parsed.pathname);
  }
  if (/^node:[A-Za-z0-9_/.:-]+$/.test(file)) return file.slice(0, FILE_MAX);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    let parsed: URL;
    try { parsed = new URL(file); } catch { return null; }
    if (parsed.protocol !== 'file:') return null;
    try { file = decodeURIComponent(parsed.pathname); } catch { return null; }
    if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
  }
  file = file.replace(/\\/g, '/');
  const root = source.appRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  file = file.slice(root.length + 1);
  if (!CODE_FILE.test(file) || !/^[A-Za-z0-9_./@+-]+$/.test(file) || file.includes('..')) return null;
  return file.slice(0, FILE_MAX);
}

// V8: "    at fn (file:line:col)" or "    at file:line:col".
const V8_FRAME = /^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// Firefox and Safari: "fn@file:line:col".
const GECKO_FRAME = /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/;

/** Parse a stack trace into file, line and function only (no locals, no text). */
export function parseStack(stack: unknown, source: StackSource, known: KnownValues | null = null): TelemetryFrame[] {
  if (typeof stack !== 'string') return [];
  const frames: TelemetryFrame[] = [];
  for (const line of stack.slice(0, 16_000).split('\n')) {
    const match = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
    if (!match) continue;
    const [, fnRaw, fileRaw, lineRaw] = match;
    const file = scrubFramePath(fileRaw ?? '', source);
    // Frame files are code paths from a fixed character set or the bundle list:
    // never checked against names (a member called "apps" must not blank them).
    if (!file) continue;
    // V8 "at async fn (...)" and "at new Foo (...)".
    const fnName = (fnRaw ?? '').replace(/^(?:async|new) /, '');
    const lineNumber = Number.parseInt(lineRaw ?? '', 10);
    frames.push({
      file,
      line: Number.isFinite(lineNumber) && lineNumber >= 0 ? Math.min(lineNumber, 10_000_000) : 0,
      fn: source.webOrigins ? '<anonymous>' : scrubFunctionName(fnName, known),
    });
    // A browser's stack is untrusted and bulky: eight frames are enough.
    if (frames.length >= (source.webOrigins ? 8 : FRAMES_MAX)) break;
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

/**
 * The error references this cell has issued (X-Deft-Error-Reference) in the
 * last hour, at most 2,000. A request ID leaves the cell only if it is one of
 * them, so no other UUID (a workspace's, a person's) can pass as one.
 */
const ISSUED_TTL_MS = 60 * 60 * 1000;
const ISSUED_MAX = 2_000;
const issued = new Map<string, number>();

export function rememberIssuedReference(reference: string, now = Date.now()): void {
  if (!isUuid(reference)) return;
  issued.delete(reference.toLowerCase());
  issued.set(reference.toLowerCase(), now + ISSUED_TTL_MS);
  while (issued.size > ISSUED_MAX) issued.delete(issued.keys().next().value!);
}

export function forgetIssuedReferencesForTest(): void {
  issued.clear();
}

/** Request IDs: references this cell issued within the hour, at most ten. */
export function scrubRequestIds(raw: unknown, now = Date.now()): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const value of raw) {
    if (!isUuid(value)) continue;
    const id = value.toLowerCase();
    const expires = issued.get(id);
    if (expires !== undefined && expires > now && !ids.includes(id)) ids.push(id);
    if (ids.length >= REQUEST_IDS_MAX) break;
  }
  return ids;
}

/**
 * A route template from the code ("/api/spaces/:id"). A fixed segment stays
 * only if the API's registered routes or the web app's page folders have it
 * (web-paths.ts); anything else becomes a parameter, so a raw path can never
 * pass as a template, whoever calls this.
 */
export function scrubRouteTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').slice(1).map((segment) => {
    if (segment === '' || segment === '*') return segment;
    if (/^:[A-Za-z_][A-Za-z0-9_]*(?:\{[^}]*\})?\??$/.test(segment)) return segment.replace(/\{[^}]*\}/, '').replace(/\?$/, '');
    if (isRouteWord(segment)) return segment;
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

/**
 * The release, as sent: a plain version on one of Deft's own release
 * channels ("0.3.0-preview.152", "1.0.0", "1.1.0-rc.2") or "unknown".
 * DEFT_RELEASE_VERSION is an operator setting; a label put there for a
 * customer ("0.3.0-exampleco.1") never leaves the cell.
 */
export function releaseLabel(raw: unknown): string {
  return typeof raw === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-(?:preview|alpha|beta|rc)\.\d{1,6})?$/.test(raw) ? raw : 'unknown';
}
