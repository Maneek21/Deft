import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  APP_AUTOMATION_POLICY_V1,
  APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS,
  DEFT_APP_DEVELOPER_COMPATIBILITY,
  DEFT_APP_PACKAGE_FORMAT_V2,
  DEFT_APP_PROTOCOL_OPERATIONS,
  DEFT_APP_PROTOCOL_SUPPORT,
  DeftAppManifestV1Schema,
  DeftAppManifestV2Schema,
  DeftAppLockV2Schema,
  SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS,
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
  SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
  buildDeftAppPackage,
  canonicalDeftAppRequestedAuthorityReportJson,
  checkDeftAppDeveloperContract,
  diffDeftAppRequestedAuthority,
  getDeftAppManifestJsonSchema,
  getDeftAppManifestV0JsonSchema,
  getDeftAppManifestV1JsonSchema,
  getDeftAppManifestV2JsonSchema,
  isDeftAppProtocolOperationSupported,
  nextEligibleAppAutomationOccurrence,
  parseDeftAppManifest,
  parseDeftAppManifestJson,
  prepareModuleArtifact,
  projectDeftAppRequestedAuthority,
  simulateDeftAppAutomation,
  verifyDeftAppPackageJson,
  type DeftAppManifestV2Input,
} from '../src/index.js';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const connectedExample = 'examples/connected-resource-campaigns-app';
const scheduledExample = 'examples/scheduled-connected-resource-campaigns-app';

async function packageForExample(path: string) {
  const manifest = parseDeftAppManifestJson(
    await readFile(resolve(repositoryRoot, path, 'deft.app.json'), 'utf8'),
  );
  const artifacts = await Promise.all(manifest.modules.map(async (reference) => prepareModuleArtifact({
    path: reference.manifest_path,
    manifest: JSON.parse(await readFile(
      resolve(repositoryRoot, path, reference.manifest_path),
      'utf8',
    )) as unknown,
  })));
  return { manifest, artifacts, built: await buildDeftAppPackage({ manifest, artifacts }) };
}

