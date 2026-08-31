import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  APP_ACTION_OPERATION_INPUT_SCHEMAS,
  APP_ACTION_OPERATION_NAMES,
  APP_ACTION_OPERATION_PRIMARY_SCOPES,
} from '../src/lib/app-action-operations.js';
import { closeDb } from '../src/lib/db.js';

after(async () => closeDb());

const resourceRef = {
  schema_version: 'deft.resource_ref.v1',
  provider: { kind: 'module', provider_instance_id: 'module-installation-1' },
  resource_type: 'campaigns',
  resource_id: 'campaign-1',
} as const;

test('connected Apps expose one fixed generic operation vocabulary with explicit scopes', () => {
  assert.deepEqual(APP_ACTION_OPERATION_NAMES, [
    'capability_list',
    'capability_get',
    'app_binding_invoke',
    'app_run_get',
  ]);
  assert.deepEqual(APP_ACTION_OPERATION_PRIMARY_SCOPES, {
    capability_list: 'read:apps',
    capability_get: 'read:apps',
    app_binding_invoke: 'invoke:apps',
    app_run_get: 'read:app-runs',
  });
});

test('generic operation inputs are strict, bounded, and resource-ref based', () => {
  assert.deepEqual(
    APP_ACTION_OPERATION_INPUT_SCHEMAS.capability_list.parse({ resource_ref: resourceRef }),
    { resource_ref: resourceRef },
  );
  assert.throws(() => APP_ACTION_OPERATION_INPUT_SCHEMAS.capability_list.parse({
    resource_ref: resourceRef,
    app_authored_tool: 'send_campaign',
  }));

  const invoke = APP_ACTION_OPERATION_INPUT_SCHEMAS.app_binding_invoke.parse({
    binding_id: 'binding-1',
    resource_ref: resourceRef,
    selections: [{ input_key: 'to', resource_ref: { ...resourceRef, resource_type: 'contacts' } }],
    idempotency_key: 'retry-safe-1',
  });
  assert.deepEqual(invoke.user_inputs, {});
  assert.throws(() => APP_ACTION_OPERATION_INPUT_SCHEMAS.app_binding_invoke.parse({
    ...invoke,
    provider_id: 'caller-controlled-provider',
  }));
});
