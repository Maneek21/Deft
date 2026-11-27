// Block ids in a live document (plan Task F7; F7 consult, finding 1).
//
// The derived JSON carries a valid, unique id on every block-id node (F1's
// ensureBlockIds). The live Y.Doc gets exactly those ids back, and nothing
// else: only the `id` attribute, set directly on the Y.XmlElements whose id
// is missing, invalid or a later duplicate, and only where it differs. The
// canonical JSON is never re-applied, so formatted text runs, attribute
// defaults and the structure stay as the clients wrote them, and a client's
// concurrent edit inside a run is never undone by a server rewrite.
//
// The JSON and the Y tree line up node for node: every Y.XmlElement is one
// JSON node, and a Y.XmlText is zero or more consecutive JSON text nodes
// (formatted runs, which ProseMirror may also join across neighbouring
// Y.XmlTexts). So the non-text JSON nodes and the Y.XmlElements of one
// parent correspond in order.
import * as Y from 'yjs';
import { BLOCK_ID_TYPES } from '@deft/doc-schema';
import type { JSONContent } from './persistence.js';

const blockIdTypes = new Set<string>(BLOCK_ID_TYPES);

/** A block id ensureBlockIds keeps (packages/doc-schema/src/blocks.ts, BLOCK_ID). */
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isValidId = (id: unknown): id is string => typeof id === 'string' && VALID_ID.test(id);

function elementsOf(parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  return parent.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
}

/**
 * Sets the ids `withIds` (ensureBlockIds of `json`, the JSON read from
 * `doc`) gave blocks whose id changed, on their Y.XmlElements, in one
 * transaction with `origin`. Returns how many it set. Where the trees don't
 * line up (they always should), that subtree is left alone.
 */
export function writeBackBlockIds(doc: Y.Doc, json: JSONContent, withIds: JSONContent, origin: unknown): number {
  const changes: Array<[Y.XmlElement, string]> = [];
  const visit = (parent: Y.XmlFragment | Y.XmlElement, before: JSONContent, after: JSONContent) => {
    const elements = elementsOf(parent);
    const beforeNodes = (before.content ?? []).filter((node) => node.type !== 'text');
    const afterNodes = (after.content ?? []).filter((node) => node.type !== 'text');
    if (elements.length !== beforeNodes.length || afterNodes.length !== beforeNodes.length) return;
    elements.forEach((element, i) => {
      const was = beforeNodes[i]!;
      const now = afterNodes[i]!;
      if (element.nodeName !== was.type || now.type !== was.type) return;
      const id: unknown = now.attrs?.id;
      if (blockIdTypes.has(element.nodeName) && typeof id === 'string' && element.getAttribute('id') !== id) changes.push([element, id]);
      visit(element, was, now);
    });
  };
  visit(doc.getXmlFragment('default'), json, withIds);
  if (changes.length > 0) doc.transact(() => { for (const [element, id] of changes) element.setAttribute('id', id); }, origin);
  return changes.length;
}

/**
 * How many block elements a write-back would give an id: block-id nodes
 * whose `id` is missing, invalid, or a valid id an earlier block (in
 * document order) already holds. Walks the Y tree only (no yDocToJson), so
 * it counts in a state holding content outside the schema too.
 */
export function blocksNeedingIds(doc: Y.Doc): number {
  const seen = new Set<string>();
  let count = 0;
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const element of elementsOf(parent)) {
      if (blockIdTypes.has(element.nodeName)) {
        const id: unknown = element.getAttribute('id');
        if (isValidId(id) && !seen.has(id)) seen.add(id);
        else count += 1;
      }
      visit(element);
    }
  };
  visit(doc.getXmlFragment('default'));
  return count;
}

/** How many structs Yjs holds back in `doc` (waiting for a missing clock). */
export function heldBackStructs(doc: Y.Doc): number {
  const pending = doc.store.pendingStructs;
  if (!pending) return 0;
  return Y.decodeUpdateV2(pending.update).structs.filter((struct) => struct instanceof Y.Item).length;
}
