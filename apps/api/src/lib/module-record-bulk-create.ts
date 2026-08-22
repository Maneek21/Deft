import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ModuleIdSchema,
  ModuleIdempotencyKeySchema,
  ModuleKeySchema,
  ModuleManifestDigestSchema,
  ModuleRecordDataSchema,
  type ModuleActor,
  type ModuleMutationResult,
} from '@deft/shared/modules';
import { createModuleRecord, preflightModuleMutation } from './module-service.js';

export const MODULE_RECORD_BULK_CREATE_ACTION = 'module_record_bulk_create' as const;
export const MAX_MODULE_BULK_CREATE_ROWS = 100;

export const ModuleRecordBulkCreateParamsSchema = z.strictObject({
  module_id: ModuleIdSchema,
  module_name: z.string().trim().min(1).max(160),
  collection_key: ModuleKeySchema,
  collection_name: z.string().trim().min(1).max(160),
  expected_manifest_digest: ModuleManifestDigestSchema,
  source_file_name: z.string().trim().min(1).max(255),
  rows: z.array(z.strictObject({ data: ModuleRecordDataSchema }))
    .min(1)
    .max(MAX_MODULE_BULK_CREATE_ROWS),
  idempotency_key: ModuleIdempotencyKeySchema,
});

export type ModuleRecordBulkCreateParams = z.infer<typeof ModuleRecordBulkCreateParamsSchema>;

export type ModuleRecordBulkCreateResult = {
  module_id: string;
  collection_key: string;
  requested: number;
  created: number;
  replayed: number;
  resource_ids: string[];
};

export class ModuleRecordBulkCreateError extends Error {
  constructor(
    message: string,
    public readonly progress: ModuleRecordBulkCreateResult & { failed_index: number },
  ) {
    super(message);
    this.name = 'ModuleRecordBulkCreateError';
  }
}

export function isModuleRecordBulkCreateAction(action: string): boolean {
  return action === MODULE_RECORD_BULK_CREATE_ACTION;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function moduleBulkCreateInputDigest(value: ModuleRecordBulkCreateParams): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stableValue({
      module_id: value.module_id,
      collection_key: value.collection_key,
      expected_manifest_digest: value.expected_manifest_digest,
      rows: value.rows,
    })))
    .digest('hex')}`;
}

function rowIdempotencyKey(input: ModuleRecordBulkCreateParams, index: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(stableValue({ batch: input.idempotency_key, index, row: input.rows[index] })))
    .digest('hex')
    .slice(0, 40);
  return `bulk-row:${digest}`;
}

export function sanitizeModuleBulkCreateParamsForHistory(value: unknown): Record<string, unknown> {
  const parsed = ModuleRecordBulkCreateParamsSchema.safeParse(value);
  if (!parsed.success) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of [
      'module_id',
      'module_name',
      'collection_key',
      'collection_name',
      'expected_manifest_digest',
      'source_file_name',
      'input_digest',
    ]) {
      if (typeof source[key] === 'string') safe[key] = source[key];
    }
    if (typeof source.row_count === 'number') safe.row_count = source.row_count;
    if (Array.isArray(source.changed_fields)) {
      safe.changed_fields = source.changed_fields.filter((field): field is string => typeof field === 'string');
    }
    return safe;
  }
  const changedFields = new Set<string>();
  for (const row of parsed.data.rows) {
    Object.keys(row.data).forEach((field) => changedFields.add(field));
  }
  return {
    module_id: parsed.data.module_id,
    module_name: parsed.data.module_name,
    collection_key: parsed.data.collection_key,
    collection_name: parsed.data.collection_name,
    expected_manifest_digest: parsed.data.expected_manifest_digest,
    source_file_name: parsed.data.source_file_name,
    row_count: parsed.data.rows.length,
    changed_fields: [...changedFields].sort(),
    input_digest: moduleBulkCreateInputDigest(parsed.data),
  };
}

export async function preflightModuleRecordBulkCreate(
  actor: ModuleActor,
  value: unknown,
): Promise<ModuleRecordBulkCreateParams> {
  const input = ModuleRecordBulkCreateParamsSchema.parse(value);
  for (const [index, row] of input.rows.entries()) {
    await preflightModuleMutation(actor, 'module_record_create', {
      module_id: input.module_id,
      collection_key: input.collection_key,
      data: row.data,
      expected_manifest_digest: input.expected_manifest_digest,
      idempotency_key: rowIdempotencyKey(input, index),
    });
  }
  return input;
}

export async function executeModuleRecordBulkCreate(
  actor: ModuleActor,
  value: unknown,
): Promise<ModuleRecordBulkCreateResult> {
  const input = ModuleRecordBulkCreateParamsSchema.parse(value);
  const mutations: ModuleMutationResult[] = [];
  for (const [index, row] of input.rows.entries()) {
    try {
      const created = await createModuleRecord(actor, {
        module_id: input.module_id,
        collection_key: input.collection_key,
        data: row.data,
        expected_manifest_digest: input.expected_manifest_digest,
        idempotency_key: rowIdempotencyKey(input, index),
      });
      mutations.push(created.mutation);
    } catch (error) {
      throw new ModuleRecordBulkCreateError(
        `Bulk import stopped at row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        {
          module_id: input.module_id,
          collection_key: input.collection_key,
          requested: input.rows.length,
          created: mutations.filter((mutation) => !mutation.replayed).length,
          replayed: mutations.filter((mutation) => mutation.replayed).length,
          resource_ids: mutations.map((mutation) => mutation.resource_id),
          failed_index: index,
        },
      );
    }
  }
  return {
    module_id: input.module_id,
    collection_key: input.collection_key,
    requested: input.rows.length,
    created: mutations.filter((mutation) => !mutation.replayed).length,
    replayed: mutations.filter((mutation) => mutation.replayed).length,
    resource_ids: mutations.map((mutation) => mutation.resource_id),
  };
}
