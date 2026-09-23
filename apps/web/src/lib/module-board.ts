import type { ModuleField, ModuleRecord } from './modules';

export function moduleBoardMovePayload(record: ModuleRecord, field: ModuleField, value: string, manifestDigest: string, idempotencyKey: string) {
  if (field.type !== 'single_select' && field.type !== 'boolean') throw new Error('This field cannot be changed from the board.');
  if (value === '' && field.required) throw new Error(`${field.label} is required.`);
  if (value !== '' && (field.type === 'boolean' ? !['true', 'false'].includes(value) : !field.options.some((option) => option.value === value))) throw new Error('Choose a value from the available options.');
  return {
    patch: value === '' ? {} : { [field.key]: field.type === 'boolean' ? value === 'true' : value },
    unset_fields: value === '' ? [field.key] : [],
    expected_revision: record.revision,
    expected_manifest_digest: manifestDigest,
    idempotency_key: idempotencyKey,
  };
}

export type ModuleBoardMove = (record: ModuleRecord, field: ModuleField, value: string, manifestDigest: string, idempotencyKey: string) => Promise<void>;
