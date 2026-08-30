import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CAPABILITY_CONTRACT_VERSIONS,
  CAPABILITY_LIMITS,
  CapabilityInvocationOutcomeSchema,
  CapabilityInvocationRequestSchema,
  CapabilityProviderDiscoverySnapshotInputSchema,
  CapabilityProviderDiscoverySnapshotSchema,
  CapabilityProviderIdentitySchema,
  canonicalCapabilityJson,
  createCapabilityProviderDiscoverySnapshot,
  type CapabilityProviderDiscoverySnapshotInput,
} from '../src/capabilities.js';

const provider = {
  org_id: 'org_ada',
  provider_kind: 'mcp' as const,
  provider_instance_id: 'connection_mail',
};

function snapshotInput(overrides: Partial<CapabilityProviderDiscoverySnapshotInput> = {}): CapabilityProviderDiscoverySnapshotInput {
  return {
    adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
    provider,
    captured_at: '2026-08-30T05:30:00.000Z',
    operations: [{
      identity: { provider, operation_name: 'send_email' },
      title: 'Send email',
      description: 'Provider metadata (untrusted): send an email.',
      input_schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          recipient: { type: 'string', format: 'email' },
        },
        required: ['recipient', 'subject'],
      },
      output_schema: {
        type: 'object',
        properties: { message_id: { type: 'string' } },
      },
    }],
    ...overrides,
  };
}

describe('capability identities and invocation contracts', () => {
  test('keeps provider kinds closed and Deft-owned identities exact', () => {
    assert.deepEqual(CapabilityProviderIdentitySchema.parse(provider), provider);
    assert.equal(CapabilityProviderIdentitySchema.safeParse({ ...provider, provider_kind: 'http' }).success, false);
    assert.equal(CapabilityProviderIdentitySchema.safeParse({ ...provider, org_id: ' other ' }).success, false);
    assert.equal(CapabilityProviderIdentitySchema.safeParse({ ...provider, credential: 'secret' }).success, false);
  });

  test('strictly parses provider-neutral MCP invocation descriptors', () => {
    const request = {
      org_id: 'org_ada',
      actor: { user_id: 'user_ada', agent_employee_id: 'employee_mailer' },
      provider: {
        provider_kind: 'mcp' as const,
        connection_slug: 'mail-provider',
        operation_name: 'send_email',
      },
      input: { recipient: 'ada@example.test', subject: 'Hello' },
    };
    assert.deepEqual(CapabilityInvocationRequestSchema.parse(request), request);
    assert.equal(CapabilityInvocationRequestSchema.safeParse({ ...request, grant: 'admin' }).success, false);
    assert.equal(CapabilityInvocationRequestSchema.safeParse({ ...request, input: { bad: undefined } }).success, false);
  });

  test('requires coherent provider-neutral outcomes', () => {
    const success = {
      provider: {
        provider_kind: 'mcp' as const,
        requested_provider_key: 'mail-provider',
        resolved_provider: provider,
      },
      provider_display_name: 'Mail Provider',
      operation_name: 'send_email',
      success: true,
      output: { content: [{ type: 'text', text: 'ok' }] },
      duration_ms: 12,
    };
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse(success).success, true);
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse({
      ...success,
      success: false,
      error: 'Unavailable',
      error_code: 'CAPABILITY_PROVIDER_UNAVAILABLE',
    }).success, true);
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse({
      ...success,
      provider: { provider_kind: 'mcp', requested_provider_key: 'missing-provider' },
      provider_display_name: undefined,
      success: false,
      output: { error: 'Unavailable' },
      error: 'Unavailable',
      error_code: 'CAPABILITY_PROVIDER_UNAVAILABLE',
    }).success, true);
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse({ ...success, error: 'not coherent' }).success, false);
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse({ ...success, success: false }).success, false);
    for (const output of [undefined, () => undefined, Symbol('not-json')]) {
      assert.equal(CapabilityInvocationOutcomeSchema.safeParse({ ...success, output }).success, false);
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse({ ...success, output: cycle }).success, false);
  });

  test('does not narrow legacy provider-owned name lengths', () => {
    const legacyName = `provider-owned-${'x'.repeat(1_024)}`;
    const request = {
      org_id: 'org_ada',
      actor: { user_id: 'user_ada' },
      provider: {
        provider_kind: 'mcp' as const,
        connection_slug: legacyName,
        operation_name: legacyName,
      },
      input: {},
    };
    assert.equal(CapabilityInvocationRequestSchema.safeParse(request).success, true);
    assert.equal(CapabilityInvocationOutcomeSchema.safeParse({
      provider: {
        provider_kind: 'mcp',
        requested_provider_key: legacyName,
        resolved_provider: provider,
      },
      provider_display_name: legacyName,
      operation_name: legacyName,
      success: true,
      output: {},
      duration_ms: 0,
    }).success, true);
  });
});

