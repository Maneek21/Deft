// The notes move (plan Task F14): turning a note's HTML, or a canvas's
// TipTap JSON, into document JSON, and a document too large for live editing
// into a page with sub-pages. Pure: nothing here reads the database.
//
// - HTML goes through F1's htmlToJson, which drops scripts, frames, forms and
//   inline handlers and counts them, and reads only what the document schema
//   has a place for.
// - An image names a Deft file by `data-file-id`, or by a `src` whose path
//   is /api/files/<id>. Any host counts, as the notes editor read it
//   (notes/protected-note-image.tsx) and note_files records it
//   (lib/note-file-claims.ts): a note saved while the API had another public
//   address (lib/public-url.ts apiPublicUrl) still names its own file. The
//   database decides which of those files the document may link
//   (move-notes.ts); every other one becomes a visible "Image not available"
//   paragraph, keeping its alt text, and is counted.
// - Block ids are derived from the source id and each block's content, so a
//   block that is the same in two versions of a note carries the same id in
//   both (history compares blocks by id). ensureBlockIds settles the rest.
// - Size is measured as the live server measures it: the encoded Yjs state
//   (collab/limits.ts encodedStateBytes) and its normalized bound
//   (collab/size-account.ts boundFor), held to the cap with withinSizeCap. A
//   document over the cap is split before it is created (F5's create refuses
//   it): at top-level headings into sub-pages, and a single block over the
//   cap at paragraph or line boundaries. Nothing is dropped.
import { createHash } from 'node:crypto';
import { BLOCK_ID_TYPES, blockHash, ensureBlockIds, getDocumentSchema, htmlToJson, jsonToText, jsonToYDoc } from '@deft/doc-schema';
import { COLLAB_LIMITS, encodedStateBytes, withinSizeCap } from '../../collab/limits.js';
import { boundFor } from '../../collab/size-account.js';

export type JSONContent = Parameters<typeof jsonToText>[0];

/** What a missing or unlinkable image becomes. */
export const IMAGE_PLACEHOLDER = 'Image not available';

/** A file id as note_files and the upload route write them. */
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const blockIdTypes = new Set<string>(BLOCK_ID_TYPES);
const HEADING_MAX = 3;

/** A refusal the move reports in fixed words (no content, no ids). */
export class MoveError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The Deft file an image `src` names: the path /api/files/<id>, on any host or none. */
export function deftFileIdFromSrc(src: unknown): string | null {
  if (typeof src !== 'string' || !src.includes('/api/files/')) return null;
  try {
    const match = new URL(src, 'http://deft.invalid').pathname.match(/^\/api\/files\/([^/]+)$/);
    const id = match ? decodeURIComponent(match[1]!).trim() : '';
    return FILE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function mapNodes(node: JSONContent, fn: (node: JSONContent) => JSONContent | JSONContent[]): JSONContent[] {
  const copy: JSONContent = { ...node };
  if (node.content) copy.content = node.content.flatMap((child) => mapNodes(child, fn));
  const out = fn(copy);
  return Array.isArray(out) ? out : [out];
}

function transform(json: JSONContent, fn: (node: JSONContent) => JSONContent | JSONContent[]): JSONContent {
  return mapNodes(json, fn)[0]!;
}

/** Every image names its Deft file in `fileId` (from `data-file-id` or an /api/files/ path), with no `src`. */
function normalizeImages(json: JSONContent): JSONContent {
  return transform(json, (node) => {
    if (node.type !== 'image') return node;
    const attrs = { ...node.attrs };
    const own = typeof attrs.fileId === 'string' ? attrs.fileId.trim() : '';
    const fileId = own || deftFileIdFromSrc(attrs.src);
    if (fileId) {
      attrs.fileId = fileId;
      attrs.src = null;
    }
    return { ...node, attrs };
  });
}

/** A note's HTML (null reads as empty) as document JSON, and how many unsafe things were dropped. */
export function noteHtmlToJson(html: string | null): { json: JSONContent; unsafeDropped: number } {
  const { json, dropped } = htmlToJson(html ?? '');
  return { json: normalizeImages(json), unsafeDropped: dropped };
}

/** The Deft files the content's images name, in order of first appearance. */
export function imageFileIds(json: JSONContent): string[] {
  const ids = new Set<string>();
  const walk = (node: JSONContent) => {
    const fileId: unknown = node.attrs?.fileId;
    if (node.type === 'image' && typeof fileId === 'string' && fileId !== '') ids.add(fileId);
    node.content?.forEach(walk);
  };
  walk(json);
  return [...ids];
}

const textParagraph = (text: string): JSONContent => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });

