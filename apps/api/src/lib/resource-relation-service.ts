import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  auditLog,
  resourceRelationEdges,
  resourceRelationReceipts,
  resourceRelationSets,
} from '@deft/db/schema';
import {
  RESOURCE_CONTRACT_VERSIONS,
  ResourceRefV1Schema,
  ResourceRelationListInputV1Schema,
  ResourceRelationListResultV1Schema,
  ResourceRelationReplaceInputV1Schema,
  ResourceRelationReplaceResultV1Schema,
  resourceRefIdentity,
  type ModuleResourceRefV1,
  type ResourceRefV1,
  type ResourceRelationErrorCode,
  type ResourceRelationListResultV1,
  type ResourceRelationReplaceInputV1,
  type ResourceRelationReplaceResultV1,
} from '@deft/shared/resources';
import type { ModuleActor, ModuleFieldV2 } from '@deft/shared/modules';
import { db } from './db.js';
import {
  resolveModuleRelationEndpointWithExecutor,
  type ModuleRelationEndpoint,
} from './module-service.js';
import { isModuleError } from './module-errors.js';
import {
  isResourceAuthorizationError,
  ResourceAuthorizationError,
} from './resource-authorization.js';
import { resourceAuthorizationService } from './resource-provider-adapters.js';

export class ResourceRelationError extends Error {
  constructor(
    message: string,
    readonly code: ResourceRelationErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 500,
  ) {
    super(message);
    this.name = 'ResourceRelationError';
  }
}

function moduleRef(ref: ResourceRefV1): ref is ModuleResourceRefV1 {
  return ref.provider.kind === 'module';
}

function actorContext(actor: ModuleActor): { org_id: string; actor: ModuleActor } {
  return { org_id: actor.org_id, actor };
}

function refTuple(ref: ResourceRefV1) {
  return {
    provider_kind: ref.provider.kind,
    provider_instance_id: ref.provider.provider_instance_id,
    resource_type: ref.resource_type,
    resource_id: ref.resource_id,
  };
}

function rowRef(row: {
  target_provider_kind: string;
  target_provider_instance_id: string;
  target_resource_type: string;
  target_resource_id: string;
}): ResourceRefV1 {
  return ResourceRefV1Schema.parse({
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: {
      kind: row.target_provider_kind,
      provider_instance_id: row.target_provider_instance_id,
    },
    resource_type: row.target_resource_type,
    resource_id: row.target_resource_id,
  });
}

