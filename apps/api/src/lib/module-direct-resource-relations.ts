import { and, asc, eq } from 'drizzle-orm';
import { moduleInstallations, moduleRecordRelations, moduleRecords, moduleVersions } from '@deft/db/schema';
import { RESOURCE_CONTRACT_VERSIONS, parseSupportedDeftModuleManifest, type ModuleResourceRefV1 } from '@deft/shared';
import type { db } from './db.js';

export type ModuleDirectResourceRelation = Readonly<{
  relation_key: string;
  revision: number;
  refs: ModuleResourceRefV1[];
}>;

/** Storage projection only. Callers must authorize source and every returned target.
 * Uses the caller's executor so prepared and live authority read the same transaction.
 * Existing direct relations use source revision; resource_ref fields remain separate.
 */
export async function readModuleDirectResourceRelations(
  executor: Pick<typeof db, 'select'>,
  orgId: string,
  source: ModuleResourceRefV1,
): Promise<ModuleDirectResourceRelation[]> {
  const [current] = await executor.select({
    manifest: moduleVersions.manifest,
    revision: moduleRecords.revision,
  }).from(moduleRecords).innerJoin(moduleInstallations, and(
    eq(moduleInstallations.org_id, moduleRecords.org_id),
    eq(moduleInstallations.id, moduleRecords.installation_id),
    eq(moduleInstallations.is_enabled, true),
    eq(moduleInstallations.is_deleted, false),
  )).innerJoin(moduleVersions, and(
    eq(moduleVersions.org_id, moduleRecords.org_id),
    eq(moduleVersions.installation_id, moduleRecords.installation_id),
    eq(moduleVersions.is_active, true),
  )).where(and(
    eq(moduleRecords.org_id, orgId),
    eq(moduleRecords.installation_id, source.provider.provider_instance_id),
    eq(moduleRecords.collection_key, source.resource_type),
    eq(moduleRecords.id, source.resource_id),
    eq(moduleRecords.is_deleted, false),
  )).limit(1);
  if (!current) return [];
  const manifest = parseSupportedDeftModuleManifest(current.manifest);
  const fields = manifest.collections.find((collection) => collection.key === source.resource_type)
    ?.fields.filter((field) => field.type === 'relation') ?? [];
  if (!fields.length) return [];
  const edges = await executor.select({
    field_key: moduleRecordRelations.field_key,
    target_id: moduleRecords.id,
    collection_key: moduleRecords.collection_key,
  }).from(moduleRecordRelations).innerJoin(moduleRecords, and(
    eq(moduleRecords.org_id, moduleRecordRelations.org_id),
    eq(moduleRecords.installation_id, moduleRecordRelations.installation_id),
    eq(moduleRecords.id, moduleRecordRelations.target_record_id),
    eq(moduleRecords.is_deleted, false),
  )).where(and(
    eq(moduleRecordRelations.org_id, orgId),
    eq(moduleRecordRelations.installation_id, source.provider.provider_instance_id),
    eq(moduleRecordRelations.source_record_id, source.resource_id),
    eq(moduleRecordRelations.is_deleted, false),
  )).orderBy(asc(moduleRecordRelations.position), asc(moduleRecordRelations.id));
  return fields.map((field) => ({
    relation_key: field.key,
    revision: current.revision,
    refs: edges.filter((edge) => edge.field_key === field.key && edge.collection_key === field.target_collection)
      .map((edge) => ({
        schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module' as const, provider_instance_id: source.provider.provider_instance_id },
        resource_type: edge.collection_key,
        resource_id: edge.target_id,
      })),
  }));
}
