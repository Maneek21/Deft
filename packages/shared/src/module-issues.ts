/**
 * Turns validator output for an uploaded app file (a module manifest or an
 * App package) into at most three plain lines that name where the problem is,
 * for example "Candidates → fields: at most 64 fields (you have 500)".
 *
 * The input is hostile: names, keys and messages can carry markup, control or
 * bidi characters, or be very long. Every piece of text that reaches a line is
 * cleaned and bounded, raw JSON never reaches a line, and the walk over the
 * input is bounded so deep or wide files cannot slow it down.
 */

export const READABLE_ISSUE_LINE_LIMIT = 3;
export const READABLE_ISSUE_DETAIL_LIMIT = 20;

const MAX_ISSUES_SCANNED = 200;
const MAX_UNION_DEPTH = 6;
const MAX_PATH_SEGMENTS = 12;
const MAX_LABEL_CHARS = 40;
const MAX_LINE_CHARS = 240;

export type ReadableIssue = {
  path: Array<string | number>;
  message: string;
};

export type ReadableIssueReport = {
  /** One message: the lines joined with a newline. */
  message: string;
  /** At most READABLE_ISSUE_LINE_LIMIT plain lines. */
  lines: string[];
  /** Every readable issue found, capped at READABLE_ISSUE_DETAIL_LIMIT. */
  issues: ReadableIssue[];
};

export type ReadableIssueOptions = {
  /** The parsed JSON value that was validated, used to name paths. */
  input?: unknown;
  /** The raw JSON text, used to find the line of a JSON syntax error. */
  source?: string;
  /** What the file is, for root-level problems. Default "App file". */
  subject?: string;
  /** Text put before every path, such as the name of a module inside an App. */
  prefix?: string;
  /** The message when nothing readable can be said. */
  fallback?: string;
  /**
   * Whether the top level may carry a "$schema" link, as an app file may.
   * Default true; an App package has none, so there it is an unknown key.
   */
  schemaKeyAllowed?: boolean;
};

type RawIssue = {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  errors?: unknown;
  issues?: unknown;
  keys?: unknown;
  values?: unknown;
  expected?: unknown;
  origin?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  format?: unknown;
  divisor?: unknown;
  options?: unknown;
};

type FlatIssue = { issue: RawIssue; path: Array<string | number> };

// Keep in step with the "$schema" rule in ./modules: a text URL of at most this many characters.
const SCHEMA_KEY_MAX_CHARS = 2048;
const SCHEMA_KEY_ISSUE = 'deft_schema_key';

// C0/C1 controls, zero-width characters, bidi controls, BOM and line/paragraph separators.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  // Controls, then Unicode's default-ignorable code points (they render as
  // nothing), plus line and paragraph separators.
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x034f, 0x034f],
  [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];

function isUnsafeChar(char: string): boolean {
  const point = char.codePointAt(0) ?? 0;
  return UNSAFE_RANGES.some(([low, high]) => point >= low && point <= high);
}

function replaceUnsafeChars(value: string): string {
  let out = '';
  for (const char of value) out += isUnsafeChar(char) ? " " : char;
  return out;
}