async function v2Fixture() {
  const raw = JSON.parse(
    await readFile(resolve(repositoryRoot, connectedExample, 'deft.app.json'), 'utf8'),
  ) as Record<string, unknown>;
  const manifest = {
    ...raw,
    schema_version: '2',
    compatibility: { app_protocol: '2' },
    automation_requests: [{
      key: 'daily_campaign_send',
      label: 'Daily campaign send',
      trigger: { kind: 'daily_local_time' },
      action_key: 'send_campaign_email',
    }],
  } as DeftAppManifestV2Input;
  const moduleReference = manifest.modules[0]!;
  const artifact = await prepareModuleArtifact({
    path: moduleReference.manifest_path,
    manifest: JSON.parse(await readFile(
      resolve(repositoryRoot, connectedExample, moduleReference.manifest_path),
      'utf8',
    )) as unknown,
  });
  return { manifest, artifact };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('App Protocol v2 bounded automation request contract', () => {
  test('builds, verifies, and exports strict v2 packages through explicit dispatch', async () => {
    const { manifest, artifact } = await v2Fixture();
    const first = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
    const second = await buildDeftAppPackage({
      manifest: structuredClone(manifest),
      artifacts: [artifact],
    });

    assert.equal(first.package.package_format, DEFT_APP_PACKAGE_FORMAT_V2);
    assert.equal(first.package.manifest.schema_version, '2');
    assert.equal(first.json, second.json);
    assert.equal(first.digest, second.digest);
    assert.deepEqual(await verifyDeftAppPackageJson(first.json), first);
    assert.equal(parseDeftAppManifest(manifest).compatibility.app_protocol, '2');
    const checked = await checkDeftAppDeveloperContract({
      package_json: first.json,
      host_compatibility: DEFT_APP_DEVELOPER_COMPATIBILITY,
    });
    assert.deepEqual(checked.package, {
      format: 'deft.app.package.v2',
      digest: first.digest,
      protocol_version: '2',
    });
    assert.deepEqual(checked.install_flow, {
      package_format: 'deft.app.package.v2',
      install_mode: 'stage_only',
    });
    assert.equal(checked.requested_authority.schema, 'deft.app.requested_authority.v2');
    assert.equal(checked.automation_simulator_conformance.schema,
      APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS.schema);

    const schema = getDeftAppManifestV2JsonSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal((schema as { additionalProperties?: boolean }).additionalProperties, false);
    assert.deepEqual(
      Object.keys((schema as { properties: Record<string, unknown> }).properties).sort(),
      [...DEFT_APP_PROTOCOL_SUPPORT['2'].manifest_keys].sort(),
    );
    assert.deepEqual(getDeftAppManifestJsonSchema('2'), schema);
    assert.deepEqual(getDeftAppManifestJsonSchema('1'), getDeftAppManifestV1JsonSchema());
    assert.deepEqual(getDeftAppManifestJsonSchema('0'), getDeftAppManifestV0JsonSchema());
    assert.throws(() => getDeftAppManifestJsonSchema('3'), /schema v3 is not supported/);
  });

  test('accepts only one bounded daily trigger declaration over a resolved action', async () => {
    const { manifest } = await v2Fixture();
    assert.equal(DeftAppManifestV2Schema.safeParse(manifest).success, true);

    for (const forbidden of [
      'local_time', 'timezone', 'budget', 'policy', 'provider', 'connector_id',
      'resource_ref', 'validity_window', 'condition', 'script', 'expression',
    ]) {
      const invalid = structuredClone(manifest) as any;
      invalid.automation_requests[0][forbidden] = forbidden === 'script' ? 'run()' : 'forbidden';
      assert.equal(DeftAppManifestV2Schema.safeParse(invalid).success, false, forbidden);
    }
    assert.equal(DeftAppManifestV2Schema.safeParse({
      ...manifest,
      automation_requests: [{
        ...manifest.automation_requests[0],
        trigger: { kind: 'daily_local_time', local_time: '09:00' },
      }],
    }).success, false, 'The App cannot choose the schedule time');
    assert.equal(DeftAppManifestV2Schema.safeParse({
      ...manifest,
      automation_requests: [
        manifest.automation_requests[0],
        { ...manifest.automation_requests[0], label: 'Duplicate request' },
      ],
    }).success, false, 'Automation request keys must be unique');
    assert.equal(DeftAppManifestV2Schema.safeParse({
      ...manifest,
      automation_requests: [{ ...manifest.automation_requests[0], action_key: 'missing_action' }],
    }).success, false, 'The action must already exist');
    assert.equal(DeftAppManifestV2Schema.safeParse({
      ...manifest,
      automation_requests: [],
    }).success, false, 'Protocol v2 declares at least one bounded request');
    assert.equal(DeftAppManifestV2Schema.safeParse({
      ...manifest,
      automation_policy: APP_AUTOMATION_POLICY_V1.key,
    }).success, false, 'An App cannot select the code-owned policy');
  });

  test('rejects unresolved user input only when the automation request references that action', async () => {
    const { manifest } = await v2Fixture();
    const manualAction = structuredClone(manifest.actions[0]!);
    manualAction.key = 'manual_campaign_send';
    manualAction.label = 'Manual campaign send';
    manualAction.input_bindings[0] = {
      input_key: 'to',
      source: { kind: 'user_input', input_type: 'email', label: 'Recipient', required: true },
    };

    const withUnreferencedManualAction = {
      ...manifest,
      actions: [manifest.actions[0], manualAction],
    };
    assert.equal(
      DeftAppManifestV2Schema.safeParse(withUnreferencedManualAction).success,
      true,
      'Immediate-only actions may retain Protocol v1 user input',
    );

    const referenced = {
      ...withUnreferencedManualAction,
      automation_requests: [{
        ...manifest.automation_requests[0],
        action_key: manualAction.key,
      }],
    };
    const result = DeftAppManifestV2Schema.safeParse(referenced);
    assert.equal(result.success, false);
    if (result.success) throw new Error('Expected unresolved user input rejection');
    assert.deepEqual(
      result.error.issues.map(({ code, path, message }) => ({ code, path, message })),
      [{
        code: 'custom',
        path: ['automation_requests', 0, 'action_key'],
        message: 'Automation request action cannot require user input',
      }],
    );
  });

  test('keeps requests non-executable, provider-free, and outside effective authority', async () => {
    const { manifest } = await v2Fixture();
    const projection = projectDeftAppRequestedAuthority(manifest);
    assert.equal('automation_requests' in projection.requirements, true);
    if (!('automation_requests' in projection.requirements)) {
      throw new Error('Expected Protocol v2 requested authority');
    }
    assert.deepEqual(projection.requirements.automation_requests, manifest.automation_requests);
    assert.equal(projection.classification.authority_state, 'requested_only');
    assert.equal(projection.classification.executable, false);
    assert.equal(projection.classification.provider_access, false);

    const json = canonicalDeftAppRequestedAuthorityReportJson(manifest);
    const report = JSON.parse(json) as any;
    assert.equal(report.schema, 'deft.app.requested_authority.v2');
    assert.equal(report.app.protocol_version, '2');
    assert.deepEqual(report.requested_authority.requirements.automation_requests, manifest.automation_requests);
    for (const forbidden of [
      '"organization_id":', '"installation_id":', '"connector_id":', '"provider_id":',
      '"effective_grant":', 'approved_automation_definition', APP_AUTOMATION_POLICY_V1.key,
    ]) assert.equal(json.includes(forbidden), false, forbidden);
  });

  test('publishes one frozen code-owned policy without changing the base interface policy', () => {
    assert.equal(Object.isFrozen(APP_AUTOMATION_POLICY_V1), true);
    assert.equal(Object.isFrozen(APP_AUTOMATION_POLICY_V1.definition), true);
    assert.equal(Object.isFrozen(APP_AUTOMATION_POLICY_V1.definition.approving_roles), true);
    assert.equal(Object.isFrozen(APP_AUTOMATION_POLICY_V1.limits), true);
    assert.strictEqual(APP_AUTOMATION_POLICY_V1.private_interface, SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE);
    assert.strictEqual(APP_AUTOMATION_POLICY_V1.action_binding, SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE.action_binding);
    assert.strictEqual(APP_AUTOMATION_POLICY_V1.base_host_policy, SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy);
    assert.equal(APP_AUTOMATION_POLICY_V1.version, '1');
    assert.equal(APP_AUTOMATION_POLICY_V1.review_scope, 'approved_automation_definition');
    assert.deepEqual(APP_AUTOMATION_POLICY_V1.definition.approving_roles, ['owner', 'admin']);
    assert.equal(APP_AUTOMATION_POLICY_V1.definition.fully_pinned, true);
    assert.equal(APP_AUTOMATION_POLICY_V1.limits.external_actions_per_fire, 1);
    assert.equal(APP_AUTOMATION_POLICY_V1.app_authored, false);
    assert.equal(APP_AUTOMATION_POLICY_V1.app_selectable, false);
    assert.equal(APP_AUTOMATION_POLICY_V1.schedule_selectable, false);
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
  });

  test('registers a complete v2 support matrix without widening v1 authoring', async () => {
    for (const operation of DEFT_APP_PROTOCOL_OPERATIONS) {
      assert.equal(isDeftAppProtocolOperationSupported('2', operation), true, operation);
    }
    assert.equal(
      DEFT_APP_PROTOCOL_SUPPORT['2'].atoms['manifest.identity'].review,
      'app-review-service:review-v2',
      'Package review remains the connected grant/connector review; definition approval is host-owned',
    );
    assert.deepEqual(Object.keys(DEFT_APP_PROTOCOL_SUPPORT['2'].atoms), [
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
      'automation_requests.daily_local_time',
      'package.module_artifacts',
    ]);
    assert.deepEqual(DEFT_APP_PROTOCOL_SUPPORT['2'].private_interfaces, [
      SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
    ]);

    const v1 = JSON.parse(
      await readFile(resolve(repositoryRoot, connectedExample, 'deft.app.json'), 'utf8'),
    ) as Record<string, unknown>;
    const rejected = DeftAppManifestV1Schema.safeParse({ ...v1, automation_requests: [] });
    assert.equal(rejected.success, false);
    if (rejected.success) throw new Error('Expected Protocol v1 to reject v2 declarations');
    assert.deepEqual(
      rejected.error.issues.map((issue: any) => ({
        code: issue.code,
        path: issue.path,
        keys: issue.keys,
      })),
      [{ code: 'unrecognized_keys', path: [], keys: ['automation_requests'] }],
    );
  });

  test('preserves frozen v0 and v1 package and requested-authority bytes', async () => {
    const v0 = await packageForExample('examples/resource-participation-contacts-app');
    assert.equal(v0.built.package.manifest_digest,
      'sha256:d25831fbc3b87881db689ce1cf2beeb2256324be9c7e4a3f780e70534513e1ed');
    assert.equal(v0.built.digest,
      'sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8');
    assert.equal(sha256(canonicalDeftAppRequestedAuthorityReportJson(v0.manifest)),
      'sha256:33cc768f0755e255447a13f19259bb212f5dd8cf4e41b34e119a541fb134c334');

    const v1 = await packageForExample(connectedExample);
    assert.equal(v1.built.package.manifest_digest,
      'sha256:e7f0f04ecf793a62157f6759b5ca7ee4154e2125b9303b01179011d86fb5c987');
    assert.equal(v1.built.digest,
      'sha256:973ec7076daf7405a7a4d8b48509ef6f99b1b1cc4b787961104c73f23b7f770d');
    assert.equal(sha256(canonicalDeftAppRequestedAuthorityReportJson(v1.manifest)),
      'sha256:69c28209b77545b45fa7232a788d45fe1b72c16fe9e2ab3d8071e3de226f77bc');
  });

  test('builds the independent scheduled Campaign upgrade and reports only its requested widening', async () => {
    const v1 = await packageForExample(connectedExample);
    const v2 = await packageForExample(scheduledExample);
    assert.equal(v2.built.digest,
      'sha256:189c220018e5118b9277dce15505197726608140a58189f40ccfdcfcceb2c7e8');
    const diff = await diffDeftAppRequestedAuthority({ prior: v1.manifest, proposed: v2.manifest });
    assert.deepEqual(diff.changed_atoms, ['automation_requests']);
    assert.equal(diff.kind, 'widening_or_incompatible');
    assert.equal(diff.carry_forward_eligible, false);
    assert.equal(diff.prior_requested_authority_digest,
      'sha256:63e8c7404e9e8c31ad097bf7d62e328c5cf47b447a6cd82f6b65dd2d3585355e');
    assert.equal(diff.proposed_requested_authority_digest,
      'sha256:adf38f727043b179322ae3cdedfbd61e988a717b9fad2a0caae282c983ca89a3');

    const lock = DeftAppLockV2Schema.parse(JSON.parse(
      await readFile(resolve(repositoryRoot, scheduledExample, 'deft.app.lock.json'), 'utf8'),
    ));
    assert.equal(lock.package_digest, v2.built.digest);
    assert.equal(lock.requested_authority_digest, lock.permission_diff.proposed_requested_authority_digest);
    assert.deepEqual(lock.permissions, []);
  });

  test('uses exact public schedule and input contracts in the non-executable simulator', async () => {
    const { manifest } = await packageForExample(scheduledExample);
    if (manifest.schema_version !== '2') throw new Error('Expected the scheduled v2 proof');
    const readyPin = {
      approved: { revision: '1', content_digest: `sha256:${'a'.repeat(64)}` },
      current: { revision: '1', content_digest: `sha256:${'a'.repeat(64)}` },
    };
    for (const vector of APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS.occurrences) {
      const simulated = simulateDeftAppAutomation({
        manifest,
        request_key: 'daily_campaign_send',
        occurrence: {
          logical_local_date: vector.logical_local_date,
          local_time: vector.local_time,
          timezone: vector.timezone,
          now: vector.now,
          eligible_after: '2026-01-01T00:00:00.000Z',
          eligible_before: '2026-12-01T00:00:00.000Z',
        },
        pins: { placement: readyPin, selected: readyPin },
        provider_input: SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input,
      });
      assert.equal(simulated.schedule.decision, vector.expected, vector.label);
      if ('resolved_at_utc' in vector) {
        assert.equal(simulated.schedule.resolved_at_utc, vector.resolved_at_utc, vector.label);
      }
      assert.equal(simulated.pinned_inputs.status, 'ready');
      assert.equal(simulated.pinned_inputs.status,
        APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS.pins.ready.expected);
      assert.equal(simulated.provider_input.status, 'valid');
      assert.equal(simulated.executable, false);
      assert.equal(simulated.provider_access, false);
    }

    const stale = simulateDeftAppAutomation({
      manifest,
      request_key: 'daily_campaign_send',
      occurrence: {
        logical_local_date: '2026-02-10', local_time: '09:00', timezone: 'UTC',
        now: '2026-02-10T09:05:00.000Z', eligible_after: '2026-02-09T00:00:00.000Z',
      },
      pins: {
        placement: readyPin,
        selected: { ...readyPin, current: { ...readyPin.current, revision: '2' } },
      },
      provider_input: { ...SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input, to: 'not-email' },
    });
    assert.deepEqual(stale.pinned_inputs, {
      status: APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS.pins.stale.expected,
      changed: [...APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS.pins.stale.changed],
    });
    assert.equal(stale.provider_input.status, 'invalid');
  });

  test('finds the next bounded real UTC occurrence without duplicating DST rules', () => {
    const next = nextEligibleAppAutomationOccurrence({
      local_time: '02:30',
      timezone: 'America/New_York',
      now: new Date('2026-03-08T05:00:00.000Z'),
      eligible_after: new Date('2026-03-01T00:00:00.000Z'),
      eligible_before: new Date('2026-04-01T00:00:00.000Z'),
    });
    assert.equal(next?.logical_local_date, '2026-03-09', 'The March 8 DST gap is not a real fire');
    assert.equal(
      next?.resolution.kind === 'resolved' ? next.resolution.resolved_at_utc.toISOString() : null,
      '2026-03-09T06:30:00.000Z',
    );
  });
});
