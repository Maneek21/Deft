import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  MODULE_LIMITS,
  ModuleExpectedRevisionSchema,
  ModuleFieldKeySchema,
  ModuleIdempotencyKeySchema,
  ModuleKeySchema,
  ModuleManifestDigestSchema,
  ModuleRecordDataSchema,
  ModuleSlugSchema,
  ModuleRecordArchiveRequestSchema,
} from '@deft/shared/modules';
import type { AuthUser } from '../middleware/auth.js';
import {
  archiveModuleRecord,
  createModuleRecord,
  getModuleInstallation,
  getModuleRecord,
  humanModuleActor,
  installBundledModule,
  listBundledModuleViews,
  listModuleInstallations,
  listModuleRecords,
  updateModuleInstallation,
  updateModuleRecord,
} from '../lib/module-service.js';
import { isModuleError, ModuleError } from '../lib/module-errors.js';

export const moduleRoutes = new Hono();

const lifecycleSchema = z.strictObject({
  enabled: z.boolean().optional(),
  agent_access: z.enum(['none', 'read', 'write']).optional(),
}).refine(
  (value) => value.enabled !== undefined || value.agent_access !== undefined,
  'At least one module setting is required',
);

const createBodySchema = z.strictObject({
  collection_key: ModuleKeySchema,
  data: ModuleRecordDataSchema,
  expected_manifest_digest: ModuleManifestDigestSchema,
  idempotency_key: ModuleIdempotencyKeySchema,
});

// Zod 4 deliberately rejects `.omit()` on a schema with refinements. Keep the
// route body schema explicit so importing this router cannot throw, while
// preserving the shared update contract's cross-field checks.
const updateBodySchema = z
  .strictObject({
    patch: ModuleRecordDataSchema.default({}),
    unset_fields: z.array(ModuleFieldKeySchema).max(MODULE_LIMITS.fields_per_collection).default([]),
    expected_revision: ModuleExpectedRevisionSchema,
    expected_manifest_digest: ModuleManifestDigestSchema,
    idempotency_key: ModuleIdempotencyKeySchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (Object.keys(input.patch).length === 0 && input.unset_fields.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'Update must patch or unset at least one field',
      });
    }
    const seen = new Set<string>();
    input.unset_fields.forEach((field, index) => {
      if (seen.has(field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unset_fields', index],
          message: `Unset fields must not contain duplicates: ${field}`,
        });
      }
      seen.add(field);
      if (Object.hasOwn(input.patch, field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unset_fields', index],
          message: `Field cannot be patched and unset in the same update: ${field}`,
        });
      }
    });
  });
const archiveBodySchema = ModuleRecordArchiveRequestSchema.omit({ record_id: true });

function actorFromContext(c: Context) {
  const user = c.get('user') as AuthUser;
  return humanModuleActor({
    orgId: user.org_id,
    userId: user.id,
    role: user.role ?? 'member',
    source: 'rest',
  });
}

function moduleFailure(c: Context, error: unknown) {
  if (isModuleError(error)) {
    return c.json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    }, error.status);
  }
  if (error instanceof z.ZodError) {
    return c.json({
      error: 'Invalid module request',
      code: 'VALIDATION_ERROR',
      details: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    }, 400);
  }
  console.error('[modules] request failed:', error);
  return c.json({ error: 'Module request failed', code: 'INTERNAL_ERROR' }, 500);
}

moduleRoutes.get('/', async (c) => {
  try {
    const actor = actorFromContext(c);
    const includeDisabled = actor.kind === 'human' && (actor.role === 'owner' || actor.role === 'admin');
    return c.json({ modules: await listModuleInstallations(actor, { includeDisabled }) });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/bundled', async (c) => {
  try {
    return c.json({ modules: await listBundledModuleViews(actorFromContext(c)) });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.post('/bundled/:slug/install', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const module = await installBundledModule(actorFromContext(c), slug);
    return c.json({ module }, 201);
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const module = await getModuleInstallation(
      actorFromContext(c),
      { slug },
      { allowDisabledForAdmin: true },
    );
    return c.json({ module });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.patch('/:slug', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const body = lifecycleSchema.parse(await c.req.json().catch(() => null));
    return c.json({ module: await updateModuleInstallation(actorFromContext(c), slug, body) });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug/records', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const collectionKey = ModuleKeySchema.parse(c.req.query('collection_key'));
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? 25 : z.coerce.number().int().min(1).max(100).parse(limitRaw);
    const cursor = c.req.query('cursor');
    const installation = await getModuleInstallation(actor, { slug });
    const page = await listModuleRecords(actor, {
      module_id: installation.module_id,
      collection_key: collectionKey,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json(page);
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.post('/:slug/records', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const body = createBodySchema.parse(await c.req.json().catch(() => null));
    const installation = await getModuleInstallation(actor, { slug });
    const result = await createModuleRecord(actor, {
      module_id: installation.module_id,
      ...body,
    });
    return c.json(result, result.replayed ? 200 : 201);
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug/records/:recordId', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const installation = await getModuleInstallation(actor, { slug });
    const record = await getModuleRecord(actor, c.req.param('recordId'));
    if (record.installation_id !== installation.id) {
      throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    }
    return c.json({ record });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.patch('/:slug/records/:recordId', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const installation = await getModuleInstallation(actor, { slug });
    const body = updateBodySchema.parse(await c.req.json().catch(() => null));
    return c.json(await updateModuleRecord(
      actor,
      { record_id: c.req.param('recordId'), ...body },
      { expectedInstallationId: installation.id },
    ));
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.delete('/:slug/records/:recordId', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const installation = await getModuleInstallation(actor, { slug });
    const body = archiveBodySchema.parse(await c.req.json().catch(() => null));
    return c.json(await archiveModuleRecord(
      actor,
      { record_id: c.req.param('recordId'), ...body },
      { expectedInstallationId: installation.id },
    ));
  } catch (error) {
    return moduleFailure(c, error);
  }
});
