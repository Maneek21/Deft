import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFT_APP_PACKAGE_FORMAT_V1,
  DEFT_APP_PROTOCOL_OPERATIONS,
  DEFT_APP_PROTOCOL_SUPPORT,
  AppAuthorityKeyV1Schema,
  AppMachineKeyV1Schema,
  DeftAppManifestV1Schema,
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
  SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
  SandboxEmailSendInputSchema,
  SandboxEmailSendOutputSchema,
  buildDeftAppPackage,
  canonicalAppPrivateInterfaceIdentity,
  getDeftAppManifestV1JsonSchema,
  isDeftAppProtocolOperationSupported,
  prepareModuleArtifact,
  verifyDeftAppPackageJson,
  type DeftAppManifestV1Input,
} from '../src/index.js';

const campaignModule = {
  schema_version: '2',
  id: 'community.deft.connected-campaigns',
  slug: 'connected-campaigns',
  version: '3.0.0',
  name: 'Connected Campaigns',
  collections: [{
    key: 'campaigns',
    name: 'Campaigns',
    fields: [
      { key: 'subject', label: 'Subject', type: 'text', required: true },
      { key: 'body', label: 'Body', type: 'long_text', required: true },
      {
        key: 'contacts',
        label: 'Contacts',
        type: 'resource_ref',
        target: { module_id: 'community.deft.contacts', resource_type: 'contacts' },
        multiple: true,
        display: 'label',
      },
    ],
    views: [{ key: 'detail', name: 'Campaign', type: 'detail', fields: ['subject', 'body', 'contacts'] }],
  }],
};

async function fixture() {
  const artifact = await prepareModuleArtifact({
    path: 'modules/connected-campaigns/deft.module.json',
    manifest: campaignModule,
  });
  const manifest: DeftAppManifestV1Input = {
    schema_version: '1',
    id: 'community.deft.connected-campaigns-app',
    version: '3.0.0',
    name: 'Connected Campaigns',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '1' },
    modules: [{
      module_id: campaignModule.id,
      version: campaignModule.version,
      manifest_path: artifact.path,
      manifest_digest: artifact.digest,
    }],
    navigation: [{
      key: 'campaigns',
      label: 'Campaigns',
      module_id: campaignModule.id,
      collection_key: 'campaigns',
      view_key: 'detail',
    }],
    dependencies: [{
      key: 'contacts_app',
      app_id: 'community.deft.contacts-app',
      version: '1.0.0',
    }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: campaignModule.id, version: campaignModule.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body', 'contacts'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts_app',
          module_id: 'community.deft.contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: { kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1' },
    }],
    connector_requirements: [{ key: 'mail_provider', provider_kind: 'mcp' }],
    actions: [{
      key: 'send_campaign_email',
      label: 'Send campaign email',
      capability_requirement_key: 'send_email',
      connector_requirement_key: 'mail_provider',
      placement: { kind: 'resource_detail', resource_requirement_key: 'campaign' },
      input_bindings: [
        {
          input_key: 'to',
          source: {
            kind: 'selected_relation_field',
            source_resource_requirement_key: 'campaign',
            relation_field_key: 'contacts',
            target_resource_requirement_key: 'contact',
            target_field_key: 'email',
            selection: 'one',
          },
        },
        {
          input_key: 'subject',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'subject' },
        },
        {
          input_key: 'body_text',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'body' },
        },
      ],
    }],
  };
  return { artifact, manifest };
}