const MARKUP_CHARS = /[<>`]/g;
// Labels also lose quotes and brackets, so a hostile name cannot make a line look like JSON.
const LABEL_UNSAFE_CHARS = /[<>`"{}[\]]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}

/** Plain, single-line, bounded text. */
export function cleanIssueText(value: string, max = MAX_LINE_CHARS): string {
  return truncate(
    replaceUnsafeChars(value.slice(0, max * 4)).replace(/\s+/g, ' ').trim(),
    max,
  );
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = cleanIssueText(value.replace(LABEL_UNSAFE_CHARS, ''), MAX_LABEL_CHARS);
  return cleaned.length > 0 ? cleaned : null;
}

/** A name or title from a person, safe to quote in a line: plain, bounded, no quotes or brackets. */
export function cleanIssueLabel(value: unknown, max = MAX_LABEL_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = cleanIssueText(value.replace(LABEL_UNSAFE_CHARS, ''), max);
  return cleaned.length > 0 ? cleaned : null;
}

function looksLikeRawJson(value: string): boolean {
  return /\[\s*\{|\{\s*"|"\s*:\s*[[{"]/.test(value);
}

function quote(value: unknown): string {
  const label = cleanLabel(typeof value === 'string' ? value : String(value));
  return `"${label ?? '?'}"`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function singular(key: string): string {
  if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (key.endsWith('ses')) return key.slice(0, -2);
  if (/(ss|us|is)$/.test(key)) return key;
  if (key.endsWith('s')) return key.slice(0, -1);
  return key;
}

// What a person calls these keys: an app file declares record types.
const KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  collections: 'record types',
  collection_key: 'record type',
  target_collection: 'linked record type',
  default_collection: 'default record type',
});

function humanKey(key: string): string {
  return Object.prototype.hasOwnProperty.call(KEY_LABELS, key) ? KEY_LABELS[key]! : key.replaceAll('_', ' ');
}

function asPath(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) return [];
  const path: Array<string | number> = [];
  for (const segment of value.slice(0, MAX_PATH_SEGMENTS * 2)) {
    if (typeof segment === 'number' || typeof segment === 'string') path.push(segment);
    else path.push(String(segment));
  }
  return path;
}

function childAt(value: unknown, segment: string | number): unknown {
  if (Array.isArray(value)) return typeof segment === 'number' ? value[segment] : undefined;
  if (isRecord(value) && typeof segment === 'string' && Object.prototype.hasOwnProperty.call(value, segment)) {
    return value[segment];
  }
  return undefined;
}

function valueAt(input: unknown, path: Array<string | number>): unknown {
  let current = input;
  for (const segment of path.slice(0, MAX_PATH_SEGMENTS * 2)) {
    current = childAt(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

function elementName(element: unknown): string | null {
  if (!isRecord(element)) return null;
  for (const key of ['name', 'label', 'title', 'key', 'path', 'module_id', 'id', 'value']) {
    const label = cleanLabel(element[key]);
    if (label) return label;
  }
  return null;
}

/** "Candidates → fields → Email" for ['collections', 1, 'fields', 3]. */
export function describeIssuePath(path: Array<string | number>, input: unknown): string {
  const parts: string[] = [];
  let current = input;
  let parentKey: string | null = null;
  for (const segment of path.slice(0, MAX_PATH_SEGMENTS)) {
    const next = childAt(current, segment);
    if (typeof segment === 'number') {
      const name = elementName(next);
      const noun = parentKey ? singular(humanKey(parentKey)) : 'item';
      // The element's own name replaces the list name: "Candidates", not "collections → Candidates".
      if (parts.length > 0 && parentKey !== null && parts[parts.length - 1] === humanKey(parentKey)) parts.pop();
      parts.push(name ?? `${noun} ${segment + 1}`);
      parentKey = null;
    } else {
      const label = cleanLabel(segment) ?? '?';
      parts.push(humanKey(label));
      parentKey = label;
    }
    current = next;
  }
  if (path.length > MAX_PATH_SEGMENTS) parts.push('…');
  return parts.join(' → ');
}

function typeName(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'boolean') return 'true or false';
  return `a ${typeof value}`;
}

function expectedName(expected: unknown): string {
  switch (expected) {
    case 'string': return 'text';
    case 'number': case 'int': return 'a number';
    case 'boolean': return 'true or false';
    case 'array': return 'a list';
    case 'object': case 'record': case 'map': return 'an object';
    case 'null': return 'null';
    default: return typeof expected === 'string' ? cleanIssueText(expected, 30) : 'a different value';
  }
}

function count(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  // UTF-16 units, as the validator counts them.
  if (typeof value === 'string') return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return null;
}

const KNOWN_MESSAGES: Array<[RegExp, string]> = [
  [/strict semantic versioning/i, 'must be a version like 1.0.0'],
  [/reverse-DNS identifier/i, 'must be a lowercase dotted id like com.example.hiring'],
  [/lowercase kebab-case/i, 'must use lowercase letters, digits and hyphens, like hiring-pipeline'],
  [/lowercase snake_case/i, 'must use lowercase letters, digits and underscores, like first_name'],
  [/single-line plain text/i, 'must be plain text on one line, without markup or hidden characters'],
  [/plain text/i, 'must be plain text on one line, without markup or hidden characters'],
  [/is reserved by Deft/i, 'is a name Deft reserves; choose another'],
];

function isGeneratedMessage(message: string): boolean {
  return /^(Invalid|Too (big|small)|Unrecognized key|Expected|Required)\b/.test(message);
}

/** Readable text for a validator's own (custom) message, or null to use the code. */
function customMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const message = cleanIssueText(raw);
  if (!message || isGeneratedMessage(message) || looksLikeRawJson(message) || /\/\^|\\[dwsb]/.test(message)) return null;
  for (const [pattern, replacement] of KNOWN_MESSAGES) if (pattern.test(message)) return replacement;
  if (/^[A-Z][A-Za-z ]{0,40}? is required$/.test(message)) return "can't be empty";
  // "Display name must be …" → "must be …": the path already names the thing.
  const subjectless = message.match(/^[A-Z][A-Za-z ]{0,40}? ((?:must|cannot|can't|is not|is|are|should|needs?) .+)$/);
  return (subjectless ? subjectless[1]! : message).replace(/[.]$/, '');
}

function issueMessage(issue: RawIssue, path: Array<string | number>, input: unknown): string {
  const value = valueAt(input, path);
  const lastKey = [...path].reverse().find((segment): segment is string => typeof segment === 'string');
  const noun = lastKey ? humanKey(cleanLabel(lastKey) ?? 'items') : 'items';
  const code = typeof issue.code === 'string' ? issue.code : '';
  const maximum = typeof issue.maximum === 'number' || typeof issue.maximum === 'bigint' ? Number(issue.maximum) : null;
  const minimum = typeof issue.minimum === 'number' || typeof issue.minimum === 'bigint' ? Number(issue.minimum) : null;
  const have = count(value);

  switch (code) {
    case 'too_big': {
      if (issue.origin === 'array' || issue.origin === 'set') {
        return `at most ${maximum} ${maximum === 1 ? singular(noun) : noun}${have !== null ? ` (you have ${have})` : ''}`;
      }
      if (issue.origin === 'string') {
        return `at most ${maximum} ${plural(maximum ?? 0, 'character')}${have !== null ? ` (you have ${have})` : ''}`;
      }
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint') return `must be at most ${maximum}`;
      return customMessage(issue.message) ?? 'is too large';
    }
    case 'too_small': {
      if (issue.origin === 'array' || issue.origin === 'set') {
        if (minimum === 1) return `needs at least one ${singular(noun)}`;
        return `at least ${minimum} ${noun}${have !== null ? ` (you have ${have})` : ''}`;
      }
      if (issue.origin === 'string') {
        if (minimum === 1) return "can't be empty";
        return `at least ${minimum} ${plural(minimum ?? 0, 'character')}${have !== null ? ` (you have ${have})` : ''}`;
      }
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint') return `must be at least ${minimum}`;
      return customMessage(issue.message) ?? 'is too small';
    }
    case 'invalid_type':
      if (value === undefined) return 'is required';
      return `must be ${expectedName(issue.expected)} (found ${typeName(value)})`;
    case 'unrecognized_keys': {
      const keys = Array.isArray(issue.keys) ? issue.keys : [];
      const shown = keys.slice(0, 3).map(quote).join(', ');
      const more = keys.length > 3 ? ` and ${keys.length - 3} more` : '';
      return `unknown ${plural(keys.length, 'key')} ${shown}${more}: remove ${keys.length === 1 ? 'it' : 'them'}`;
    }
    case 'invalid_value': {
      const values = Array.isArray(issue.values) ? issue.values : [];
      if (values.length === 1) return `must be ${quote(values[0])}`;
      if (values.length > 1) {
        const shown = values.slice(0, 8).map(quote).join(', ');
        return `must be one of ${shown}${values.length > 8 ? ', …' : ''}`;
      }
      return customMessage(issue.message) ?? 'has a value that is not allowed';
    }
    case 'invalid_format': {
      const custom = customMessage(issue.message);
      if (custom) return custom;
      if (issue.format === 'email') return 'must be an email address';
      if (issue.format === 'url') return 'must be a web address';
      if (lastKey === 'version') return 'must be a version like 1.0.0';
      return 'has characters or a format that is not allowed';
    }
    case 'not_multiple_of':
      return typeof issue.divisor === 'number' ? `must be a multiple of ${issue.divisor}` : 'must be a whole step';
    case 'invalid_key':
      return 'has a key that is not allowed';
    case SCHEMA_KEY_ISSUE:
      return typeof value === 'string'
        ? `must be a text URL of at most ${SCHEMA_KEY_MAX_CHARS} characters (you have ${Array.from(value).length})`
        : `must be a text URL (found ${typeName(value)})`;
    case 'invalid_union': {
      const options = Array.isArray(issue.options) ? issue.options : [];
      if (options.length === 0) return 'does not match any allowed shape';
      if (value === undefined) return 'is required';
      const shown = options.slice(0, 14).map(quote).join(', ');
      return `must be one of ${shown}${options.length > 14 ? ', …' : ''}`;
    }
    default:
      return customMessage(issue.message) ?? 'is not valid';
  }
}

/**
 * The union branch that matches what the file says it is. A branch whose only
 * complaint is a different top-level literal (such as schema_version "2" for a
 * v1 file) is the wrong branch. When none fits, the first branch (v1) wins.
 */
function pickUnionBranch(branches: unknown[]): unknown[] {
  const candidates = branches.filter((branch): branch is unknown[] => Array.isArray(branch));
  if (candidates.length === 0) return [];
  const discriminatorMismatch = (branch: unknown[]) => branch.some((item) => {
    const issue = item as RawIssue;
    const path = asPath(issue.path);
    return issue.code === 'invalid_value' && path.length === 1;
  });
  return candidates.find((branch) => !discriminatorMismatch(branch)) ?? candidates[0]!;
}

function flattenIssues(issues: unknown[], base: Array<string | number>, depth: number, out: FlatIssue[]): void {
  for (const item of issues) {
    if (out.length >= MAX_ISSUES_SCANNED) return;
    if (!item || typeof item !== 'object') continue;
    const issue = item as RawIssue;
    const path = [...base, ...asPath(issue.path)];
    if (issue.code === 'invalid_union' && Array.isArray(issue.errors) && depth < MAX_UNION_DEPTH) {
      const branch = pickUnionBranch(issue.errors);
      if (branch.length > 0) {
        flattenIssues(branch, path, depth + 1, out);
        continue;
      }
    }
    if ((issue.code === 'invalid_element' || issue.code === 'invalid_key') && Array.isArray(issue.issues) && depth < MAX_UNION_DEPTH) {
      flattenIssues(issue.issues, path, depth + 1, out);
      continue;
    }
    out.push({ issue, path });
  }
}

function isSchemaLink(value: unknown): boolean {
  return typeof value === 'string' && Array.from(value).length <= SCHEMA_KEY_MAX_CHARS;
}

/**
 * The parser drops a top-level "$schema" text URL and leaves anything else in
 * place, so the validator calls it an unknown key. Say what it must be instead,
 * on its own line; any other unknown keys keep their line.
 */
function explainSchemaKey(flat: FlatIssue[], input: unknown): FlatIssue[] {
  if (!isRecord(input) || !Object.prototype.hasOwnProperty.call(input, '$schema') || isSchemaLink(input.$schema)) return flat;
  return flat.flatMap((item): FlatIssue[] => {
    const keys = item.issue.keys;
    if (item.issue.code !== 'unrecognized_keys' || item.path.length !== 0 || !Array.isArray(keys) || !keys.includes('$schema')) {
      return [item];
    }
    const rest = keys.filter((key) => key !== '$schema');
    return [
      { issue: { code: SCHEMA_KEY_ISSUE }, path: ['$schema'] },
      ...(rest.length > 0 ? [{ issue: { ...item.issue, keys: rest }, path: item.path }] : []),
    ];
  });
}

function errorIssues(error: unknown): unknown[] | null {
  if (!error || typeof error !== 'object') return null;
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues : null;
}

function jsonSyntaxLocation(error: unknown, source: string | undefined): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof SyntaxError || (current instanceof Error && /JSON/.test(current.message) && current.name === 'SyntaxError')) {
      const message = current.message;
      const lineColumn = message.match(/line (\d+) column (\d+)/i);
      if (lineColumn) return `line ${lineColumn[1]}, column ${lineColumn[2]}`;
      const position = message.match(/position (\d+)/i);
      if (position && typeof source === 'string') {
        const offset = Math.min(Number(position[1]), source.length);
        const before = source.slice(0, offset);
        const line = before.split('\n').length;
        const column = offset - before.lastIndexOf('\n');
        return `line ${line}, column ${column}`;
      }
      return null;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isJsonSyntaxError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof SyntaxError) return true;
    if (current instanceof Error && /is not valid JSON|must be valid UTF-8 JSON/.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function report(lines: string[], issues: ReadableIssue[]): ReadableIssueReport {
  return { message: lines.join('\n'), lines, issues };
}

/** Bound a list of readable lines to three, with a count of the rest. */
export function limitIssueLines(lines: string[]): string[] {
  const unique = [...new Set(lines)];
  if (unique.length <= READABLE_ISSUE_LINE_LIMIT) return unique;
  const shown = unique.slice(0, READABLE_ISSUE_LINE_LIMIT - 1);
  const rest = unique.length - shown.length;
  return [...shown, `…and ${rest} more ${plural(rest, 'problem')}. Fix these, then check again.`];
}

/** Readable lines for a list of validator issues (zod-shaped, from any zod copy). */
export function formatManifestIssues(issues: unknown[], options: ReadableIssueOptions = {}): ReadableIssueReport {
  let flat: FlatIssue[] = [];
  flattenIssues(issues, [], 0, flat);
  if (options.schemaKeyAllowed !== false) flat = explainSchemaKey(flat, options.input);
  const subject = cleanLabel(options.subject) ?? 'App file';
  const prefix = options.prefix ? cleanLabel(options.prefix) : null;
  const readable: ReadableIssue[] = [];
  const lines: string[] = [];
  for (const { issue, path } of flat) {
    const message = cleanIssueText(issueMessage(issue, path, options.input));
    const where = path.length === 0 ? subject : describeIssuePath(path, options.input);
    const located = prefix ? `${prefix} → ${where}` : where;
    let line = cleanIssueText(`${located}: ${message}`);
    if (looksLikeRawJson(line)) line = `${located}: is not valid`;
    lines.push(line);
    if (readable.length < READABLE_ISSUE_DETAIL_LIMIT) readable.push({ path: path.slice(0, MAX_PATH_SEGMENTS * 2), message: line });
  }
  if (lines.length === 0) {
    const fallback = cleanIssueText(options.fallback ?? `${subject} is not valid`);
    return report([prefix ? `${prefix}: ${fallback}` : fallback], []);
  }
  return report(limitIssueLines(lines), readable);
}

/**
 * Readable lines for anything a manifest or package parser throws: validator
 * issues, a JSON syntax error, a size error, or an unknown error.
 */
export function formatManifestError(error: unknown, options: ReadableIssueOptions = {}): ReadableIssueReport {
  const subject = cleanLabel(options.subject) ?? 'App file';
  const issues = errorIssues(error);
  if (issues) return formatManifestIssues(issues, options);

  const prefix = options.prefix ? cleanLabel(options.prefix) : null;
  const withPrefix = (line: string) => cleanIssueText(prefix ? `${prefix}: ${line}` : line);

  if (isJsonSyntaxError(error)) {
    const where = jsonSyntaxLocation(error, options.source);
    const line = where
      ? `The file isn't valid JSON near ${where}. Look for a missing or extra comma, quote or bracket.`
      : "The file isn't valid JSON. Look for a missing or extra comma, quote or bracket.";
    return report([withPrefix(line)], []);
  }

  const message = error instanceof Error ? cleanIssueText(error.message.replace(MARKUP_CHARS, '')) : '';
  if (message && !looksLikeRawJson(message) && !/\/\^|\\[dwsb]/.test(message)) return report([withPrefix(message)], []);
  return report([withPrefix(cleanIssueText(options.fallback ?? `${subject} is not valid`))], []);
}