/**
 * Every image naming a Deft file outside `linked` becomes an "Image not
 * available" paragraph (with its alt text, when it had one). An image from
 * another site (`src` only) stays. Returns how many were replaced.
 */
export function replaceUnlinkedImages(json: JSONContent, linked: ReadonlySet<string>): { json: JSONContent; missing: number } {
  let missing = 0;
  const out = transform(json, (node) => {
    if (node.type !== 'image') return node;
    const fileId: unknown = node.attrs?.fileId;
    if (typeof fileId !== 'string' || fileId === '' || linked.has(fileId)) return node;
    missing += 1;
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : '';
    return textParagraph(alt ? `${IMAGE_PLACEHOLDER}: ${alt}` : IMAGE_PLACEHOLDER);
  });
  return { json: out, missing };
}

/** The schema's canonical JSON (every attribute present), or a MoveError when the content isn't a valid document. */
function canonical(json: JSONContent): JSONContent {
  try {
    const node = getDocumentSchema().nodeFromJSON(json);
    node.check();
    return JSON.parse(JSON.stringify(node.toJSON())) as JSONContent;
  } catch {
    throw new MoveError('content_invalid', 'The converted content is not a valid document');
  }
}

function derivedId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Blocks with no valid id get one derived from `seed`, their content and how often that content came before. */
function stableBlockIds(json: JSONContent, seed: string): JSONContent {
  const seen = new Map<string, number>();
  return transform(json, (node) => {
    if (!blockIdTypes.has(node.type ?? '')) return node;
    const id: unknown = node.attrs?.id;
    if (typeof id === 'string' && VALID_BLOCK_ID.test(id)) return node;
    const hash = blockHash(node);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    return { ...node, attrs: { ...node.attrs, id: derivedId(`${seed}\u0000${hash}\u0000${occurrence}`) } };
  });
}

/** Content as it is stored: canonical, with a valid, unique id on every block. */
export function finishContent(json: JSONContent, seed: string): JSONContent {
  return ensureBlockIds(stableBlockIds(canonical(json), seed));
}

/** The encoded Yjs state's length (`bytes`, what size_bytes records) and its normalized bound (what the cap is held to). */
export function measureContent(json: JSONContent): { bytes: number; bound: number } {
  const ydoc = jsonToYDoc(json);
  try {
    const bytes = encodedStateBytes(ydoc);
    return { bytes, bound: boundFor(ydoc, bytes) };
  } finally {
    ydoc.destroy();
  }
}

/** True when a new document of this size may be created: withinSizeCap from nothing. */
export const fitsSizeCap = (bound: number): boolean => withinSizeCap(0, bound);

// ---------------------------------------------------------------------------
// Splitting

export type ContentPart = { title: string; json: JSONContent; bytes: number };

const docOf = (blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] });
const estimate = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const measureBlocks = (blocks: JSONContent[]): number => measureContent(docOf(blocks)).bound;

function isValidNode(node: JSONContent): boolean {
  try {
    getDocumentSchema().nodeFromJSON(node).check();
    return true;
  } catch {
    return false;
  }
}

function withoutId(attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attrs) return attrs;
  const { id: _id, ...rest } = attrs;
  return rest;
}