describe('App Protocol v1 authoring contract', () => {
  test('builds and verifies deterministic connected packages', async () => {
    const { artifact, manifest } = await fixture();
    const first = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
    const second = await buildDeftAppPackage({
      manifest: JSON.parse(JSON.stringify(manifest)) as DeftAppManifestV1Input,
      artifacts: [artifact],
    });

    assert.equal(first.package.package_format, DEFT_APP_PACKAGE_FORMAT_V1);
    assert.equal(first.json, second.json);
    assert.equal(first.digest, second.digest);
    assert.deepEqual(await verifyDeftAppPackageJson(first.json), first);
  });

  test('exports a strict schema and a single code-owned support registry', () => {
    const schema = getDeftAppManifestV1JsonSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal((schema as { additionalProperties?: boolean }).additionalProperties, false);
    const schemaKeys = Object.keys((schema as { properties: Record<string, unknown> }).properties).sort();
    assert.deepEqual(schemaKeys, [...DEFT_APP_PROTOCOL_SUPPORT['1'].manifest_keys].sort());
    assert.equal(isDeftAppProtocolOperationSupported('1', 'authoring'), true);
    assert.equal(isDeftAppProtocolOperationSupported('1', 'inspect'), true);
    assert.equal(isDeftAppProtocolOperationSupported('1', 'stage'), true);
    assert.equal(isDeftAppProtocolOperationSupported('1', 'review'), true);
    assert.equal(isDeftAppProtocolOperationSupported('1', 'route'), true);
    assert.equal(isDeftAppProtocolOperationSupported('1', 'activate'), true);
    assert.equal(isDeftAppProtocolOperationSupported('1', 'invoke'), true);
    for (const support of Object.values(DEFT_APP_PROTOCOL_SUPPORT)) {
      assert.ok(Object.keys(support.atoms).length > 0);
      for (const handlers of Object.values(support.atoms)) {
        assert.deepEqual(Object.keys(handlers), [...DEFT_APP_PROTOCOL_OPERATIONS]);
      }
    }
    assert.deepEqual(Object.keys(DEFT_APP_PROTOCOL_SUPPORT['1'].atoms), [
      'manifest.identity',
      'manifest.provenance',
      'modules.included',
      'navigation.host_rendered',
      'dependencies.exact_app',
      'resources.included_module',
      'resources.dependency_module',
      'capabilities.private_app_lineage',
      'connectors.existing_mcp',
      'actions.resource_detail',
      'action_inputs.resource_field',
      'action_inputs.selected_relation_field',
      'action_inputs.user_input',
      'package.module_artifacts',
    ]);
    assert.deepEqual(DEFT_APP_PROTOCOL_SUPPORT['0'].private_interfaces, []);
    assert.deepEqual(DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces, [
      SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
    ]);
    assert.equal(Object.isFrozen(DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces), true);
    assert.equal(Object.isFrozen(SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE), true);
    assert.equal(Object.isFrozen(SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE.action_binding.inputs), true);
    assert.ok(SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE.action_binding.inputs.every(
      (input) => Object.isFrozen(input.allowed_field_types),
    ));
    assert.equal(
      new Set(DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces.map(
        (item) => `${item.key}:v${item.version}`,
      )).size,
      DEFT_APP_PROTOCOL_SUPPORT['1'].private_interfaces.length,
    );
    assert.equal('loader' in SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE, false);
    assert.equal('module_path' in SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE, false);
    assert.equal('callback' in SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE, false);
  });

  test('derives private interface identity only from host-owned lineage inputs', () => {
    const base = {
      organization_id: '11111111-1111-4111-8111-111111111111',
      app_lineage_id: '22222222-2222-4222-8222-222222222222',
      interface_key: 'sandbox_email_send',
      interface_version: '1',
    } as const;
    assert.equal(
      canonicalAppPrivateInterfaceIdentity(base),
      'deft.private.v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:sandbox_email_send:v1',
    );
    assert.notEqual(
      canonicalAppPrivateInterfaceIdentity(base),
      canonicalAppPrivateInterfaceIdentity({
        ...base,
        app_lineage_id: '33333333-3333-4333-8333-333333333333',
      }),
    );
    assert.throws(() => canonicalAppPrivateInterfaceIdentity({
      ...base,
      claimed_publisher: 'attacker.example',
    } as typeof base), /Unrecognized key/);
    assert.equal(
      canonicalAppPrivateInterfaceIdentity({
        ...base,
        organization_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }),
      'deft.private.v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:22222222-2222-4222-8222-222222222222:sandbox_email_send:v1',
    );
  });

  test('freezes the private sandbox email schema and host-owned policy floor', () => {
    assert.equal(SandboxEmailSendInputSchema.safeParse({
      to: 'ada@example.test',
      subject: 'Analytical Engines',
      body_text: 'Hello Ada',
      idempotency_key: 'campaign:one/contact:ada',
    }).success, true);
    assert.equal(SandboxEmailSendInputSchema.safeParse({
      to: 'ada@example.test',
      subject: 'Analytical Engines',
      body_text: 'Hello Ada',
      idempotency_key: 'campaign:one/contact:ada',
      approval: 'skip',
    }).success, false);
    assert.equal(SandboxEmailSendInputSchema.safeParse({
      to: 'ada@example.test',
      subject: 'Analytical Engines\r\nBcc: attacker@example.test',
      body_text: 'Hello Ada',
      idempotency_key: 'campaign:one/contact:ada',
    }).success, false);
    assert.equal(SandboxEmailSendInputSchema.safeParse({
      to: 'ada@example.test',
      subject: 'Analytical Engines',
      body_text: 'Hello\u0000Ada',
      idempotency_key: 'campaign:one/contact:ada',
    }).success, false);
    assert.equal(SandboxEmailSendOutputSchema.safeParse({ message_id: 'sandbox_123', status: 'accepted' }).success, true);
    assert.equal(SandboxEmailSendOutputSchema.safeParse({ message_id: 'sandbox_123\nforged', status: 'accepted' }).success, false);
    assert.deepEqual(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy, {
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'per_invocation',
      egress_class: 'email',
      retry_class: 'idempotent_with_key',
      retention_class: 'standard',
      automation_eligibility: 'forbidden',
      provider_idempotency_key_required: true,
    });
    assert.equal(Object.isFrozen(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy), true);
  });

  test('rejects policy injection, executable planes, arbitrary mapping, and ambiguous references', async () => {
    const { manifest } = await fixture();
    assert.equal(AppMachineKeyV1Schema.safeParse('system_prompt').success, true);
    for (const reserved of ['deft', 'deft_action', 'core', 'core_action', 'system', 'system_action']) {
      assert.equal(AppAuthorityKeyV1Schema.safeParse(reserved).success, false, reserved);
    }
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      actions: [{ ...manifest.actions[0], key: 'system_action' }],
    }).success, false);
    for (const forbidden of [
      'runtime',
      'code',
      'sync',
      'automation',
      'schedule',
      'public',
      'public_ingress',
      'experience',
      'custom_ui',
      'secrets',
      'tokens',
      'connector_creation',
      'grants',
    ]) {
      assert.equal(DeftAppManifestV1Schema.safeParse({ ...manifest, [forbidden]: {} }).success, false, forbidden);
    }
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      capability_requirements: [{
        ...manifest.capability_requirements[0],
        risk_class: 'read',
      }],
    }).success, false);
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      capability_requirements: [{
        ...manifest.capability_requirements[0],
        interface: {
          ...manifest.capability_requirements[0]!.interface,
          namespace: 'publisher',
        },
      }],
    }).success, false, 'An App cannot choose the authority namespace for a private interface');
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      connector_requirements: [{
        ...manifest.connector_requirements[0],
        endpoint: 'https://attacker.example',
      }],
    }).success, false);
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      dependencies: [{ ...manifest.dependencies[0], app_id: manifest.id }],
    }).success, false);
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      dependencies: [
        manifest.dependencies[0]!,
        { key: manifest.dependencies[0]!.key, app_id: 'community.deft.accounts-app', version: '1.0.0' },
      ],
    }).success, false, 'Dependency keys must be unique');
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      dependencies: [
        manifest.dependencies[0]!,
        { key: 'accounts_app', app_id: manifest.dependencies[0]!.app_id, version: '1.0.0' },
      ],
    }).success, false, 'One dependency App cannot be selected ambiguously');
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      resource_requirements: [{ ...manifest.resource_requirements[0], key: 'cаmpaign' }],
    }).success, false, 'Unicode-confusable machine keys must be rejected');
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      actions: [{
        ...manifest.actions[0],
        input_bindings: manifest.actions[0]!.input_bindings.map((binding) => binding.input_key === 'subject'
          ? { ...binding, source: { kind: 'json_path', path: '$.subject' } }
          : binding),
      }],
    }).success, false);
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      actions: [{
        ...manifest.actions[0],
        input_bindings: manifest.actions[0]!.input_bindings.map((binding) => binding.input_key === 'subject'
          ? {
              ...binding,
              source: {
                kind: 'resource_field',
                resource_requirement_key: 'contact',
                field_key: 'email',
              },
            }
          : binding),
      }],
    }).success, false, 'A current-resource input cannot read from an unrelated declared resource');
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      actions: [{
        ...manifest.actions[0],
        input_bindings: manifest.actions[0]!.input_bindings.map((binding) => binding.input_key === 'to'
          ? {
              ...binding,
              source: {
                ...binding.source,
                source_resource_requirement_key: 'contact',
              },
            }
          : binding),
      }],
    }).success, false, 'A selected relation must start from the placed resource');
    for (const source of [
      { kind: 'script', code: 'return record.subject' },
      { kind: 'template', template: '{{record.subject}}' },
      { kind: 'environment', name: 'SECRET' },
      { kind: 'secret', key: 'mail_token' },
      { kind: 'url', value: 'https://attacker.example' },
      { kind: 'transform', operation: 'json_path', path: '$.subject' },
    ]) {
      assert.equal(DeftAppManifestV1Schema.safeParse({
        ...manifest,
        actions: [{
          ...manifest.actions[0],
          input_bindings: manifest.actions[0]!.input_bindings.map((binding) => binding.input_key === 'subject'
            ? { ...binding, source }
            : binding),
        }],
      }).success, false, source.kind);
    }
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      resource_requirements: [manifest.resource_requirements[0]!, manifest.resource_requirements[0]!],
    }).success, false);
    assert.equal(DeftAppManifestV1Schema.safeParse({
      ...manifest,
      actions: [{ ...manifest.actions[0], input_bindings: manifest.actions[0]!.input_bindings.slice(0, 2) }],
    }).success, false);
  });

  test('rejects included resource drift and false relation targets at package verification', async () => {
    const { artifact, manifest } = await fixture();
    const missingField = structuredClone(manifest);
    missingField.resource_requirements[0]!.fields.push('missing');
    await assert.rejects(
      buildDeftAppPackage({ manifest: missingField, artifacts: [artifact] }),
      /unknown included field missing/,
    );

    const falseTarget = structuredClone(manifest);
    const target = falseTarget.resource_requirements[1]!;
    if (target.source.kind !== 'dependency_module') throw new Error('Fixture target must be dependency-backed');
    target.source.module_id = 'community.deft.leads';
    await assert.rejects(
      buildDeftAppPackage({ manifest: falseTarget, artifacts: [artifact] }),
      /selected relation does not target the declared resource requirement/,
    );
  });
});
