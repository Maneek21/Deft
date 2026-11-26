// Images in the content an old note or canvas tool writes (spec 5.12; plan
// Task F15, review finding B-I2). create_note and write_canvas take content
// from Defty, an agent or a person's MCP client, and it can name Deft files
// (<img data-file-id>). A document's image is read through the document that
// links it (document_attachments, F10: lib/attachment-access.ts), so each
// image the content names is linked as F10 links an upload, or not shown:
// - linked: a file of the workspace that the acting person uploaded (for
//   Defty, the person who asked; for an agent, its own user) and that no
//   message, task or document links. Linking claims it: its staged expiry is
//   cleared, so the staged sweep keeps it.
// - kept: a file the document already links (a canvas write can keep an
//   image the canvas already shows).
// - anything else (someone else's upload, a file on a message, a task or
//   another document, another workspace's, an unknown id, an image with no
//   file) becomes the "Image not available" placeholder, as the notes move
//   does.
// The links are written in the transaction that stores the content (the
// create's, or the writer's through writeDocument's `inTransaction`), after
// the document's locks: the files are locked FOR UPDATE in id order and
// checked again there, and a file that stopped qualifying meanwhile refuses
// the write, which can be tried again.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { documentAttachments } from '@deft/db/documents';
import { files } from '@deft/db/schema';
import type { jsonToText } from '@deft/doc-schema';
import type { db } from './db.js';

type JSONContent = Parameters<typeof jsonToText>[0];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;

/** What an image the tool may not show becomes. The words the notes move uses. */
export const IMAGE_PLACEHOLDER = 'Image not available';

/** The file ids the content's images name, in order of first appearance. */
export function toolImageFileIds(json: JSONContent): string[] {
  const ids = new Set<string>();
  const walk = (node: JSONContent) => {
    const fileId: unknown = node.attrs?.fileId;
    if (node.type === 'image' && typeof fileId === 'string' && fileId !== '') ids.add(fileId);
    node.content?.forEach(walk);
  };
  walk(json);
  return [...ids];
}

/** The content with every image whose file isn't in `keep` (an image with no file included) as the placeholder, with its alt text. */
export function placeholderImagesExcept(json: JSONContent, keep: ReadonlySet<string>): JSONContent {
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'image') {
      const fileId: unknown = node.attrs?.fileId;
      if (typeof fileId === 'string' && keep.has(fileId)) return node;
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.trim() : '';
      return { type: 'paragraph', content: [{ type: 'text', text: alt ? `${IMAGE_PLACEHOLDER}: ${alt}` : IMAGE_PLACEHOLDER }] };
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  return visit(json);
}

/** Of `fileIds`, the files `uploaderId` uploaded in `orgId` that no message, task or document links (the header). */
async function unlinkedOwnFiles(reader: Reader, orgId: string, uploaderId: string, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await reader.select({ id: files.id }).from(files).where(and(
    eq(files.org_id, orgId), inArray(files.id, fileIds), eq(files.uploaded_by, uploaderId),
    sql`${files.message_id} IS NULL AND ${files.task_id} IS NULL`,
    sql`NOT EXISTS (SELECT 1 FROM message_attachments link WHERE link.org_id = ${files.org_id} AND link.file_id = ${files.id})`,
    sql`NOT EXISTS (SELECT 1 FROM task_attachments link WHERE link.org_id = ${files.org_id} AND link.file_id = ${files.id})`,
    sql`NOT EXISTS (SELECT 1 FROM document_attachments link WHERE link.org_id = ${files.org_id} AND link.file_id = ${files.id})`,
  ));
  return rows.map((row) => row.id);
}

export type ToolImages = {
  /** The content to store: every image the tool may not show is the placeholder. */
  json: JSONContent;
  /** The files to link in the store's transaction (linkToolImagesInTx). */
  link: string[];
};

/**
 * What a tool's content becomes in `documentId` (null for a new document),
 * read before the store: the files `uploaderId` may link, the ones the
 * document already links, and the placeholder for the rest.
 */
export async function toolImages(reader: Reader, input: {
  orgId: string; uploaderId: string; documentId: string | null; json: JSONContent;
}): Promise<ToolImages> {
  const named = toolImageFileIds(input.json);
  if (named.length === 0) return { json: input.json, link: [] };
  const already = input.documentId === null ? [] : (await reader.select({ file_id: documentAttachments.file_id }).from(documentAttachments)
    .where(and(eq(documentAttachments.org_id, input.orgId), eq(documentAttachments.document_id, input.documentId),
      inArray(documentAttachments.file_id, named)))).map((row) => row.file_id);
  const link = await unlinkedOwnFiles(reader, input.orgId, input.uploaderId, named.filter((id) => !already.includes(id)));
  const keep = new Set([...already, ...link]);
  return { json: keep.size === named.length ? input.json : placeholderImagesExcept(input.json, keep), link: link.sort() };
}

/** Thrown when a file stopped qualifying between the read and the store; nothing is written. */
export class ToolImageChanged extends Error {
  constructor() { super('An image in the content changed while it was saved. Try again.'); }
}

/**
 * In the store's transaction, after the document's locks: locks `fileIds`
 * FOR UPDATE in id order, checks each still qualifies (ToolImageChanged when
 * one doesn't), links each to the document as shown (`in_current`) and
 * clears its staged expiry.
 */
export async function linkToolImagesInTx(tx: Tx, input: {
  orgId: string; uploaderId: string; documentId: string; fileIds: string[];
}): Promise<void> {
  const ids = [...new Set(input.fileIds)].sort();
  if (ids.length === 0) return;
  await tx.select({ id: files.id }).from(files)
    .where(and(eq(files.org_id, input.orgId), inArray(files.id, ids)))
    .orderBy(files.id)
    .for('update');
  const still = await unlinkedOwnFiles(tx, input.orgId, input.uploaderId, ids);
  if (still.length !== ids.length) throw new ToolImageChanged();
  await tx.insert(documentAttachments).values(ids.map((fileId) => ({
    org_id: input.orgId, document_id: input.documentId, file_id: fileId, in_current: true, added_by: input.uploaderId,
  })));
  await tx.update(files).set({ staged_expires_at: null })
    .where(and(eq(files.org_id, input.orgId), inArray(files.id, ids)));
}
