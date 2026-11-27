// Folders in drives (spec 5.1; plan Task F5). Folders only organise and carry
// no access of their own: creating, changing and deleting one needs edit on
// its drive, and a drive the caller can't see is a 404. Deleting a folder
// moves its contents up to its parent folder, or to the drive root. DELETE
// takes no body: a malformed one is a 400 before anything changes. The rules
// and the lock order are in lib/documents.ts.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { DocFolderRow } from '@deft/db/documents';
import { createFolder, deleteFolder, DocumentRefusal, updateFolder } from '../lib/documents.js';
import { jsonBody, noBodyOrJson } from '../lib/request-body.js';

export const docFolderRoutes = new Hono();

const idSchema = z.string().trim().min(1).max(200);
const nameSchema = z.string().trim().min(1).max(200);
const createSchema = z.object({
  drive_id: idSchema,
  parent_folder_id: idSchema.nullable().optional(),
  name: nameSchema,
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  parent_folder_id: idSchema.nullable().optional(),
  position: z.number().finite().optional(),
}).strict();

function invalid(c: Context) {
  return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
}

/** A refusal from lib/documents.ts, or a 500 whose log line is fixed text, never a request value. */
function failed(c: Context, error: unknown, what: string) {
  if (error instanceof DocumentRefusal) return c.json({ error: error.message, code: error.code }, error.status);
  console.error('[doc-folders] a folder request failed');
  return c.json({ error: `Failed to ${what}`, code: 'INTERNAL_ERROR' }, 500);
}

function folderShape(row: DocFolderRow) {
  return {
    id: row.id,
    drive_id: row.drive_id,
    parent_folder_id: row.parent_folder_id,
    name: row.name,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// POST /api/doc-folders { drive_id, parent_folder_id?, name } (needs edit on the drive).
docFolderRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const parsed = createSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const folder = await createFolder({
      orgId: user.org_id, userId: user.id, driveId: parsed.data.drive_id, parentFolderId: parsed.data.parent_folder_id, name: parsed.data.name,
    });
    return c.json({ folder: folderShape(folder) }, 201);
  } catch (error) {
    return failed(c, error, 'create the folder');
  }
});

// PATCH /api/doc-folders/:id { name?, parent_folder_id?, position? } (needs edit on the drive).
docFolderRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const parsed = updateSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const folder = await updateFolder({
      orgId: user.org_id, userId: user.id, folderId: c.req.param('id'), name: parsed.data.name,
      parentFolderId: parsed.data.parent_folder_id, position: parsed.data.position,
    });
    return c.json({ folder: folderShape(folder) });
  } catch (error) {
    return failed(c, error, 'update the folder');
  }
});

// DELETE /api/doc-folders/:id (needs edit on the drive).
docFolderRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!(await noBodyOrJson(c))) return invalid(c);
    await deleteFolder({ orgId: user.org_id, userId: user.id, folderId: c.req.param('id') });
    return c.json({ success: true });
  } catch (error) {
    return failed(c, error, 'delete the folder');
  }
});
