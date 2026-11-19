import { sql } from 'drizzle-orm';
import { assertInstallationAccess } from '../module-access-policy.js';
import type { ExportContext } from './scope.js';
import type { Snapshot } from './snapshot.js';
import type { ArchiveWriter, JsonlFile } from './writer.js';
import type { DatasetSummary } from './format.js';

const SAFE_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Field types whose values are written from a record's data. Relations come from their own table. */
const DATA_FIELD_TYPES = new Set(['text', 'long_text', 'email', 'url', 'date', 'datetime', 'number', 'boolean',
  'single_select', 'multi_select', 'member', 'tags']);

type Field = { key: string; label: string; type: string; required: boolean; multiple: boolean | null;
  options: { value: string; label: string }[] | null; target_collection: string | null };
type Collection = { key: string; name: string; fields: Field[] };

const str = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * Reads a stored manifest's collections and their field definitions, named
 * property by property. Field defaults and anything else are left out.
 */
function collectionsOf(manifest: unknown): Collection[] {
  const raw = (manifest as { collections?: unknown })?.collections;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((collection): Collection[] => {
    const key = str(collection?.key);
    if (!key || !SAFE_KEY.test(key) || !Array.isArray(collection.fields)) return [];
    const fields = (collection.fields as unknown[]).flatMap((field: any): Field[] => {
      const fieldKey = str(field?.key);
      const type = str(field?.type);
      if (!fieldKey || !type) return [];
      return [{
        key: fieldKey, label: str(field.label) ?? fieldKey, type, required: field.required === true,
        multiple: typeof field.multiple === 'boolean' ? field.multiple : null,
        options: Array.isArray(field.options)
          ? field.options.flatMap((option: any) => (str(option?.value) ? [{ value: option.value, label: str(option.label) ?? option.value }] : []))
          : null,
        target_collection: str(field.target_collection),
      }];
    });
    return [{ key, name: str(collection.name) ?? key, fields }];
  });
}

type Installation = { id: string; module_id: string; slug: string; source: string; is_enabled: boolean; agent_access: 'none' | 'read' | 'write';
  active_version_id: string | null; version: string | null; created_at: Date };

/**
 * Installed modules (Contacts and any other): each module's collections and
 * fields, its records with only the fields its manifest declares, and its
 * record-to-record relations. The member scope reads a module only when the
 * product would let that member read it (assertInstallationAccess: no
 * guests, no disabled modules).
 */
