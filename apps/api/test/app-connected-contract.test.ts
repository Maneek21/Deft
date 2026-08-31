import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFT_APP_PROTOCOL_SUPPORT,
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
} from '@deft/app-kit';
import type { MCPTool } from '@deft/mcp';
import type { CapabilityProviderOperationSnapshot } from '@deft/shared';
import {
  connectedAppOperationMatches,
  connectedAppPrivateInterfaceRegistryKey,
  connectedAppToolMatches,
  getConnectedAppPrivateInterface,
  parseConnectedAppProviderInput,
} from '../src/lib/app-connected-contract.js';

const DIGEST = `sha256:${'0'.repeat(64)}` as const;

test('the code-owned private-interface registry resolves exact identities and rejects unknown ones', () => {
  const [registered] = DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces;
  assert.ok(registered);
  assert.equal(getConnectedAppPrivateInterface({
    key: registered.key,
    version: registered.version,
  }), registered);
  assert.equal(getConnectedAppPrivateInterface({
    key: registered.key,
    version: '2',
  }), null);
  assert.equal(getConnectedAppPrivateInterface({
    key: 'unregistered_private_interface',
    version: registered.version,
  }), null);
  assert.equal(getConnectedAppPrivateInterface(undefined), null);
  assert.equal(
    connectedAppPrivateInterfaceRegistryKey(registered),
    `${registered.key}:v${registered.version}`,
  );
});

test('provider operation and tool matching are registry-driven and fail on one-bit drift', () => {
  const [registered] = DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces;
  assert.ok(registered);
  const operation: CapabilityProviderOperationSnapshot = {
    identity: {
      provider: {
        org_id: '11111111-1111-4111-8111-111111111111',
        provider_kind: registered.provider_kind,
        provider_instance_id: '22222222-2222-4222-8222-222222222222',
      },
      operation_name: registered.operation_name,
    },
    title: 'Registered operation',
    description: 'Exact code-owned private interface.',
    input_schema: structuredClone(registered.input_schema),
    output_schema: structuredClone(registered.output_schema),
    schema_digest: DIGEST,
    description_digest: DIGEST,
  };
  const tool: MCPTool = {
    name: `mcp__registered__${registered.operation_name}`,
    originalName: registered.operation_name,
    description: operation.description,
    inputSchema: structuredClone(registered.input_schema),
    outputSchema: structuredClone(registered.output_schema),
    connectionId: operation.identity.provider.provider_instance_id,
    connectionSlug: 'registered',
    isWrite: true,
    approvalTier: 'full-review',
    rawTool: { name: registered.operation_name },
  };

  assert.equal(connectedAppOperationMatches(registered, operation), true);
  assert.equal(connectedAppToolMatches(registered, tool), true);
  assert.equal(connectedAppOperationMatches(registered, {
    ...operation,
    input_schema: {
      ...operation.input_schema,
      properties: {
        ...(operation.input_schema.properties as Record<string, unknown>),
        drift_marker: { type: 'string' },
      },
    },
  }), false);
  assert.equal(connectedAppToolMatches(registered, {
    ...tool,
    originalName: `${registered.operation_name}_changed`,
  }), false);
});

test('every registered interface has a closed host input parser', () => {
  for (const privateInterface of DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces) {
    assert.equal(parseConnectedAppProviderInput(privateInterface, null).success, false);
  }
  const [registered] = DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces;
  assert.ok(registered);
  const valid = {
    to: 'person@example.com',
    subject: 'Registry proof',
    body_text: 'Prepared by Deft.',
    idempotency_key: 'registry-proof-1',
  };
  assert.deepEqual(parseConnectedAppProviderInput(registered, valid), {
    success: true,
    data: valid,
  });
  assert.equal(parseConnectedAppProviderInput(registered, {
    ...valid,
    subject: 'Injected\r\nBcc: hidden@example.com',
  }).success, false);
  assert.equal(parseConnectedAppProviderInput(registered, {
    ...valid,
    provider_secret: 'must-not-be-accepted',
  }).success, false);
  assert.deepEqual(registered.input_schema, SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema);
  assert.deepEqual(registered.output_schema, SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema);
  assert.deepEqual(registered.host_policy, SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy);
});
