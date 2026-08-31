import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  MODULE_LIMITS,
  ModuleExpectedRevisionSchema,
  ModuleFieldKeySchema,
  ModuleIdempotencyKeySchema,
  ModuleKeySchema,
  ModuleManifestDigestSchema,
  ModuleRelationPatchSchema,
  ModuleRelationReplaceRequestSchema,
  ModuleRecordDataSchema,
  ModuleRecordQueryRequestSchema,
  ModuleSavedViewCreateRequestSchema,
  ModuleSavedViewUpdateRequestSchema,
  ModuleSlugSchema,
  ModuleRecordArchiveRequestSchema,
} from '@deft/shared/modules';
import type { AuthUser } from '../middleware/auth.js';
import {
  RESOURCE_CONTRACT_VERSIONS,
  ResourceRelationReplaceInputV1Schema,
  type ModuleResourceRefV1,
} from '@deft/shared/resources';
import {
  archiveModuleRecord,
  createModuleSavedView,
  createModuleRecord,
  deleteModuleSavedView,
  getModuleRecordRelations,
  getModuleInstallation,
  getModuleRecord,
  humanModuleActor,
  installBundledModule,
  installModuleFromManifest,
  listBundledModuleViews,
  listModuleInstallations,
  listModuleNavigation,
  listModuleRecords,
  listModuleRecordReferences,
  listModuleSavedViews,
  queryModuleRecords,
  replaceModuleRecordRelations,
  updateBundledModule,
  upgradeModuleInstallationToManifest,
  updateModuleInstallation,
  updateModuleRecord,
  updateModuleSavedView,
} from '../lib/module-service.js';
import { isModuleError, ModuleError } from '../lib/module-errors.js';
import { parseModuleManifestUpload } from '../lib/module-manifest-upload.js';
import {
  listResourceRelation,
  replaceResourceRelation,
  ResourceRelationError,
} from '../lib/resource-relation-service.js';
import { resourceAuthorizationService } from '../lib/resource-provider-adapters.js';

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
    relations: ModuleRelationPatchSchema.default({}),
    expected_revision: ModuleExpectedRevisionSchema,
    expected_manifest_digest: ModuleManifestDigestSchema,
    idempotency_key: ModuleIdempotencyKeySchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      Object.keys(input.patch).length === 0
      && input.unset_fields.length === 0
      && Object.keys(input.relations).length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'Update must patch, unset, or replace at least one field',
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
const recordQueryBodySchema = ModuleRecordQueryRequestSchema.omit({ module_id: true });
const resourceRelationReplaceBodySchema = z.strictObject({
  refs: ResourceRelationReplaceInputV1Schema.shape.refs,
  expected_revision: ResourceRelationReplaceInputV1Schema.shape.expected_revision,
  idempotency_key: ResourceRelationReplaceInputV1Schema.shape.idempotency_key,
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

function moduleManagerFromContext(c: Context) {
  const actor = actorFromContext(c);
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new ModuleError(
      'Only workspace owners and admins can manage modules',
      'MODULE_ACCESS_DENIED',
      403,
    );
  }
  return actor;
}

function moduleFailure(c: Context, error: unknown) {
  if (error instanceof ResourceRelationError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
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

function moduleResourceRef(
  installationId: string,
  resourceType: string,
  resourceId: string,
): ModuleResourceRefV1 {
  return {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module', provider_instance_id: installationId },
    resource_type: resourceType,
    resource_id: resourceId,
  };
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

moduleRoutes.get('/navigation', async (c) => {
  try {
    return c.json({ modules: await listModuleNavigation(actorFromContext(c)) });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.post('/sideload', async (c) => {
  try {
    const actor = moduleManagerFromContext(c);
    const upload = await parseModuleManifestUpload(c.req.raw);
    const module = await installModuleFromManifest(actor, upload.manifest, { source: 'sideloaded' });
    return c.json({ module }, 201);
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.post('/:slug/upgrade', async (c) => {
  try {
    const actor = moduleManagerFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const upload = await parseModuleManifestUpload(c.req.raw, { requireExpectedActiveDigest: true });
    return c.json({
      module: await upgradeModuleInstallationToManifest(actor, slug, upload.manifest, {
        source: 'sideloaded',
        expected_active_manifest_digest: upload.expected_active_digest,
      }),
    });
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

moduleRoutes.post('/bundled/:slug/update', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    return c.json({ module: await updateBundledModule(actorFromContext(c), slug) });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug/saved-views', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const collectionKey = c.req.query('collection_key');
    return c.json({
      views: await listModuleSavedViews(
        actorFromContext(c),
        slug,
        collectionKey ? ModuleKeySchema.parse(collectionKey) : undefined,
      ),
    });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.post('/:slug/saved-views', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const body = ModuleSavedViewCreateRequestSchema.parse(await c.req.json().catch(() => null));
    return c.json({ view: await createModuleSavedView(actorFromContext(c), slug, body) }, 201);
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.patch('/:slug/saved-views/:viewId', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const body = ModuleSavedViewUpdateRequestSchema.parse(await c.req.json().catch(() => null));
    return c.json({
      view: await updateModuleSavedView(actorFromContext(c), slug, c.req.param('viewId'), body),
    });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.delete('/:slug/saved-views/:viewId', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    await deleteModuleSavedView(actorFromContext(c), slug, c.req.param('viewId'));
    return c.body(null, 204);
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug/references', async (c) => {
  try {
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const collectionKey = ModuleKeySchema.parse(c.req.query('collection_key'));
    const idsRaw = c.req.query('ids');
    const ids = idsRaw === undefined
      ? undefined
      : ModuleRelationReplaceRequestSchema.shape.record_ids.parse(
        idsRaw.split(',').filter(Boolean),
      );
    return c.json({
      references: await listModuleRecordReferences(
        actorFromContext(c),
        slug,
        collectionKey,
        ids,
      ),
    });
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

moduleRoutes.post('/:slug/records/query', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const body = recordQueryBodySchema.parse(await c.req.json().catch(() => null));
    const installation = await getModuleInstallation(actor, { slug });
    return c.json(await queryModuleRecords(actor, {
      module_id: installation.module_id,
      ...body,
    }));
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

moduleRoutes.get('/:slug/records/:recordId/relations', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const installation = await getModuleInstallation(actor, { slug });
    return c.json({
      relations: await getModuleRecordRelations(actor, c.req.param('recordId'), {
        expectedInstallationId: installation.id,
      }),
    });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.put('/:slug/records/:recordId/relations/:fieldKey', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const installation = await getModuleInstallation(actor, { slug });
    const fieldKey = ModuleFieldKeySchema.parse(c.req.param('fieldKey'));
    const body = ModuleRelationReplaceRequestSchema.parse(await c.req.json().catch(() => null));
    return c.json({
      relation: await replaceModuleRecordRelations(
        actor,
        c.req.param('recordId'),
        fieldKey,
        body.record_ids,
        {
          expectedInstallationId: installation.id,
          expectedRevision: body.expected_revision,
          expectedManifestDigest: body.expected_manifest_digest,
          idempotencyKey: body.idempotency_key,
        },
      ),
    });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug/records/:recordId/resource-relations/:fieldKey', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const fieldKey = ModuleFieldKeySchema.parse(c.req.param('fieldKey'));
    const installation = await getModuleInstallation(actor, { slug });
    const record = await getModuleRecord(actor, c.req.param('recordId'));
    if (record.installation_id !== installation.id) {
      throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    }
    return c.json({
      relation: await listResourceRelation(actor, {
        schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
        source: moduleResourceRef(installation.id, record.collection_key, record.id),
        relation_key: fieldKey,
      }),
    });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.get('/:slug/records/:recordId/resource-relations/:fieldKey/options', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const fieldKey = ModuleFieldKeySchema.parse(c.req.param('fieldKey'));
    const query = z.string().trim().max(200).default('').parse(c.req.query('q') ?? '');
    const installation = await getModuleInstallation(actor, { slug });
    const record = await getModuleRecord(actor, c.req.param('recordId'));
    if (record.installation_id !== installation.id || installation.manifest.schema_version !== '2') {
      throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    }
    const collection = installation.manifest.collections.find((item) => item.key === record.collection_key);
    const field = collection?.fields.find((item) => item.key === fieldKey);
    if (!field || field.type !== 'resource_ref') {
      throw new ResourceRelationError('Resource relation field not found', 'RESOURCE_RELATION_NOT_FOUND', 404);
    }
    const target = await getModuleInstallation(actor, { moduleId: field.target.module_id });
    const references = await listModuleRecordReferences(
      actor,
      target.slug,
      field.target.resource_type,
    );
    const options = [];
    for (const reference of references) {
      if (query && !reference.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      options.push(await resourceAuthorizationService.resolve(
        { org_id: actor.org_id, actor },
        moduleResourceRef(target.id, field.target.resource_type, reference.id),
      ));
    }
    return c.json({ options });
  } catch (error) {
    return moduleFailure(c, error);
  }
});

moduleRoutes.put('/:slug/records/:recordId/resource-relations/:fieldKey', async (c) => {
  try {
    const actor = actorFromContext(c);
    const slug = ModuleSlugSchema.parse(c.req.param('slug'));
    const fieldKey = ModuleFieldKeySchema.parse(c.req.param('fieldKey'));
    const body = resourceRelationReplaceBodySchema.parse(await c.req.json().catch(() => null));
    const installation = await getModuleInstallation(actor, { slug });
    const record = await getModuleRecord(actor, c.req.param('recordId'));
    if (record.installation_id !== installation.id) {
      throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    }
    return c.json({
      relation: await replaceResourceRelation(actor, {
        schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
        source: moduleResourceRef(installation.id, record.collection_key, record.id),
        relation_key: fieldKey,
        refs: body.refs,
        expected_revision: body.expected_revision,
        idempotency_key: body.idempotency_key,
      }),
    });
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