export async function exportModules(snapshot: Snapshot, writer: ArchiveWriter, ctx: ExportContext): Promise<DatasetSummary[]> {
  const summaries: DatasetSummary[] = [];
  const installations = await snapshot.all<Installation>(sql`SELECT i.id, i.module_id, i.slug, i.source, i.is_enabled, i.agent_access,
      v.id AS active_version_id, v.version, i.created_at
    FROM module_installations i
    LEFT JOIN module_versions v ON v.installation_id = i.id AND v.org_id = i.org_id AND v.is_active = true
    WHERE i.org_id = ${ctx.orgId} AND i.is_deleted = false ORDER BY i.slug, i.id`);
  const members = new Set((await snapshot.all<{ user_id: string }>(sql`SELECT user_id FROM org_members WHERE org_id = ${ctx.orgId}`))
    .map((row) => row.user_id));
  const listed = await writer.jsonl('data/modules.jsonl');
  for (const installation of installations) {
    if (ctx.scope.kind === 'member') {
      try {
        assertInstallationAccess({ kind: 'human', org_id: ctx.orgId, actor_id: ctx.scope.user_id, role: ctx.scope.role, source: 'ui', scopes: [] },
          installation, 'read');
      } catch {
        continue;
      }
    }
    const folder = `data/modules/${SAFE_KEY.test(installation.slug) ? installation.slug : installation.id}`;
    // Field allowlists per manifest version, since each record was validated against its own version.
    const versions = new Map<string, Map<string, Collection>>();
    for (const version of await snapshot.all<{ id: string; manifest: unknown }>(sql`SELECT id, manifest FROM module_versions
        WHERE org_id = ${ctx.orgId} AND installation_id = ${installation.id}`)) {
      versions.set(version.id, new Map(collectionsOf(version.manifest).map((collection) => [collection.key, collection])));
    }
    const active = installation.active_version_id ? [...(versions.get(installation.active_version_id)?.values() ?? [])] : [];
    await writer.writeJson(`${folder}/schema.json`, { module_id: installation.module_id, slug: installation.slug, version: installation.version, collections: active });
    await listed.write({ id: installation.id, module_id: installation.module_id, slug: installation.slug, source: installation.source,
      is_enabled: installation.is_enabled, version: installation.version, folder, created_at: installation.created_at });

    // One collection file open at a time: records arrive ordered by collection.
    const open: { current: { key: string; file: JsonlFile } | null } = { current: null };
    const closeCurrent = async () => {
      if (!open.current) return;
      await open.current.file.close();
      summaries.push({ path: `${folder}/${open.current.key}.jsonl`, records: open.current.file.records });
      open.current = null;
    };
    for await (const record of snapshot.rows<{ id: string; collection_key: string; validated_version_id: string; data: Record<string, unknown>;
      revision: number; created_at: Date; updated_at: Date }>(sql`SELECT id, collection_key, validated_version_id, data, revision, created_at, updated_at
        FROM module_records WHERE org_id = ${ctx.orgId} AND installation_id = ${installation.id} AND is_deleted = false
        ORDER BY collection_key, created_at, id`)) {
      if (!SAFE_KEY.test(record.collection_key)) {
        await writer.omit({ kind: 'module_record', id: record.id, reason: 'Its collection name cannot be used as a file name.' });
        continue;
      }
      if (open.current?.key !== record.collection_key) {
        await closeCurrent();
        open.current = { key: record.collection_key, file: await writer.jsonl(`${folder}/${record.collection_key}.jsonl`) };
      }
      const target = open.current!;
      const collection = versions.get(record.validated_version_id)?.get(record.collection_key);
      const fields: Record<string, unknown> = {};
      for (const field of collection?.fields ?? []) {
        if (!DATA_FIELD_TYPES.has(field.type) || !(field.key in record.data)) continue;
        const value = record.data[field.key];
        fields[field.key] = field.type !== 'member' ? value
          : Array.isArray(value) ? value.filter((id) => typeof id === 'string' && members.has(id))
            : typeof value === 'string' && members.has(value) ? value : null;
      }
      await target.file.write({ id: record.id, collection: record.collection_key, revision: record.revision, fields,
        created_at: record.created_at, updated_at: record.updated_at });
    }
    await closeCurrent();

    const relations = await writer.jsonl(`${folder}/relations.jsonl`);
    for await (const relation of snapshot.rows(sql`SELECT r.field_key AS field, r.source_record_id, r.target_record_id, r.position, r.created_at
        FROM module_record_relations r
        JOIN module_records source ON source.id = r.source_record_id AND source.org_id = ${ctx.orgId} AND source.is_deleted = false
        JOIN module_records target ON target.id = r.target_record_id AND target.org_id = ${ctx.orgId} AND target.is_deleted = false
        WHERE r.org_id = ${ctx.orgId} AND r.installation_id = ${installation.id} AND r.is_deleted = false
          AND source.installation_id = ${installation.id} AND target.installation_id = ${installation.id}
        ORDER BY r.source_record_id, r.field_key, r.position, r.id`)) {
      await relations.write(relation);
    }
    await relations.close();
    summaries.push({ path: `${folder}/relations.jsonl`, records: relations.records });
  }
  await listed.close();
  return [{ path: 'data/modules.jsonl', records: listed.records }, ...summaries];
}
