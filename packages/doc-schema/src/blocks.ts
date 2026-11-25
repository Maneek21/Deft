import { createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import { BLOCK_ID_TYPES } from './extensions';

/** The line that names the next top-level block in Markdown written with `blockIds: true`. */
export const BLOCK_ID_COMMENT = /^<!-- block:([0-9a-f-]{36}) -->$/;

/** The shape of a block id: what `crypto.randomUUID()` gives and BLOCK_ID_COMMENT can carry. */
const BLOCK_ID = /^[0-9a-f-]{36}$/;

const blockIdTypes = new Set<string>(BLOCK_ID_TYPES);

const hasBlockId = (node: JSONContent) => blockIdTypes.has(node.type ?? '');

/**
 * Gives every block-id node (at any depth) a new `crypto.randomUUID()` when
 * its id is missing, is not block-id shaped, or repeats an earlier one, as
 * the editor's UniqueID does. Returns a new document; the input is not changed.
 */
export function ensureBlockIds(json: JSONContent): JSONContent {
  const seen = new Set<string>();
  const visit = (node: JSONContent): JSONContent => {
    const copy: JSONContent = { ...node };
    if (hasBlockId(node)) {
      const current: unknown = node.attrs?.id;
      const keep = typeof current === 'string' && BLOCK_ID.test(current) && !seen.has(current);
      const id = keep ? current : crypto.randomUUID();
      seen.add(id);
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
 * id), so a block without a valid id gets a fresh one on each call; store the
 * `ensureBlockIds` result when an id has to stay the same.
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
