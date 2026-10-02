import { z } from 'zod';
import { ResourceOpaqueIdSchema, TaskResourceRefV1Schema } from './resources';
import { PersonResourceRefV2Schema, WikiPageResourceRefV2Schema } from './resources-v2';

export const NativeMentionRefSchema = z.union([
  PersonResourceRefV2Schema, TaskResourceRefV1Schema, WikiPageResourceRefV2Schema,
]);
export type NativeMentionRef = z.infer<typeof NativeMentionRefSchema>;
export const NativeMentionKindSchema = z.enum(['person', 'task', 'wiki_page']);
export type NativeMentionKind = z.infer<typeof NativeMentionKindSchema>;
export const NativeMentionSourceSchema = z.strictObject({
  kind: z.enum(['message', 'task', 'task_comment', 'wiki_page']),
  id: ResourceOpaqueIdSchema,
});
export type NativeMentionSource = z.infer<typeof NativeMentionSourceSchema>;
export const NATIVE_MENTION_LIMIT = 100;
export class NativeMentionLimitError extends Error {
  constructor() { super('Too many native references (maximum 100)'); }
}
export const NativeMentionRefsSchema = z.array(NativeMentionRefSchema).max(NATIVE_MENTION_LIMIT);

export function nativeMentionRef(kind: NativeMentionKind, id: string): NativeMentionRef {
  return NativeMentionRefSchema.parse({
    schema_version: kind === 'task' ? 'deft.resource_ref.v1' : 'deft.resource_ref.v2',
    provider: { kind: 'core', provider_instance_id:
      kind === 'person' ? 'people' : kind === 'task' ? 'tasks' : 'wiki_pages' },
    resource_type: kind, resource_id: id,
  });
}

export function nativeMentionKey(ref: NativeMentionRef): string {
  return `${ref.resource_type}:${ref.resource_id}`;
}

/** Markdown stores only identity; labels are live, authorized projections. */
export function nativeMentionToken(ref: NativeMentionRef): string {
  NativeMentionRefSchema.parse(ref);
  return `[[deft:${nativeMentionKey(ref)}]]`;
}

export function nativeMentionPlaceholder(kind: NativeMentionKind): string {
  return kind === 'person' ? '@Person' : kind === 'task' ? '@Task' : '@Wiki';
}

