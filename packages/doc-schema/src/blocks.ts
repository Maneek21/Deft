import { createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import { BLOCK_ID_TYPES } from './extensions';

/** The line that names the next top-level block in Markdown written with `blockIds: true`. */
export const BLOCK_ID_COMMENT = /^<!-- block:([A-Za-z0-9_-]{1,64}) -->$/;

/** A block id BLOCK_ID_COMMENT can carry: a UUID from `crypto.randomUUID()`, or any other such token. */
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

const blockIdTypes = new Set<string>(BLOCK_ID_TYPES);

const hasBlockId = (node: JSONContent) => blockIdTypes.has(node.type ?? '');

/** A UUID-shaped id (version 8, "custom", per RFC 9562) taken from the sha256 of `seed`: the same seed always gives the same id. */
function derivedBlockId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Gives every block-id node (at any depth) an id BLOCK_ID_COMMENT can carry,
 * changing as little as it can. The same input always gives the same ids,
 * except where a random id is the only choice:
 * - an existing id that matches BLOCK_ID is kept;
 * - an existing id that does not match (`has space`), or that repeats an
 *   earlier block's id, gets an id derived from the sha256 of the old id and
 *   how many times it has already been seen;
 * - only a block with no id, or an empty one, gets a random `crypto.randomUUID()`.
 * Returns a new document; the input is not changed.
 */
export function ensureBlockIds(json: JSONContent): JSONContent {
  const assigned = new Set<string>();
  const occurrences = new Map<string, number>();
  const idFor = (current: unknown): string => {
    if (current === null || current === undefined || current === '') return crypto.randomUUID();
    const old = String(current);
    const occurrence = occurrences.get(old) ?? 0;
    occurrences.set(old, occurrence + 1);
    if (occurrence === 0 && BLOCK_ID.test(old) && !assigned.has(old)) return old;
    const seed = occurrence === 0 ? old : `${old}\u0000${occurrence}`;
    let id = derivedBlockId(seed);
    for (let attempt = 1; assigned.has(id); attempt += 1) id = derivedBlockId(`${seed}\u0000${attempt}`);
    return id;
  };
  const visit = (node: JSONContent): JSONContent => {
    const copy: JSONContent = { ...node };
    if (hasBlockId(node)) {
      const id = idFor(node.attrs?.id);
      assigned.add(id);
      copy.attrs = { ...node.attrs, id };
    }
    if (node.content) copy.content = node.content.map(visit);
    return copy;
  };
  return visit(json);
}

/**
 * Every top-level block with its id and its position in `content`. It runs
 * `ensureBlockIds` on a copy first (every top-level block type carries an
 * id), so a stored id, or one derived from a malformed or repeated id, is the
 * same on every call; only a block with no id gets a fresh random one each
 * call, so store the `ensureBlockIds` result when that id has to stay the same.
 */
export function topLevelBlocks(json: JSONContent): Array<{ id: string; index: number; node: JSONContent }> {
  return (ensureBlockIds(json).content ?? []).flatMap((node, index) => {
    const id: unknown = node.attrs?.id;
    return typeof id === 'string' && hasBlockId(node) ? [{ id, index, node }] : [];
  });
}

/**
 * The node as blockHash sees it: `attrs.id` removed only on block-id node
 * types (at any depth); every other id, such as the person or task a native
 * mention names, is kept; null attribute values and empty `attrs`,
 * `content` and `marks` are dropped.
 */
function withoutBlockIds(node: JSONContent): JSONContent {
  const { attrs, content, marks, ...rest } = node;
  const out: JSONContent = { ...rest };
  const kept = Object.entries(attrs ?? {})
    .filter(([name, value]) => value !== null && value !== undefined && !(name === 'id' && hasBlockId(node)));
  if (kept.length) out.attrs = Object.fromEntries(kept);
  if (content?.length) out.content = content.map(withoutBlockIds);
  if (marks?.length) out.marks = marks.map(mark => ({ ...withoutBlockIds(mark), type: mark.type }));
  return out;
}

/** JSON with object keys in sorted order and undefined values left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 (hex) of the block's canonical JSON. The rule, which stored hashes
 * depend on:
 * - `attrs.id` is removed on block-id node types (BLOCK_ID_TYPES) at any
 *   depth, so a block that only got a new id keeps its hash;
 * - every other id is content and is kept: a native mention's `id` names the
 *   person or task, so mentioning someone else changes the hash;
 * - attributes whose value is null, and empty `attrs`, `content` and `marks`,
 *   are dropped, so sparse and complete JSON for the same block hash the same;
 * - object keys are sorted; arrays keep their order.
 */
export function blockHash(node: JSONContent): string {
  return createHash('sha256').update(canonicalJson(withoutBlockIds(node))).digest('hex');
}
