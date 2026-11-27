import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, updateYFragment, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { getDocumentSchema } from './extensions';
import { nativeMentionText } from './nodes/native-mention';

/** The Yjs XML fragment that holds a document; the name `@tiptap/extension-collaboration` uses by default. */
export const DOCUMENT_FRAGMENT = 'default';

export const EMPTY_DOCUMENT: JSONContent = Object.freeze({
  type: 'doc',
  content: Object.freeze([Object.freeze({ type: 'paragraph' })]) as JSONContent[],
});

/**
 * JSON in the schema's canonical form (ProseMirror's `toJSON`: every
 * attribute present, marks in schema order), made of plain objects rather
 * than ProseMirror's null-prototype attribute objects. Not exported from the
 * package; the conversions below return this form.
 */
export function normalizeJson(json: JSONContent): JSONContent {
  return plainJson(getDocumentSchema().nodeFromJSON(json));
}

/** A ProseMirror node's `toJSON`, as plain objects. */
export function plainJson(node: ProseMirrorNode): JSONContent {
  return JSON.parse(JSON.stringify(node.toJSON())) as JSONContent;
}

/** EMPTY_DOCUMENT in canonical form, as a fresh object. */
export const emptyDocument = (): JSONContent => normalizeJson(EMPTY_DOCUMENT);

export function jsonToYDoc(json: JSONContent): Y.Doc {
  return prosemirrorJSONToYDoc(getDocumentSchema(), json, DOCUMENT_FRAGMENT);
}

/**
 * Makes the document's fragment equal `json` in one Yjs transaction, so it
 * reaches other clients as one update. It uses the binding's own
 * reconciliation (the code the editor runs on every local change), so blocks
 * that did not change keep their Yjs items and other people's cursors in them.
 * Throws, before touching `doc`, when `json` uses a type outside the schema.
 */
export function applyJsonToYDoc(doc: Y.Doc, json: JSONContent): void {
  const node = getDocumentSchema().nodeFromJSON(json);
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  doc.transact(() => {
    updateYFragment(doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
  });
}

/**
 * The document in canonical form, the same JSON the editor's `getJSON()`
 * gives. Throws when the Yjs state holds a node or mark type outside the
 * schema. An empty fragment reads as EMPTY_DOCUMENT (one empty paragraph).
 */
export function yDocToJson(doc: Y.Doc): JSONContent {
  const raw = yDocToProsemirrorJSON(doc, DOCUMENT_FRAGMENT);
  if (!raw.content.length) return emptyDocument();
  return normalizeJson(raw);
}

const LINE_SEPARATED = new Set(['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'table']);

function inlineText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'nativeMention') return nativeMentionText(node.attrs?.kind, node.attrs?.id);
  return (node.content ?? []).map(inlineText).join('');
}

function blockText(node: JSONContent): string {
  const type = node.type ? getDocumentSchema().nodes[node.type] : undefined;
  if (type?.isTextblock) return (node.content ?? []).map(inlineText).join('');
  if (node.type === 'image') return typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  const separator = node.type === 'tableRow' ? '\t' : LINE_SEPARATED.has(node.type ?? '') ? '\n' : '\n\n';
  return (node.content ?? []).map(blockText).filter(Boolean).join(separator);
}

/**
 * Plain text for search and previews: blocks joined by a blank line, list
 * items (and table rows) by a line break, table cells by a tab. A native
 * mention is its `[[deft:kind:id]]` token.
 */
export function jsonToText(json: JSONContent): string {
  return blockText(json);
}