function digestInput(input: ResourceRelationReplaceInputV1): string {
  const { idempotency_key: _idempotencyKey, ...stable } = input;
  return `sha256:${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

function relationFailure(error: unknown): never {
  if (error instanceof ResourceRelationError) throw error;
  if (error instanceof ResourceAuthorizationError || isModuleError(error)) {
    const denied = (
      (isResourceAuthorizationError(error) && error.code === 'RESOURCE_ACCESS_DENIED')
      || (isModuleError(error) && (error.code === 'MODULE_ACCESS_DENIED' || error.code === 'MODULE_SCOPE_REQUIRED'))
    );
    throw new ResourceRelationError(
      denied ? 'Resource relation access denied' : 'Resource relation endpoint is unavailable',
      denied ? 'RESOURCE_RELATION_ACCESS_DENIED' : 'RESOURCE_RELATION_NOT_FOUND',
      denied ? 403 : 404,
    );
  }
  throw new ResourceRelationError('Resource relation operation failed safely', 'RESOURCE_RELATION_FAILURE', 500);
}

function assertActor(actor: ModuleActor, input: ResourceRelationReplaceInputV1): void {
  if (actor.org_id.trim().length === 0) {
    throw new ResourceRelationError('Resource relation actor is invalid', 'RESOURCE_RELATION_INVALID', 400);
  }
  if (!moduleRef(input.source)) {
    throw new ResourceRelationError(
      'Only Module resources can own Module v2 relation fields',
      'RESOURCE_RELATION_OPERATION_UNSUPPORTED',
      400,
    );
  }
  if (input.refs.some((ref) => !moduleRef(ref))) {
    throw new ResourceRelationError(
      'This Module v2 relation field accepts Module resources only',
      'RESOURCE_RELATION_OPERATION_UNSUPPORTED',
      400,
    );
  }
}

async function preflight(actor: ModuleActor, input: ResourceRelationReplaceInputV1): Promise<void> {
  await resourceAuthorizationService.resolve(actorContext(actor), input.source);
  for (const ref of input.refs) {
    await resourceAuthorizationService.resolve(actorContext(actor), ref);
  }
}

function relationField(source: ModuleRelationEndpoint, relationKey: string) {
  if (source.installation.manifest.schema_version !== '2') {
    throw new ResourceRelationError(
      'Resource relation fields require Module manifest schema version 2',
      'RESOURCE_RELATION_OPERATION_UNSUPPORTED',
      400,
    );
  }
  const collection = source.installation.manifest.collections.find(
    (item) => item.key === source.ref.resource_type,
  );
  const field = (collection?.fields as ModuleFieldV2[] | undefined)?.find(
    (item) => item.key === relationKey,
  );
  if (!field || field.type !== 'resource_ref') {
    throw new ResourceRelationError('Resource relation field not found', 'RESOURCE_RELATION_NOT_FOUND', 404);
  }
  return field;
}

async function lockedModuleEndpoints(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actor: ModuleActor,
  input: ResourceRelationReplaceInputV1,
): Promise<Map<string, ModuleRelationEndpoint>> {
  const unique = new Map<string, ModuleResourceRefV1>();
  unique.set(resourceRefIdentity(input.source), input.source as ModuleResourceRefV1);
  for (const ref of input.refs) unique.set(resourceRefIdentity(ref), ref as ModuleResourceRefV1);
  const ordered = [...unique.values()].sort((left, right) => (
    resourceRefIdentity(left).localeCompare(resourceRefIdentity(right))
  ));
  const endpoints = new Map<string, ModuleRelationEndpoint>();
  for (const ref of ordered) {
    const endpoint = await resolveModuleRelationEndpointWithExecutor(
      tx,
      actor,
      ref,
      resourceRefIdentity(ref) === resourceRefIdentity(input.source) ? 'write' : 'read',
    );
    endpoints.set(resourceRefIdentity(ref), endpoint);
  }
  return endpoints;
}

export async function replaceResourceRelation(
  actor: ModuleActor,
  inputValue: unknown,
): Promise<ResourceRelationReplaceResultV1> {
  const parsed = ResourceRelationReplaceInputV1Schema.safeParse(inputValue);
  if (!parsed.success) {
    throw new ResourceRelationError('Resource relation input is invalid', 'RESOURCE_RELATION_INVALID', 400);
  }
  const input = parsed.data;
  assertActor(actor, input);
  try {
    await preflight(actor, input);
    const inputDigest = digestInput(input);
    return await db.transaction(async (tx) => {
      const sourceLockDigest = createHash('sha256')
        .update(resourceRefIdentity(input.source))
        .digest('hex');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${[
        'resource-relation',
        actor.org_id,
        sourceLockDigest,
        input.relation_key,
      ].join(':')}, 0))`);

      const endpoints = await lockedModuleEndpoints(tx, actor, input);
      const source = endpoints.get(resourceRefIdentity(input.source));
      if (!source) throw new Error('Locked source endpoint is missing');
      const field = relationField(source, input.relation_key);
      if (!field.multiple && input.refs.length > 1) {
        throw new ResourceRelationError('Resource relation accepts one target', 'RESOURCE_RELATION_INVALID', 400);
      }
      for (const ref of input.refs) {
        const endpoint = endpoints.get(resourceRefIdentity(ref));
        if (
          !endpoint
          || endpoint.installation.module_id !== field.target.module_id
          || ref.resource_type !== field.target.resource_type
        ) {
          throw new ResourceRelationError(
            'Resource relation target does not match the declared interface',
            'RESOURCE_RELATION_TARGET_MISMATCH',
            400,
          );
        }
      }

      const [receipt] = await tx
        .select()
        .from(resourceRelationReceipts)
        .where(and(
          eq(resourceRelationReceipts.org_id, actor.org_id),
          eq(resourceRelationReceipts.actor_type, actor.kind),
          eq(resourceRelationReceipts.actor_id, actor.actor_id),
          eq(resourceRelationReceipts.operation, 'replace'),
          eq(resourceRelationReceipts.idempotency_key, input.idempotency_key),
        ))
        .limit(1);
      if (receipt) {
        if (receipt.input_digest !== inputDigest) {
          throw new ResourceRelationError(
            'Idempotency key was used for a different relation mutation',
            'RESOURCE_RELATION_IDEMPOTENCY_CONFLICT',
            409,
          );
        }
        return ResourceRelationReplaceResultV1Schema.parse({
          schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
          source: input.source,
          relation_key: input.relation_key,
          revision: receipt.result_revision,
          refs: receipt.result_refs,
          replayed: true,
        });
      }

      const sourceTuple = refTuple(input.source);
      const identity = and(
        eq(resourceRelationSets.org_id, actor.org_id),
        eq(resourceRelationSets.source_provider_kind, sourceTuple.provider_kind),
        eq(resourceRelationSets.source_provider_instance_id, sourceTuple.provider_instance_id),
        eq(resourceRelationSets.source_resource_type, sourceTuple.resource_type),
        eq(resourceRelationSets.source_resource_id, sourceTuple.resource_id),
        eq(resourceRelationSets.relation_key, input.relation_key),
      );
      let setQuery = tx.select().from(resourceRelationSets).where(identity).limit(1);
      if ('for' in setQuery) {
        setQuery = (setQuery as typeof setQuery & { for: (strength: 'update') => typeof setQuery }).for('update');
      }
      const [existing] = await setQuery;
      if ((existing?.revision ?? 0) !== input.expected_revision) {
        throw new ResourceRelationError(
          'Resource relation changed since it was read',
          'RESOURCE_RELATION_REVISION_CONFLICT',
          409,
        );
      }
      const nextRevision = input.expected_revision + 1;
      const now = new Date();
      const set = existing
        ? (await tx.update(resourceRelationSets).set({
            revision: nextRevision,
            updated_by_actor_type: actor.kind,
            updated_by_actor_id: actor.actor_id,
            updated_at: now,
          }).where(and(identity, eq(resourceRelationSets.revision, input.expected_revision))).returning())[0]
        : (await tx.insert(resourceRelationSets).values({
            id: randomUUID(),
            org_id: actor.org_id,
            source_provider_kind: sourceTuple.provider_kind,
            source_provider_instance_id: sourceTuple.provider_instance_id,
            source_resource_type: sourceTuple.resource_type,
            source_resource_id: sourceTuple.resource_id,
            relation_key: input.relation_key,
            revision: nextRevision,
            updated_by_actor_type: actor.kind,
            updated_by_actor_id: actor.actor_id,
          }).returning())[0];
      if (!set) {
        throw new ResourceRelationError(
          'Resource relation changed since it was read',
          'RESOURCE_RELATION_REVISION_CONFLICT',
          409,
        );
      }

      await tx.update(resourceRelationEdges).set({
        is_deleted: true,
        deleted_at: now,
        updated_at: now,
      }).where(and(
        eq(resourceRelationEdges.org_id, actor.org_id),
        eq(resourceRelationEdges.relation_set_id, set.id),
        eq(resourceRelationEdges.is_deleted, false),
      ));
      if (input.refs.length > 0) {
        await tx.insert(resourceRelationEdges).values(input.refs.map((ref, position) => {
          const target = refTuple(ref);
          return {
            id: randomUUID(),
            org_id: actor.org_id,
            relation_set_id: set.id,
            target_provider_kind: target.provider_kind,
            target_provider_instance_id: target.provider_instance_id,
            target_resource_type: target.resource_type,
            target_resource_id: target.resource_id,
            position,
            created_by_actor_type: actor.kind,
            created_by_actor_id: actor.actor_id,
          };
        }));
      }
      await tx.insert(resourceRelationReceipts).values({
        id: randomUUID(),
        org_id: actor.org_id,
        relation_set_id: set.id,
        actor_type: actor.kind,
        actor_id: actor.actor_id,
        operation: 'replace',
        idempotency_key: input.idempotency_key,
        input_digest: inputDigest,
        result_revision: nextRevision,
        result_refs: input.refs,
      });
      await tx.insert(auditLog).values({
        org_id: actor.org_id,
        actor_type: actor.kind,
        actor_id: actor.actor_id,
        action: 'resource_relation.replace',
        entity_type: 'resource_relation_set',
        entity_id: set.id,
        before_state: { revision: existing?.revision ?? 0 },
        after_state: { revision: nextRevision, target_count: input.refs.length },
        metadata: { relation_key: input.relation_key },
      });
      return ResourceRelationReplaceResultV1Schema.parse({
        schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
        source: input.source,
        relation_key: input.relation_key,
        revision: nextRevision,
        refs: input.refs,
        replayed: false,
      });
    });
  } catch (error) {
    return relationFailure(error);
  }
}

