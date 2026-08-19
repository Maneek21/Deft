import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ModuleRecordResourceIdSchema, ModuleSlugSchema } from '@deft/shared/modules';
import type { AuthUser } from '../middleware/auth.js';
import { humanModuleActor } from '../lib/module-service.js';
import { isModuleError } from '../lib/module-errors.js';
import {
  linkModuleRecordToTask,
  listModuleRecordTaskLinks,
  listTaskModuleRecordLinks,
  ModuleTaskLinkError,
  unlinkModuleRecordFromTask,
} from '../lib/module-task-links.js';

export const moduleTaskLinkRoutes = new Hono();

const linkBodySchema = z.strictObject({
  resource_id: ModuleRecordResourceIdSchema,
});

function actorFromContext(c: Context) {
  const user = c.get('user') as AuthUser;
  return humanModuleActor({
    orgId: user.org_id,
    userId: user.id,
    role: user.role ?? 'member',
    source: 'rest',
  });
}

function failure(c: Context, error: unknown) {
  if (isModuleError(error) || error instanceof ModuleTaskLinkError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError) {
    return c.json({
      error: 'Invalid module task link request',
      code: 'VALIDATION_ERROR',
      details: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    }, 400);
  }
  console.error('[module-task-links] request failed:', error);
  return c.json({ error: 'Module task link request failed', code: 'INTERNAL_ERROR' }, 500);
}

moduleTaskLinkRoutes.get('/tasks/:taskId/module-records', async (c) => {
  try {
    return c.json({ links: await listTaskModuleRecordLinks(actorFromContext(c), c.req.param('taskId')) });
  } catch (error) {
    return failure(c, error);
  }
});

moduleTaskLinkRoutes.post('/tasks/:taskId/module-records', async (c) => {
  try {
    const body = linkBodySchema.parse(await c.req.json().catch(() => null));
    const result = await linkModuleRecordToTask(
      actorFromContext(c),
      c.req.param('taskId'),
      body.resource_id,
    );
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    return failure(c, error);
  }
});

moduleTaskLinkRoutes.delete('/tasks/:taskId/module-records/:recordId', async (c) => {
  try {
    const result = await unlinkModuleRecordFromTask(actorFromContext(c), c.req.param('taskId'), c.req.param('recordId'));
    return c.json({ success: true, ...result });
  } catch (error) {
    return failure(c, error);
  }
});

moduleTaskLinkRoutes.get('/modules/:slug/records/:recordId/tasks', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    return c.json({
      links: await listModuleRecordTaskLinks(actorFromContext(c), slug, c.req.param('recordId')),
    });
  } catch (error) {
    return failure(c, error);
  }
});
