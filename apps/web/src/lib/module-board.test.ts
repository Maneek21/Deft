import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeModuleManifest, normalizeModuleRecordResponse } from './modules';
import { moduleBoardMovePayload } from './module-board';

const manifest = normalizeModuleManifest(JSON.parse(readFileSync(new URL('../../../../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8')));
const stage = manifest.collections.find((collection) => collection.key === 'deals')!.fields.find((field) => field.key === 'stage')!;
const record = normalizeModuleRecordResponse({ record: { id: 'deal-1', resource_id: 'module_record:deal-1', installation_id: 'i1', module_id: 'com.deft.contacts', collection_key: 'deals', data: { name: 'Pilot', stage: 'lead' }, revision: 7 } })!;

test('stage movement keeps the captured revision/digest and only patches the chosen field', () => {
  assert.deepEqual(moduleBoardMovePayload(record, stage, 'won', 'original-digest', 'intent-1'), {
    patch: { stage: 'won' }, unset_fields: [], expected_revision: 7, expected_manifest_digest: 'original-digest', idempotency_key: 'intent-1',
  });
  assert.equal(moduleBoardMovePayload(record, stage, 'lost', 'digest', 'intent').patch.stage, 'lost');
  assert.throws(() => moduleBoardMovePayload(record, stage, 'invented', 'digest', 'intent'), /available options/);
});

test('optional clears and false boolean moves preserve their distinct meanings', () => {
  const clear = moduleBoardMovePayload(record, { ...stage, required: false }, '', 'digest', 'intent');
  assert.deepEqual(clear.patch, {}); assert.deepEqual(clear.unset_fields, ['stage']);
  assert.throws(() => moduleBoardMovePayload(record, { ...stage, required: true }, '', 'digest', 'intent'), /required/);
  assert.deepEqual(moduleBoardMovePayload(record, { ...stage, key: 'qualified', type: 'boolean' }, 'false', 'digest', 'intent').patch, { qualified: false });
  assert.throws(() => moduleBoardMovePayload(record, { ...stage, type: 'relation' }, 'won', 'digest', 'intent'), /cannot be changed/);
});