export async function listResourceRelation(
  actor: ModuleActor,
  inputValue: unknown,
): Promise<ResourceRelationListResultV1> {
  const parsed = ResourceRelationListInputV1Schema.safeParse(inputValue);
  if (!parsed.success) {
    throw new ResourceRelationError('Resource relation input is invalid', 'RESOURCE_RELATION_INVALID', 400);
  }
  const source = parsed.data.source;
  try {
    await resourceAuthorizationService.resolve(actorContext(actor), source);
    const tuple = refTuple(source);
    const [set] = await db.select().from(resourceRelationSets).where(and(
      eq(resourceRelationSets.org_id, actor.org_id),
      eq(resourceRelationSets.source_provider_kind, tuple.provider_kind),
      eq(resourceRelationSets.source_provider_instance_id, tuple.provider_instance_id),
      eq(resourceRelationSets.source_resource_type, tuple.resource_type),
      eq(resourceRelationSets.source_resource_id, tuple.resource_id),
      eq(resourceRelationSets.relation_key, parsed.data.relation_key),
    )).limit(1);
    const edges = set
      ? await db.select().from(resourceRelationEdges).where(and(
          eq(resourceRelationEdges.org_id, actor.org_id),
          eq(resourceRelationEdges.relation_set_id, set.id),
          eq(resourceRelationEdges.is_deleted, false),
        )).orderBy(asc(resourceRelationEdges.position))
      : [];
    const items: ResourceRelationListResultV1['items'] = [];
    for (const edge of edges) {
      const ref = rowRef(edge);
      try {
        const resource = await resourceAuthorizationService.resolve(actorContext(actor), ref);
        items.push({ state: 'available', ref, resource });
      } catch (error) {
        if (!isResourceAuthorizationError(error) || error.code === 'RESOURCE_PROVIDER_FAILURE') throw error;
        items.push({ state: 'unavailable', ref });
      }
    }
    return ResourceRelationListResultV1Schema.parse({
      schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
      source,
      relation_key: parsed.data.relation_key,
      revision: set?.revision ?? 0,
      items,
    });
  } catch (error) {
    return relationFailure(error);
  }
}

export async function linkResourceRelation(
  actor: ModuleActor,
  input: Omit<ResourceRelationReplaceInputV1, 'schema_version' | 'refs'> & { ref: ResourceRefV1 },
): Promise<ResourceRelationReplaceResultV1> {
  const current = await listResourceRelation(actor, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: input.source,
    relation_key: input.relation_key,
  });
  return replaceResourceRelation(actor, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: input.source,
    relation_key: input.relation_key,
    refs: [...current.items.map((item) => item.ref), input.ref],
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
  });
}

export async function unlinkResourceRelation(
  actor: ModuleActor,
  input: Omit<ResourceRelationReplaceInputV1, 'schema_version' | 'refs'> & { ref: ResourceRefV1 },
): Promise<ResourceRelationReplaceResultV1> {
  const current = await listResourceRelation(actor, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: input.source,
    relation_key: input.relation_key,
  });
  return replaceResourceRelation(actor, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: input.source,
    relation_key: input.relation_key,
    refs: current.items.map((item) => item.ref).filter(
      (ref) => resourceRefIdentity(ref) !== resourceRefIdentity(input.ref),
    ),
    expected_revision: input.expected_revision,
    idempotency_key: input.idempotency_key,
  });
}
