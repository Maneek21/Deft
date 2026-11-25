import { createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import { BLOCK_ID_TYPES } from './extensions';

/** The line that names the next top-level block in Markdown written with `blockIds: true`. */
export const BLOCK_ID_COMMENT = /^<!-- block:([0-9a-f-]{36}) -->$/;

const blockIdTypes = new Set<string>(BLOCK_ID_TYPES);

const hasBlockId = (node: JSONContent) => blockIdTypes.has(node.type ?? '');

/**
 * Gives every block-id node (at any depth) that has no id, or repeats an
 * earlier one, a new `crypto.randomUUID()`, as the editor's UniqueID does.
 * Returns a new document; the input is not changed.
 */
export function ensureBlockIds(json: JSONContent): JSONContent {
  const seen = new Set<string>();
  const visit = (node: JSONContent): JSONContent => {
    const copy: JSONContent = { ...node };
    if (hasBlockId(node)) {
      const current: unknown = node.attrs?.id;
      const id = typeof current === 'string' && current && !seen.has(current) ? current : crypto.randomUUID();
      seen.add(id);
      copy.attrs = { ...node.attrs, id };
    }
    if (node.content) copy.content = node.content.map(visit);
    return copy;
  };
  return visit(json);
}

/** The document's top-level blocks that have a block id, with their position in `content`. */
export function topLevelBlocks(json: JSONContent): Array<{ id: string; index: number; node: JSONContent }> {
  return (json.content ?? []).flatMap((node, index) => {
    const id: unknown = node.attrs?.id;
    return hasBlockId(node) && typeof id === 'string' && id ? [{ id, index, node }] : [];
  });
}

/**
 * The node with block ids removed (at any depth) and empty or null parts
 * dropped, so the same content hashes the same however it was written. A
 * native mention's `id` names what it mentions, so it stays.
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

/** sha256 (hex) of the block's canonical JSON, ignoring block ids, so a block that only got a new id keeps its hash. */
export function blockHash(node: JSONContent): string {
  return createHash('sha256').update(canonicalJson(withoutBlockIds(node))).digest('hex');
}
