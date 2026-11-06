import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  AppIntegrationToolDeclarationSchema,
  AppIntegrationToolsDeclarationSchema,
  AppIntegrationPrepareRecordMirrorInnerInputSchema,
  isValidAppIntegrationToolInnerInput,
} from '../src/app-integration-tools.js';

/** App-neutral review tool that nominates a saved record for a record mirror. */
function mirrorDeclaration() {
  return {
    key: 'draft_mirror',
    description: 'Nominate a saved record for a provider mirror.',
    operation: 'draft',
    mode: 'review',
    store_key: 'drafts',
    resource_key: 'inbox',
    runtime_requirement_key: 'sync_provider',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { account: { type: 'string' }, record_id: { type: 'string' } },
    },
    account_input_key: 'account',
    data_operations: ['record_read', 'prepare_record_mirror'],
    input_pins: [{ operation: 'prepare_record_mirror', outer_key: 'record_id', inner_field: 'record_id', required: true }],
    action_key: 'mirror_drafts',
    visibility: 'delegated_tools',
  } as const;
}

test('a delegated review tool may nominate a record mirror with a required record_id pin', () => {
  const parsed = AppIntegrationToolDeclarationSchema.parse(mirrorDeclaration());
  assert.ok(parsed.data_operations.includes('prepare_record_mirror'));
  assert.equal(parsed.action_key, 'mirror_drafts');
});

test('prepare_record_mirror is an effect and therefore only valid in review mode', () => {
  assert.equal(
    AppIntegrationToolDeclarationSchema.safeParse({ ...mirrorDeclaration(), mode: 'data' }).success,
    false,
    'an effect cannot be declared outside review mode',
  );
});

test('prepare_record_mirror requires an action_key', () => {
  const { action_key: _omitted, ...withoutAction } = mirrorDeclaration();
  assert.equal(
    AppIntegrationToolDeclarationSchema.safeParse(withoutAction).success,
    false,
    'an effect requires the runtime action_key it resolves',
  );
});

test('prepare_record_mirror requires a required record_id pin', () => {
  const { input_pins: _ignored, ...noPin } = mirrorDeclaration();
  assert.equal(
    AppIntegrationToolDeclarationSchema.safeParse({ ...noPin, input_pins: [] }).success,
    false,
    'a record_id pin is mandatory',
  );
  const optional = {
    ...mirrorDeclaration(),
    input_pins: [{ operation: 'prepare_record_mirror', outer_key: 'record_id', inner_field: 'record_id', required: false }],
  };
  assert.equal(AppIntegrationToolDeclarationSchema.safeParse(optional).success, false, 'the record_id pin must be required');
});

test('the inner input pins the store_key and the exact record, never a mirror name', () => {
  const recordId = randomUUID();
  const input = AppIntegrationPrepareRecordMirrorInnerInputSchema.parse({ store_key: 'drafts', record_id: recordId });
  assert.equal(input.record_id, recordId);
  assert.equal(AppIntegrationPrepareRecordMirrorInnerInputSchema.safeParse({ store_key: 'drafts' }).success, false);
  assert.equal(AppIntegrationPrepareRecordMirrorInnerInputSchema.safeParse({ record_id: recordId }).success, false);
  assert.equal(
    isValidAppIntegrationToolInnerInput('prepare_record_mirror', { store_key: 'drafts', record_id: recordId }),
    true,
  );
  assert.equal(isValidAppIntegrationToolInnerInput('prepare_record_mirror', { store_key: 'drafts' }), false);
  assert.equal(
    isValidAppIntegrationToolInnerInput('record_read', { store_key: 'drafts', record_id: recordId }),
    true,
  );
});

test('a full declared tool set remains unique and admits the mirror tool', () => {
  const read = {
    key: 'draft_read',
    description: 'Read a draft record.',
    operation: 'read',
    mode: 'data',
    store_key: 'drafts',
    resource_key: 'inbox',
    runtime_requirement_key: 'sync_provider',
    input_schema: { type: 'object', additionalProperties: false, properties: { account: { type: 'string' }, record_id: { type: 'string' } } },
    account_input_key: 'account',
    data_operations: ['record_read'],
    input_pins: [{ operation: 'record_read', outer_key: 'record_id', inner_field: 'record_id', required: true }],
    visibility: 'delegated_tools',
  } as const;
  const declared = AppIntegrationToolsDeclarationSchema.parse([read, mirrorDeclaration()]);
  assert.equal(declared.length, 2);
});