type ContentRange = { start: number; end: number };
type HtmlPart = ContentRange & { name: string; closing: boolean; comment: boolean; complete: boolean; bodyStart: number };
const NATIVE_TOKEN_PATTERN = /\[\[deft:(person|task|wiki_page):([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\]\]/g;
const LITERAL_TAGS = new Set(['pre', 'code', 'blockquote', 'script', 'style', 'textarea']);

function applyContentRanges(content: string, ranges: ContentRange[], mask: boolean): string {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    const start = Math.max(cursor, range.start);
    chunks.push(content.slice(cursor, start));
    if (mask) chunks.push(content.slice(start, range.end).replace(/[^\n]/g, ' '));
    cursor = range.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join('');
}

/** Consume each HTML tag once, respecting quotes and incomplete editor input. */
function* htmlParts(content: string): Generator<HtmlPart> {
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('<', cursor);
    if (start < 0) return;
    if (content.startsWith('<!--', start)) {
      const close = content.indexOf('-->', start + 4);
      const end = close < 0 ? content.length : close + 3;
      yield { start, end, name: '', closing: false, comment: true, complete: close >= 0, bodyStart: start + 4 };
      cursor = end; continue;
    }
    let i = start + 1;
    const closing = content[i] === '/';
    if (closing) i++;
    const declaration = content[i] === '!' || content[i] === '?';
    if (!declaration && !/[A-Za-z]/.test(content[i] ?? '')) { cursor = i; continue; }
    const nameStart = i;
    if (declaration) i++;
    else while (/[A-Za-z0-9:-]/.test(content[i] ?? '')) i++;
    const name = declaration ? '' : content.slice(nameStart, i).toLowerCase();
    const bodyStart = i;
    let quote = '', complete = false;
    while (i < content.length) {
      const char = content[i]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') { i++; complete = true; break; }
      i++;
    }
    yield { start, end: i, name, closing, comment: declaration, complete, bodyStart };
    cursor = i;
  }
}

function identityAttributes(content: string, part: HtmlPart): Map<string, string> {
  const attrs = new Map<string, string>();
  const end = part.end - 1;
  const space = (char: string | undefined) => /[\t\n\f\r ]/.test(char ?? '');
  let i = part.bodyStart;
  while (i < end) {
    while (i < end && (space(content[i]) || content[i] === '/')) i++;
    const start = i;
    while (i < end && !space(content[i]) && !['=', '/', '>'].includes(content[i]!)) i++;
    if (i === start) { i++; continue; }
    const name = content.slice(start, i).toLowerCase();
    while (i < end && space(content[i])) i++;
    if (content[i] !== '=') continue;
    i++;
    while (i < end && space(content[i])) i++;
    const quote = content[i] === '"' || content[i] === "'" ? content[i++]! : '';
    const valueStart = i;
    if (quote) while (i < end && content[i] !== quote) i++;
    else while (i < end && !space(content[i]) && content[i] !== '>') i++;
    const value = content.slice(valueStart, i);
    if (quote) i++;
    if (name !== 'data-deft-ref-kind' && name !== 'data-deft-ref-id') continue;
    // Only canonical quoted attributes can carry identity; duplicates fail closed.
    if (!quote || attrs.has(name)) return new Map();
    attrs.set(name, value);
  }
  return attrs;
}

/** Pair backtick runs by length without searching every possible delimiter again. */
function markdownLiteralRanges(content: string): ContentRange[] {
  const ranges: ContentRange[] = [];
  const runs: Array<ContentRange & { next?: number }> = [];
  for (let i = 0; i < content.length;) {
    if (content.charCodeAt(i) !== 96) { i++; continue; }
    const start = i;
    while (i < content.length && content.charCodeAt(i) === 96) i++;
    runs.push({ start, end: i });
  }
  const nextByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!, length = run.end - run.start;
    run.next = nextByLength.get(length);
    nextByLength.set(length, i);
  }
  let covered = 0;
  for (const run of runs) {
    if (run.start < covered) continue;
    const newline = run.next === undefined ? content.indexOf('\n', run.start) : -1;
    covered = run.next === undefined ? (newline < 0 ? content.length : newline) : runs[run.next]!.end;
    ranges.push({ start: run.start, end: covered });
  }
  // Link labels/destinations are literal contexts, including unfinished links.
  const brackets: number[] = [];
  let linkStart: number | null = null, depth = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (char === '\n') {
      if (linkStart !== null) ranges.push({ start: linkStart, end: i });
      linkStart = null; depth = 0; brackets.length = 0; continue;
    }
    if (linkStart !== null) {
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) {
        ranges.push({ start: linkStart, end: i + 1 }); linkStart = null;
      }
      continue;
    }
    if (char === '[') brackets.push(i);
    else if (char === ']') {
      const start = brackets.pop();
      if (start !== undefined && content[i + 1] === '(') {
        linkStart = content[start - 1] === '!' ? start - 1 : start;
        depth = 1; i++;
      }
    }
  }
  if (linkStart !== null) ranges.push({ start: linkStart, end: content.length });
  for (const match of content.matchAll(NATIVE_TOKEN_PATTERN)) {
    if (content[match.index - 1] === '\\') ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/** Ignore literal/quoted contexts, including incomplete code while an editor saves. */
function visibleNativeContent(content: string): string {
  const mask = (value: string) => value.replace(/[^\n]/g, ' ');
  let fence: { char: string; length: number } | null = null;
  const markdown = content.split('\n').map(line => {
    const delimiter = line.match(/^ {0,3}(\x60{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length };
      else if (delimiter[1]![0] === fence.char && delimiter[1]!.length >= fence.length) fence = null;
      return mask(line);
    }
    if (fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) return mask(line);
    return line;
  }).join('\n');
  const literals = applyContentRanges(markdown, markdownLiteralRanges(markdown), true);
  const ranges: ContentRange[] = [];
  const depths = new Map<string, number>();
  let blocked = 0, cursor = 0;
  for (const part of htmlParts(literals)) {
    if (blocked) ranges.push({ start: cursor, end: part.start });
    if (part.comment || blocked || LITERAL_TAGS.has(part.name)) ranges.push(part);
    if (!part.comment && LITERAL_TAGS.has(part.name)) {
      const count = depths.get(part.name) ?? 0;
      if (part.closing) { if (count) { depths.set(part.name, count - 1); blocked--; } }
      else { depths.set(part.name, count + 1); blocked++; }
    }
    cursor = part.end;
  }
  if (blocked) ranges.push({ start: cursor, end: literals.length });
  return applyContentRanges(literals, ranges, true);
}

/** Parse identity-bearing atoms, never resolve names or client-supplied URLs. */
export function extractNativeMentions(content: string): NativeMentionRef[] {
  const visible = visibleNativeContent(content);
  const refs = new Map<string, NativeMentionRef>();
  const add = (kind: unknown, id: unknown) => {
    const parsedKind = NativeMentionKindSchema.safeParse(kind);
    const parsedId = ResourceOpaqueIdSchema.safeParse(id);
    if (!parsedKind.success || !parsedId.success) return;
    const ref = nativeMentionRef(parsedKind.data, parsedId.data);
    refs.set(nativeMentionKey(ref), ref);
    if (refs.size > NATIVE_MENTION_LIMIT) throw new NativeMentionLimitError();
  };
  const parts = [...htmlParts(visible)];
  const text = applyContentRanges(visible, parts, true);
  for (const match of text.matchAll(NATIVE_TOKEN_PATTERN)) add(match[1], match[2]);
  for (const part of parts) {
    if (part.name !== 'span' || part.closing || !part.complete) continue;
    const attrs = identityAttributes(visible, part);
    add(attrs.get('data-deft-ref-kind'), attrs.get('data-deft-ref-id'));
  }
  return [...refs.values()];
}

/** Keep even malformed identity atoms out of legacy fuzzy name matching. */
export function stripNativeMentionAtoms(content: string): string {
  const ranges: ContentRange[] = [];
  const spans: Array<{ start: number; native: boolean }> = [];
  let nativeDepth = 0, nativeStart = 0;
  for (const part of htmlParts(content)) {
    if (part.comment || part.name !== 'span') continue;
    if (!part.closing) {
      const native = content.slice(part.bodyStart, part.end).toLowerCase().includes('data-deft-ref-kind');
      spans.push({ start: part.start, native });
      if (native && nativeDepth++ === 0) nativeStart = part.start;
    } else {
      const span = spans.pop();
      if (span?.native && --nativeDepth === 0) ranges.push({ start: nativeStart, end: part.end });
    }
  }
  if (nativeDepth) ranges.push({ start: nativeStart, end: content.length });
  let tokenStart: number | null = null;
  for (let i = 0; i < content.length; i++) {
    if (tokenStart === null && ['person', 'task', 'wiki_page'].some(kind => content.startsWith('[[deft:' + kind + ':', i))) {
      tokenStart = i;
    } else if (tokenStart !== null && content.startsWith(']]', i)) {
      ranges.push({ start: tokenStart, end: i + 2 }); tokenStart = null; i++;
    }
  }
  if (tokenStart !== null) ranges.push({ start: tokenStart, end: content.length });
  return applyContentRanges(content, ranges, false);
}

/** Replace tokens before Markdown rendering; caller must sanitize the result. */
export function nativeMentionTokensToHtml(content: string): string {
  const literals = visibleNativeContent(content);
  const visible = applyContentRanges(literals, [...htmlParts(literals)], true);
  // Models and pasted Markdown may add @ before the canonical token. The
  // rendered chip owns that prefix; identity extraction remains unchanged.
  const renderPattern = new RegExp('@?' + NATIVE_TOKEN_PATTERN.source, 'g');
  return content.replace(renderPattern, (token, kind, id, offset) => {
    const prefixed = token.startsWith('@');
    const atom = prefixed ? token.slice(1) : token;
    if (visible.slice(offset + (prefixed ? 1 : 0), offset + token.length) !== atom) return token;
    const literalPrefix = prefixed && (visible[offset] !== '@' || content[offset - 1] === '\\') ? '@' : '';
    return literalPrefix + '<span data-deft-ref-kind="' + kind + '" data-deft-ref-id="' + id + '">'
      + nativeMentionPlaceholder(kind) + '</span>';
  });
}