/** Cuts `text` into pieces of at most `max` UTF-16 units, at a space when one is near, never inside a surrogate pair. */
function cutText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (text.length - start > max) {
    let end = start + max;
    const space = text.lastIndexOf(' ', end);
    if (space > start + max / 2) end = space + 1;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/**
 * A paragraph or heading cut into textblocks of about `target` bytes, in one
 * pass over its content in order, so nothing moves:
 * - a cut falls at a line break when it can: the break becomes the boundary
 *   between two textblocks, and an empty line stays an empty textblock;
 * - only a line longer than `target` on its own is cut inside, between its
 *   inline nodes, and a text node longer than that at a space or anywhere,
 *   keeping its marks.
 * The first piece keeps its type; a heading's later pieces are paragraphs.
 */
function splitTextblock(node: JSONContent, target: number): JSONContent[] {
  const maxChars = Math.max(1, Math.floor(target / 3));
  const lines: JSONContent[][] = [[]];
  for (const inline of node.content ?? []) {
    if (inline.type === 'hardBreak') {
      lines.push([]);
    } else if (inline.type === 'text' && typeof inline.text === 'string' && estimate(inline) > target) {
      for (const text of cutText(inline.text, maxChars)) lines[lines.length - 1]!.push({ ...inline, text });
    } else {
      lines[lines.length - 1]!.push(inline);
    }
  }
  const hardBreak: JSONContent = { type: 'hardBreak' };
  const breakSize = estimate(hardBreak);
  const chunks: JSONContent[][] = [];
  let current: JSONContent[] = [];
  let size = 0;
  const flush = () => {
    chunks.push(current);
    current = [];
    size = 0;
  };
  lines.forEach((line, index) => {
    if (index > 0) {
      // The line break: a boundary between textblocks when the next line doesn't fit beside what is open.
      if (size > 0 && size + breakSize + estimate(line) > target) flush();
      else {
        current.push(hardBreak);
        size += breakSize;
      }
    }
    for (const inline of line) {
      const inlineSize = estimate(inline);
      if (size > 0 && size + inlineSize > target) flush();
      current.push(inline);
      size += inlineSize;
    }
  });
  flush();
  return chunks.map((content, index) => {
    const type = index > 0 && node.type === 'heading' ? 'paragraph' : node.type;
    const attrs = type === node.type ? withoutId(node.attrs) : undefined;
    return { type, ...(attrs ? { attrs } : {}), ...(content.length > 0 ? { content } : {}) };
  });
}

/** A code block cut at its lines into code blocks of about `target` bytes (a longer line anywhere). */
function splitCodeBlock(node: JSONContent, target: number): JSONContent[] {
  const text = (node.content ?? []).map((inline) => inline.text ?? '').join('');
  const max = Math.max(1, Math.floor(target / 3));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentSize = 0;
  for (const line of text.split('\n')) {
    const pieces = line.length > max ? cutText(line, max) : [line];
    for (const piece of pieces) {
      const size = Buffer.byteLength(piece, 'utf8') + 1;
      if (current.length > 0 && currentSize + size > target) {
        chunks.push(current.join('\n'));
        current = [];
        currentSize = 0;
      }
      current.push(piece);
      currentSize += size;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.map((chunk) => ({ type: 'codeBlock', attrs: withoutId(node.attrs), ...(chunk ? { content: [{ type: 'text', text: chunk }] } : {}) }));
}

/** A copy of `node` holding `content`; an ordered list's copy carries on its numbering. */
function wrapCopy(node: JSONContent, content: JSONContent[], offset: number): JSONContent {
  const attrs = withoutId(node.attrs) ?? {};
  if (node.type === 'orderedList') attrs.start = (typeof attrs.start === 'number' ? attrs.start : 1) + offset;
  return { type: node.type, attrs, content };
}

/**
 * The blocks inside `node` lifted out of it, for a container whose parts
 * can't stand alone (a toggle's summary and body): its block children stay as
 * they are, a textblock child becomes a paragraph with the same content, and
 * anything else is lifted in turn. Text, marks and images are kept.
 */
function liftBlocks(node: JSONContent): JSONContent[] {
  const schema = getDocumentSchema();
  return (node.content ?? []).flatMap((child) => {
    const type = schema.nodes[child.type ?? ''];
    if (type?.isInGroup('block')) return [child];
    if (type?.isTextblock) return [{ type: 'paragraph', ...(child.content?.length ? { content: child.content } : {}) }];
    return liftBlocks(child);
  });
}

/**
 * `node` split into two or more blocks that together hold all of it, or []
 * when it can't be split (a leaf). A container is split between its
 * children, each group in a copy of it; one with a single child splits that
 * child; a container whose copies wouldn't be valid is lifted (liftBlocks).
 */
function splitBlock(node: JSONContent, target: number): JSONContent[] {
  const schema = getDocumentSchema();
  const type = schema.nodes[node.type ?? ''];
  if (node.type === 'codeBlock') return splitCodeBlock(node, target);
  if (type?.isTextblock) return splitTextblock(node, target);
  const children = node.content ?? [];
  if (children.length === 0) return [];
  let pieces: JSONContent[];
  if (children.length === 1) {
    const inner = splitBlock(children[0]!, target);
    if (inner.length < 2) return [];
    pieces = inner.map((child) => wrapCopy(node, [child], 0));
  } else {
    pieces = [];
    let group: JSONContent[] = [];
    let groupSize = 0;
    let offset = 0;
    for (const child of children) {
      const size = estimate(child);
      if (group.length > 0 && groupSize + size > target) {
        pieces.push(wrapCopy(node, group, offset));
        offset += group.length;
        group = [];
        groupSize = 0;
      }
      group.push(child);
      groupSize += size;
    }
    pieces.push(wrapCopy(node, group, offset));
    if (pieces.length < 2) {
      const half = Math.ceil(children.length / 2);
      pieces = [wrapCopy(node, children.slice(0, half), 0), wrapCopy(node, children.slice(half), half)];
    }
  }
  if (pieces.every(isValidNode)) return pieces;
  const lifted = liftBlocks(node);
  return lifted.length > 0 ? lifted : [];
}

type Unit = { node: JSONContent; bytes: number; startsSection: boolean };

/** A top-level block as units no larger than `budget`, each measured; counts the blocks it had to split. */
function fitBlock(node: JSONContent, budget: number, depth: number): { units: Unit[]; split: boolean } {
  const startsSection = node.type === 'heading';
  const rough = estimate(node);
  const bytes = rough > budget / 2 ? measureBlocks([node]) : rough;
  if (bytes <= budget) return { units: [{ node, bytes, startsSection }], split: false };
  if (depth > 40) throw new MoveError('block_too_large', 'A block could not be split under the size cap');
  const pieces = splitBlock(node, Math.floor(budget / 2));
  if (pieces.length < 2) throw new MoveError('block_too_large', 'A block could not be split under the size cap');
  const units = pieces.flatMap((piece) => fitBlock(piece, budget, depth + 1).units);
  if (units[0]) units[0].startsSection = startsSection;
  for (const unit of units.slice(1)) unit.startsSection = false;
  return { units, split: true };
}

function partTitle(title: string, blocks: JSONContent[], index: number): string {
  if (index === 0) return title;
  const first = blocks[0];
  const heading = first?.type === 'heading' ? jsonToText(first).trim().slice(0, 200) : '';
  return heading || `${title.trim() || 'Untitled'} (part ${index + 1})`;
}

/**
 * `json` (finished content) as one part when it fits the size cap, else as
 * a first part and sub-pages, each within it and finished with its own ids
 * (`seed`). Sections start at top-level headings and are packed in order, a
 * part breaking only between sections unless one section alone is too large.
 * `splitBlocks` counts the top-level blocks that had to be split themselves.
 */
export function splitToFit(json: JSONContent, title: string, seed: string): { parts: ContentPart[]; splitBlocks: number } {
  const whole = measureContent(json);
  if (fitsSizeCap(whole.bound)) return { parts: [{ title, json, bytes: whole.bytes }], splitBlocks: 0 };
  // Pack below the cap: the per-block sizes are close to, not exactly, their sum in one document.
  const budget = Math.floor(COLLAB_LIMITS.docMaxBytes * 0.85);
  let splitBlocks = 0;
  const units: Unit[] = [];
  for (const block of json.content ?? []) {
    const fitted = fitBlock(block, budget, 0);
    if (fitted.split) splitBlocks += 1;
    units.push(...fitted.units);
  }
  const sections: Unit[][] = [];
  for (const unit of units) {
    if (unit.startsSection || sections.length === 0) sections.push([]);
    sections[sections.length - 1]!.push(unit);
  }
  const groups: Unit[][] = [[]];
  let size = 0;
  for (const section of sections) {
    const sectionSize = section.reduce((sum, unit) => sum + unit.bytes, 0);
    const current = groups[groups.length - 1]!;
    if (current.length > 0 && size + sectionSize > budget) {
      // A section that doesn't fit starts a part of its own, so its heading leads it.
      groups.push([]);
      size = 0;
    }
    for (const unit of section) {
      const open = groups[groups.length - 1]!;
      if (open.length > 0 && size + unit.bytes > budget) {
        groups.push([unit]);
        size = unit.bytes;
      } else {
        open.push(unit);
        size += unit.bytes;
      }
    }
  }
  // Each part measured as stored; one still over the cap hands its last block to the next.
  const parts: ContentPart[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    for (;;) {
      const blocks = group.map((unit) => unit.node);
      const finished = finishContent(docOf(blocks), `${seed}\u0000part\u0000${index}`);
      const measured = measureContent(finished);
      if (fitsSizeCap(measured.bound)) {
        parts.push({ title: partTitle(title, blocks, index), json: finished, bytes: measured.bytes });
        break;
      }
      if (group.length < 2) throw new MoveError('block_too_large', 'A block could not be split under the size cap');
      if (index + 1 >= groups.length) groups.push([]);
      groups[index + 1]!.unshift(group.pop()!);
    }
  }
  return { parts, splitBlocks };
}

// ---------------------------------------------------------------------------
// Canvases

/** Plain text of anything JSON-shaped: its `text` strings, block-like children on their own lines. */
function looseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: unknown; content?: unknown };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  const blockish = node.content.some((child) => child && typeof child === 'object' && Array.isArray((child as { content?: unknown }).content));
  return node.content.map(looseText).join(blockish ? '\n' : '');
}

/** Headings deeper than the schema's last level become that level (as F1's import folds them). */
function clampHeadings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clampHeadings);
  if (!value || typeof value !== 'object') return value;
  const node = { ...(value as Record<string, unknown>) };
  if (node.type === 'heading' && node.attrs && typeof node.attrs === 'object') {
    const level = (node.attrs as { level?: unknown }).level;
    if (typeof level === 'number' && level > HEADING_MAX) node.attrs = { ...(node.attrs as object), level: HEADING_MAX };
  }
  if (Array.isArray(node.content)) node.content = node.content.map(clampHeadings);
  return node;
}