describe('canonical capability JSON', () => {
  test('sorts object keys while preserving exact strings, keys, and array order', () => {
    const first = canonicalCapabilityJson({ z: ['second', 'first'], nested: { b: 2, a: 'same' } });
    const second = canonicalCapabilityJson({ nested: { a: 'same', b: 2 }, z: ['second', 'first'] });
    assert.equal(first, second);
    assert.notEqual(
      canonicalCapabilityJson({ values: ['first', 'second'] }),
      canonicalCapabilityJson({ values: ['second', 'first'] }),
    );
    assert.notEqual(
      canonicalCapabilityJson({ z: 1, ['e\u0301']: 2 }),
      canonicalCapabilityJson({ é: 2, z: 1 }),
    );
    const canonical = canonicalCapabilityJson(JSON.parse('{"__proto__":{"safe":true}}'));
    assert.equal(canonical, '{"__proto__":{"safe":true}}');
    assert.equal(({} as { safe?: boolean }).safe, undefined);
  });

  test('rejects non-JSON values while keeping code-point-distinct keys distinct', () => {
    assert.throws(() => canonicalCapabilityJson({ value: Number.NaN }));
    assert.throws(() => canonicalCapabilityJson({ value: undefined }));
    assert.equal(canonicalCapabilityJson({ é: 1, ['e\u0301']: 2 }), '{"é":2,"é":1}');
  });
});

