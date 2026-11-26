// A chat's old canvas, read-only since canvases became documents (spec 5.11
// and 5.12; plan Task F15; lib/legacy-notes.ts). The move made each canvas
// with content a document shared with its chat, and dropped empty ones.
//
// GET answers a read-only view of the chat's canvas document: who may read
// the chat (a member, or a member of the workspace reading a public chat
// before joining) and can open the document now. It never creates anything:
// a chat with no canvas, or one whose canvas was empty, is 404, and so is a
// document the caller can't open. PATCH answers 410 CANVAS_MOVED, with the
// document's id when the caller can open it (chat membership plays no part).
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { documents } from '@deft/db/documents';
import { db } from '../lib/db.js';
import { documentRoleFor } from '../lib/document-access.js';
import { canvasDocumentFor, CANVAS_MOVED, documentJsonNow } from '../lib/legacy-notes.js';
import { canReadSpace } from '../lib/space-membership.js';

export const canvasRoutes = new Hono();

const NO_CANVAS = { error: 'This space has no canvas', code: 'NOT_FOUND' } as const;

// GET /api/spaces/:spaceId/canvas — the chat's canvas document, read-only
canvasRoutes.get('/:spaceId/canvas', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');

  if (!(await canReadSpace(spaceId, user.id, user.org_id))) {
    return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
  }
  const canvas = await canvasDocumentFor(user.org_id, spaceId);
  if (!canvas?.documentId) return c.json(NO_CANVAS, 404);
  const role = await documentRoleFor(user.id, user.org_id, canvas.documentId);
  if (!role) return c.json(NO_CANVAS, 404);

  const [document] = await db.select({
    id: documents.id, title: documents.title, content_json: documents.content_json,
    last_edited_by: documents.last_edited_by, last_edited_at: documents.last_edited_at, updated_at: documents.updated_at,
  }).from(documents).where(and(eq(documents.id, canvas.documentId), eq(documents.org_id, user.org_id))).limit(1);
  if (!document) return c.json(NO_CANVAS, 404);

  return c.json({
    id: canvas.canvasId,
    space_id: spaceId,
    document_id: document.id,
    title: document.title,
    content: await documentJsonNow(user.org_id, document.id, document.content_json),
    last_edited_by: document.last_edited_by,
    last_edited_at: document.last_edited_at,
    updated_at: document.updated_at,
    read_only: true,
    role,
  });
});

// PATCH /api/spaces/:spaceId/canvas — canvases are documents now: 410 for
// everyone signed in, chat member or not; the document's access alone
// decides whether the answer names it.
canvasRoutes.patch('/:spaceId/canvas', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');

  const canvas = await canvasDocumentFor(user.org_id, spaceId);
  if (canvas?.documentId && await documentRoleFor(user.id, user.org_id, canvas.documentId)) {
    return c.json({ ...CANVAS_MOVED, document_id: canvas.documentId }, 410);
  }
  return c.json(CANVAS_MOVED, 410);
});