function textParagraphs(text: string): JSONContent[] {
  return text.split('\n').map(textParagraph);
}

function isEmptyDocument(json: JSONContent): boolean {
  return (json.content ?? []).every((block) => block.type === 'paragraph' && jsonToText(block).trim() === '');
}

/**
 * A canvas's stored content as document JSON, or null when it is empty
 * (nothing, or only blank paragraphs). The canvas editor wrote TipTap JSON
 * with StarterKit's nodes, and an agent could write any JSON or a string: a
 * valid document is kept as it is; otherwise each top-level block that is
 * valid on its own is kept and each other one becomes paragraphs of its text
 * (`flattenedBlocks`), so no text is lost.
 */
export function canvasContentToJson(content: unknown): { json: JSONContent | null; flattenedBlocks: number } {
  if (content === null || content === undefined) return { json: null, flattenedBlocks: 0 };
  let json: JSONContent;
  let flattenedBlocks = 0;
  if (typeof content === 'string') {
    json = { type: 'doc', content: textParagraphs(content) };
  } else if (typeof content !== 'object') {
    json = { type: 'doc', content: textParagraphs(String(content)) };
  } else {
    const clamped = clampHeadings(content) as JSONContent;
    if (clamped.type === 'doc' && isValidNode(clamped)) {
      json = clamped;
    } else {
      const schema = getDocumentSchema();
      const blocks = Array.isArray(clamped.content) ? clamped.content : [clamped];
      const kept: JSONContent[] = [];
      for (const block of blocks) {
        const type = schema.nodes[(block as JSONContent)?.type ?? ''];
        if (type?.isInGroup('block') && isValidNode(block)) {
          kept.push(block);
        } else {
          flattenedBlocks += 1;
          kept.push(...textParagraphs(looseText(block)));
        }
      }
      json = { type: 'doc', content: kept };
    }
  }
  const normalized = normalizeImages(canonical(json));
  return { json: isEmptyDocument(normalized) ? null : normalized, flattenedBlocks };
}

/** True when a canvas has content the move turns into a document. */
export function canvasHasContent(content: unknown): boolean {
  if (content === null || content === undefined) return false;
  try {
    return canvasContentToJson(content).json !== null;
  } catch {
    // Content the move can't read still has to be moved (and reported): it counts.
    return true;
  }
}