describe('provider discovery snapshot values', () => {
  test('builds deterministic immutable snapshots independent of object key order and capture time', async () => {
    const first = await createCapabilityProviderDiscoverySnapshot(snapshotInput());
    const reordered = snapshotInput({
      captured_at: '2026-08-30T06:30:00.000Z',
      operations: [{
        description: 'Provider metadata (untrusted): send an email.',
        title: 'Send email',
        identity: { operation_name: 'send_email', provider },
        output_schema: {
          properties: { message_id: { type: 'string' } },
          type: 'object',
        },
        input_schema: {
          required: ['recipient', 'subject'],
          properties: {
            recipient: { format: 'email', type: 'string' },
            subject: { type: 'string' },
          },
          type: 'object',
        },
      }],
    });
    const second = await createCapabilityProviderDiscoverySnapshot(reordered);

    assert.equal(first.snapshot_digest, second.snapshot_digest);
    assert.equal(first.operations[0]?.schema_digest, second.operations[0]?.schema_digest);
    assert.equal(first.operations[0]?.description_digest, second.operations[0]?.description_digest);
    assert.notEqual(first.captured_at, second.captured_at);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.operations), true);
    assert.equal(Object.isFrozen(first.operations[0]?.input_schema), true);
  });

  test('owns schema data without freezing or aliasing caller input', async () => {
    const source = snapshotInput();
    const sourceInputSchema = source.operations[0]!.input_schema;
    const sourceProperties = sourceInputSchema.properties as Record<string, unknown>;
    const snapshot = await createCapabilityProviderDiscoverySnapshot(source);

    assert.notEqual(snapshot.operations[0]!.input_schema, sourceInputSchema);
    assert.notEqual(snapshot.operations[0]!.input_schema.properties, sourceProperties);
    assert.equal(Object.isFrozen(sourceInputSchema), false);
    assert.equal(Object.isFrozen(sourceProperties), false);
    sourceProperties.extra = { type: 'string' };
    assert.equal('extra' in (snapshot.operations[0]!.input_schema.properties as Record<string, unknown>), false);
  });

  test('changes executable digest on schema drift and preserves provider array order', async () => {
    const first = await createCapabilityProviderDiscoverySnapshot(snapshotInput());
    const changed = snapshotInput();
    const operation = changed.operations[0]!;
    operation.input_schema = {
      ...operation.input_schema,
      properties: {
        ...(operation.input_schema.properties as Record<string, unknown>),
        priority: { type: 'string', enum: ['high', 'normal'] },
      },
    };
    const second = await createCapabilityProviderDiscoverySnapshot(changed);
    assert.notEqual(first.operations[0]?.schema_digest, second.operations[0]?.schema_digest);
    assert.notEqual(first.snapshot_digest, second.snapshot_digest);

    const reversed = snapshotInput();
    reversed.operations[0]!.input_schema = {
      type: 'object',
      properties: { priority: { type: 'string', enum: ['normal', 'high'] } },
    };
    const forward = snapshotInput();
    forward.operations[0]!.input_schema = {
      type: 'object',
      properties: { priority: { type: 'string', enum: ['high', 'normal'] } },
    };
    assert.notEqual(
      (await createCapabilityProviderDiscoverySnapshot(reversed)).operations[0]?.schema_digest,
      (await createCapabilityProviderDiscoverySnapshot(forward)).operations[0]?.schema_digest,
    );
  });

  test('keeps schema digests provider-neutral while snapshot identity remains provider-bound', async () => {
    const first = await createCapabilityProviderDiscoverySnapshot(snapshotInput());
    const otherProvider = { ...provider, provider_instance_id: 'connection_mail_backup' };
    const secondInput = snapshotInput({
      provider: otherProvider,
      operations: snapshotInput().operations.map((operation) => ({
        ...operation,
        identity: { ...operation.identity, provider: otherProvider },
      })),
    });
    const second = await createCapabilityProviderDiscoverySnapshot(secondInput);
    assert.equal(first.operations[0]?.schema_digest, second.operations[0]?.schema_digest);
    assert.notEqual(first.snapshot_digest, second.snapshot_digest);
  });

  test('changes only description evidence when safe provider text changes', async () => {
    const first = await createCapabilityProviderDiscoverySnapshot(snapshotInput());
    const changed = snapshotInput();
    changed.operations[0]!.description = 'Provider metadata (untrusted): send one email.';
    const second = await createCapabilityProviderDiscoverySnapshot(changed);
    assert.equal(first.operations[0]?.schema_digest, second.operations[0]?.schema_digest);
    assert.notEqual(first.operations[0]?.description_digest, second.operations[0]?.description_digest);
    assert.notEqual(first.snapshot_digest, second.snapshot_digest);
  });

  test('rejects duplicate operation tuples and cross-tenant/provider operations', () => {
    const duplicate = snapshotInput();
    duplicate.operations.push(structuredClone(duplicate.operations[0]!));
    assert.equal(CapabilityProviderDiscoverySnapshotInputSchema.safeParse(duplicate).success, false);

    const mismatch = snapshotInput();
    mismatch.operations[0]!.identity.provider = { ...provider, org_id: 'org_other' };
    assert.equal(CapabilityProviderDiscoverySnapshotInputSchema.safeParse(mismatch).success, false);
  });

  test('strictly excludes top-level transport, auth, invocation, raw tool, and policy fields', () => {
    const unsafeOperation = {
      ...snapshotInput().operations[0],
      server_url: 'https://provider.example',
      auth_config: { token: 'secret' },
      params: { recipient: 'private@example.test' },
      result: { message_id: 'private' },
      rawTool: { annotations: { approval: 'auto' } },
      approval_tier: 'auto',
    };
    assert.equal(CapabilityProviderDiscoverySnapshotInputSchema.safeParse({
      ...snapshotInput(),
      operations: [unsafeOperation],
    }).success, false);
  });

  test('bounds executable schemas and validates the snapshot digest shape', async () => {
    const oversized = snapshotInput();
    oversized.operations[0]!.input_schema = {
      type: 'object',
      properties: { value: { const: 'x'.repeat(CAPABILITY_LIMITS.operation_schema_bytes) } },
    };
    await assert.rejects(
      createCapabilityProviderDiscoverySnapshot(oversized),
      /operation schema exceeds/,
    );

    const valid = await createCapabilityProviderDiscoverySnapshot(snapshotInput());
    assert.equal(CapabilityProviderDiscoverySnapshotSchema.safeParse(valid).success, true);
    assert.equal(CapabilityProviderDiscoverySnapshotSchema.safeParse({
      ...valid,
      snapshot_digest: 'sha256:not-a-digest',
    }).success, false);
  });
});
