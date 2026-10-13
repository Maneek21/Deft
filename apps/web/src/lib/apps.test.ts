import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canEnableAppWithoutReview,
  canStageConnectedUpgrade,
  isConnectedAppManifest,
  normalizeAppGrantManagement,
  normalizeAppInstallation,
  normalizeAppsResponse,
  normalizeAppRunReceiptBundle,
  normalizeConnectedAppHealth,
  normalizeConnectedAppReview,
  normalizeAppResourceContent,
  normalizeAppResourceContentReview,
} from './apps';
import { getAppNavigationItems, getInstalledExperienceNavigation, isAppNavigationGroupActive } from './app-navigation';
import { nativeEmailAppNavigation } from './email-native-navigation';

const observedNavigation = JSON.parse(readFileSync(new URL('./fixtures/email-e2-2-app-navigation.json', import.meta.url), 'utf8'));
test('public source fixture contains only the observed Email installation and declarations', () => {
  assert.deepEqual(Object.keys(observedNavigation), ['/api/apps', '/api/apps/navigation']);
  assert.equal(observedNavigation['/api/apps'].status, 200);
  assert.deepEqual(Object.keys(observedNavigation['/api/apps'].response), ['apps']);
  assert.deepEqual(observedNavigation['/api/apps'].response.apps.map((app: { app_id: string }) => app.app_id), ['io.deft.email']);
  assert.equal(observedNavigation['/api/apps/navigation'].status, 200);
  assert.deepEqual(observedNavigation['/api/apps/navigation'].response, { navigation: [] });
  assert.deepEqual(Object.keys(observedNavigation['/api/apps'].response.apps[0]).sort(), [
    'active_version_id', 'app_id', 'created_at', 'grant_epoch', 'id', 'lifecycle_epoch', 'manifest',
    'manifest_digest', 'name', 'package_digest', 'state', 'updated_at', 'version', 'version_id',
  ].sort());
});

test('Email-only observed E2.2 public Apps response reaches the active Experience sidebar with retained native Email', () => {
  const apps = normalizeAppsResponse(observedNavigation['/api/apps'].response);
  const experiences = getInstalledExperienceNavigation(apps);
  const groups = nativeEmailAppNavigation(getAppNavigationItems([
    ...observedNavigation['/api/apps/navigation'].response.navigation, ...experiences,
  ]), { available: true, legacy_installation_ids: ['bbc68de7-94ae-4674-a527-abfdc4324054'] });
  const active = groups.find(group => isAppNavigationGroupActive('/apps/bbc68de7-94ae-4674-a527-abfdc4324054/main', group, groups));
  assert.equal(active?.name, 'Email');
  assert.equal(active?.links.some(link => link.kind === 'experience' && link.experience_key === 'main'), true);
  const manifest = apps.find(app => app.app_id === 'io.deft.email')!.manifest;
  assert.equal(manifest.schema_version, '7');
  if (manifest.schema_version !== '7') throw Error('Wrong protocol');
  assert.equal(manifest.experiences[0]!.renderer_version, 'deft.trusted_renderer.v2');
  assert.deepEqual((manifest as unknown as {record_stores:unknown}).record_stores,
    observedNavigation['/api/apps'].response.apps[0].manifest.record_stores);
  assert.deepEqual(manifest.owner_connections, observedNavigation['/api/apps'].response.apps[0].manifest.owner_connections);
  assert.deepEqual(manifest.experiences[0]!.capabilities, ['record_document.v1', 'record_form.v1']);
});
test('E2 display rejects unsupported renderer profiles, store budgets and foreign declaration bindings', () => {
  const source = observedNavigation['/api/apps'].response.apps[0];
  const changes = [
    (row: typeof source) => { delete row.manifest.experiences[0].capabilities; },
    (row: typeof source) => { row.manifest.experiences[0].renderer_version = 'deft.trusted_renderer.v1'; },
    (row: typeof source) => { row.manifest.experiences[0].capabilities = ['record_form.v1', 'record_form.v1']; },
    (row: typeof source) => { row.manifest.experiences[0].capabilities = ['unsupported.v1']; },
    (row: typeof source) => { row.manifest.record_stores[0].max_record_bytes = 491521; },
    (row: typeof source) => { row.manifest.record_stores[0].runtime_requirement_key = 'foreign'; },
    (row: typeof source) => { row.manifest.record_stores[0].resource_key = 'foreign'; },
    (row: typeof source) => { row.manifest.record_stores[0].host_authority = true; },
    (row: typeof source) => { row.manifest.record_stores.push(row.manifest.record_stores[0]); },
    (row: typeof source) => { delete row.manifest.owner_connections[0].provider_profile_key; },
    (row: typeof source) => { row.manifest.owner_connections[0].runtime_requirement_key = 'foreign'; },
    (row: typeof source) => { delete row.manifest.owner_connections[0].provider_profile_key; delete row.manifest.owner_connections[0].runtime_requirement_key; },
    (row: typeof source) => { row.manifest.unknown_authority = true; },
  ];
  for (const change of changes) { const fixture = structuredClone(source); change(fixture); assert.throws(() => normalizeAppInstallation(fixture)); }
});

const now = '2026-09-01T00:00:00.000Z';
const privateState = { key: 'drafts', label: 'Drafts',
  schema: { type: 'object', properties: { body: { type: 'string', maxLength: 4096 } }, required: ['body'], additionalProperties: false },
  max_record_bytes: 16384, max_records: 32, max_total_bytes: 131072, retention_days: 30 };
const documentMetadata={type:'object',additionalProperties:false,required:['account_id','subject'],properties:{account_id:{type:'string',maxLength:200},subject:{type:'string',maxLength:200,format:'single_line'}}};
const documentAccess=[{resource_key:'mail',document:{max_characters:16384,metadata_schema:documentMetadata}}];

test('document activation review preserves exact policy and rejects changed or omitted metadata authority',()=>{
 const fixture=attachmentInstallation();Object.assign(fixture.manifest,{resource_content:documentAccess});const parsed=normalizeAppInstallation(fixture).manifest;
 assert.equal(parsed.schema_version,'7');if(parsed.schema_version!=='7')throw Error('Wrong protocol');assert.deepEqual(parsed.resource_content,documentAccess);
 assert.deepEqual(normalizeAppResourceContentReview(documentAccess,parsed.resource_content,[{key:'mail'}]),documentAccess);
 assert.equal(normalizeAppResourceContentReview(undefined,undefined,[{key:'mail'}]),undefined);
 for(const changed of [undefined,[{resource_key:'mail',document:{max_characters:16383,metadata_schema:documentMetadata}}],[{resource_key:'mail',document:{max_characters:16384}}],
  [{resource_key:'mail',document:{max_characters:16384,metadata_schema:{...documentMetadata,required:['subject']}}}]])assert.throws(()=>normalizeAppResourceContentReview(changed,parsed.resource_content,[{key:'mail'}]));
 assert.throws(()=>normalizeAppResourceContentReview(documentAccess,undefined,[{key:'mail'}]));
});

test('document review rejects unknown keys at every schema level and unsupported resources or bounds',()=>{
 const doc=documentAccess[0]!;
 const badSchemas=[{...documentMetadata,unknown:true},{...documentMetadata,required:['missing']},{...documentMetadata,required:['account_id','account_id']},
  {...documentMetadata,properties:{account_id:{type:'string',maxLength:200,pattern:'.*'}}},
  {...documentMetadata,properties:{account_id:{type:'string',maxLength:200,title:'<script>'}}},
  {...documentMetadata,properties:{account_id:{type:'object'}}}];
 for(const value of [[],[doc,doc],[{...doc,unknown:true}],[{...doc,resource_key:'unknown'}],[{...doc,document:{...doc.document,html:true}}],
  ...[0,16385,1.5].map(max_characters=>[{...doc,document:{max_characters}}]),...badSchemas.map(metadata_schema=>[{...doc,document:{...doc.document,metadata_schema}}])])assert.throws(()=>normalizeAppResourceContent(value,[{key:'mail'}]));
});

function attachmentInstallation(state: unknown = [privateState]) {
  return { ...installation('0'), manifest: {
    schema_version: '7', compatibility: { app_protocol: '7' }, id: 'community.deft.mail', version: '1.0.0', name: 'Mail', license: 'AGPL-3.0-only',
    modules: [], navigation: [], runtime_requirements: [{ key: 'mail', protocol_version: 'deft.app_runtime_channel.v3' }],
    private_capabilities: [], runtime_actions: [], native_actions: [], experiences: [], public_actions: [],
    sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v2', key: 'mail', runtime_requirement_key: 'mail', resource_type: 'messages',
      requested_visibility: 'user_private', label_field: 'subject', record_schema: {}, attachments: { max_attachment_bytes: 2097152,
        max_attachments_per_record: 8, max_attachments_per_run: 32, max_attachment_bytes_per_run: 8388608, retention_days: 30,
        allowed_media_types: ['text/plain'] } }], ...(state === undefined ? {} : { private_state: state }),
  } };
}

test('Settings displays protocol 7 private-state declarations without dropping them', () => {
  const manifest = normalizeAppInstallation(attachmentInstallation()).manifest;
  assert.equal(manifest.schema_version, '7');
  assert.deepEqual((manifest as unknown as { private_state: unknown }).private_state, [privateState]);
  const legacy = attachmentInstallation(); delete (legacy.manifest as { private_state?: unknown }).private_state;
  assert.equal('private_state' in normalizeAppInstallation(legacy).manifest, false);
});

test('Settings rejects malformed private-state display declarations and unrelated unknown fields', () => {
  for (const value of [[], Array(17).fill(privateState), [privateState, privateState], [{ ...privateState, html: '<script>' }],
    [{ ...privateState, max_records: 33 }], [{ ...privateState, retention_days: 31 }], [{ ...privateState, max_record_bytes: 16385 }],
    [{ ...privateState, max_total_bytes: 131073 }], [{ ...privateState, max_total_bytes: 1 }], [{ ...privateState, schema: { ...privateState.schema, additionalProperties: true } }],
    [{ ...privateState, schema: { ...privateState.schema, required: ['unknown'] } }], [{ ...privateState, schema: { ...privateState.schema, properties: { nested: { type: 'object' } } } }]]) {
    assert.throws(() => normalizeAppInstallation(attachmentInstallation(value)));
  }
  const unknown = attachmentInstallation(); Object.assign(unknown.manifest, { unsafe_css: 'body{}' });
  assert.throws(() => normalizeAppInstallation(unknown));
});

test('Settings preserves exact reviewed file/payload declarations and admits supported PDF display policy', () => {
  const files = { max_file_bytes: 2_097_152, max_files_per_record: 1, max_total_bytes_per_record: 2_097_152, allowed_media_types: ['application/pdf'] };
  const action_payloads = [{ action_key: 'send_message', max_payload_bytes: 4_194_304 }];
  const declaration = { ...privateState, files, action_payloads };
  const fixture = attachmentInstallation([declaration]);
  (fixture.manifest as Record<string, unknown>).runtime_actions = [{ key: 'send_message', label: 'Send', capability_key: 'send', runtime_requirement_key: 'mail' }];
  fixture.manifest.sync_descriptors[0].attachments.allowed_media_types = ['application/pdf'];
  const parsed = normalizeAppInstallation(fixture).manifest;
  assert.equal(parsed.schema_version, '7');
  if (parsed.schema_version !== '7') throw Error('Wrong protocol');
  assert.deepEqual(parsed.private_state, [declaration]);
  assert.deepEqual((parsed.sync_descriptors[0].attachments as { allowed_media_types: string[] }).allowed_media_types, ['application/pdf']);
  for (const state of [{ ...declaration, files: { ...files, max_file_bytes: 2_097_153 } },
    { ...declaration, action_payloads: [{ ...action_payloads[0], max_payload_bytes: 8_388_609 }] },
    { ...declaration, action_payloads: [{ ...action_payloads[0], action_key: 'unknown' }] }]) {
    assert.throws(() => normalizeAppInstallation({ ...fixture, manifest: { ...fixture.manifest, private_state: [state] } }));
  }
  assert.throws(() => normalizeAppInstallation({ ...fixture, manifest: { ...fixture.manifest,
    private_state: [declaration, { ...declaration, key: 'other' }] } }));
});

test('Settings retains the exact personal account setup policy and rejects hidden authority fields', () => {
  const policy = { key: 'personal', resource_key: 'mail', action_keys: [], max_consent_seconds: 86400 };
  const fixture = attachmentInstallation();
  const withPolicy = { ...fixture, manifest: { ...fixture.manifest, owner_connections: [policy] } };
  const parsed = normalizeAppInstallation(withPolicy).manifest;
  assert.equal(parsed.schema_version, '7');
  if (parsed.schema_version !== '7') throw Error('Wrong protocol');
  assert.deepEqual(parsed.owner_connections, [policy]);
  assert.equal('owner_connections' in normalizeAppInstallation(fixture).manifest, false);
  for (const policies of [[], [policy, policy], [{ ...policy, resource_key: 'other' }],
    [{ ...policy, action_keys: ['unknown'] }], [{ ...policy, max_consent_seconds: 90 * 86400 + 1 }],
    [{ ...policy, operator_user_id: 'arbitrary' }], [{ ...policy, eligible_roles: ['guest'] }]]) {
    assert.throws(() => normalizeAppInstallation({ ...withPolicy, manifest: { ...withPolicy.manifest, owner_connections: policies } }));
  }
});
const provenance = {
  source_repository: 'https://example.test/campaigns',
  source_commit: 'abcdef0',
};
const moduleRef = {
  module_id: 'community.deft.campaigns',
  version: '1.0.0',
  manifest_path: 'modules/campaigns/deft.module.json',
  manifest_digest: 'sha256:module',
};
const compatibility = {
  schema: 'deft.app_developer.compatibility.v1',
  app_kit: { package: '@deft/app-kit', versions: ['0.1.0-alpha.1', '0.1.0-alpha.2'] },
  protocol_flows: {
    '0': { package_format: 'deft.app.package.v0', install_mode: 'stage_and_activate' },
    '1': { package_format: 'deft.app.package.v1', install_mode: 'stage_only' },
    '2': { package_format: 'deft.app.package.v2', install_mode: 'stage_only' },
  },
};

function connectedManifest(version = '1.0.0') {
  return {
    schema_version: '1',
    id: 'community.deft.campaigns-app',
    version,
    name: 'Campaigns',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '1' },
    provenance,
    modules: [moduleRef],
    navigation: [],
    dependencies: [{ key: 'contacts', app_id: 'community.deft.contacts-app', version: '1.0.0' }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: moduleRef.module_id, version: moduleRef.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body_text'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts',
          module_id: 'community.deft.contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: { kind: 'private', namespace: 'app_lineage', key: 'send_email', version: '1' },
    }],
    connector_requirements: [{ key: 'mail', provider_kind: 'mcp' }],
    actions: [{
      key: 'send',
      label: 'Send',
      capability_requirement_key: 'send_email',
      connector_requirement_key: 'mail',
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
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'body_text' },
        },
      ],
    }],
  };
}

function installation(protocol: '0' | '1' | '2') {
  const manifest = protocol === '0' ? {
    schema_version: '0',
    id: 'community.deft.campaigns-app',
    version: '1.0.0',
    name: 'Campaigns',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '0' },
    modules: [moduleRef],
    navigation: [],
  } : protocol === '1' ? connectedManifest() : {
    ...connectedManifest(),
    schema_version: '2',
    compatibility: { app_protocol: '2' },
    automation_requests: [{
      key: 'daily_campaign_send',
      label: 'Daily campaign send',
      trigger: { kind: 'daily_local_time' },
      action_key: 'send',
    }],
  };
  return {
    id: 'installation-1',
    version_id: 'version-1',
    app_id: 'community.deft.campaigns-app',
    name: 'Campaigns',
    version: '1.0.0',
    state: 'staged',
    lifecycle_epoch: 0,
    grant_epoch: 0,
    active_version_id: null,
    package_digest: 'sha256:package',
    manifest_digest: 'sha256:manifest',
    manifest,
    created_at: now,
    updated_at: now,
  };
}

test('App installation normalization preserves v0 and expanded connected manifests', () => {
  const v0 = normalizeAppInstallation(installation('0'));
  const v1 = normalizeAppInstallation(installation('1'));
  const v2 = normalizeAppInstallation(installation('2'));
  assert.equal(isConnectedAppManifest(v0.manifest), false);
  assert.equal(isConnectedAppManifest(v1.manifest), true);
  assert.equal(isConnectedAppManifest(v2.manifest), true);
  if (v2.manifest.schema_version === '2') {
    assert.equal(v2.manifest.automation_requests[0].key, 'daily_campaign_send');
  }
  if (isConnectedAppManifest(v1.manifest)) {
    assert.deepEqual(v1.manifest.resource_requirements[1].source, {
      kind: 'dependency_module',
      dependency_key: 'contacts',
      module_id: 'community.deft.contacts',
      version: '1.0.0',
    });
    assert.deepEqual(v1.manifest.capability_requirements[0].interface, {
      kind: 'private', namespace: 'app_lineage', key: 'send_email', version: '1',
    });
    assert.equal(v1.manifest.actions[0].placement.resource_requirement_key, 'campaign');
    assert.equal(v1.manifest.actions[0].input_bindings[0].source.kind, 'selected_relation_field');
  }
});

test('resource App normalization preserves Protocol 5 and never enables v0 activation', () => {
  const base = installation('0');
  const manifest = { ...base.manifest, schema_version: '5', compatibility: { app_protocol: '5' },
    runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v2' }],
    private_capabilities: [], runtime_actions: [], experiences: [], public_actions: [],
    sync_descriptors: [{ key: 'inbox', requested_visibility: 'user_private' }] };
  const app = normalizeAppInstallation({ ...base, manifest });
  assert.equal(app.manifest.schema_version, '5');
  assert.equal(isConnectedAppManifest(app.manifest), false);
  assert.equal(canEnableAppWithoutReview({ ...app, state: 'disabled' }), false);
  if (app.manifest.schema_version === '5') assert.equal(app.manifest.sync_descriptors[0].key, 'inbox');
  assert.throws(() => normalizeAppInstallation({ ...base, manifest: { ...manifest, sync_descriptors: null } }));
  assert.throws(() => normalizeAppInstallation({ ...base, manifest: { ...manifest, schema_version: '4' } }));
});

test('Protocol v0 active and disabled installations expose connected upgrade review', () => {
  const v0 = installation('0') as unknown as Parameters<typeof canStageConnectedUpgrade>[0];
  const v1 = installation('1') as unknown as Parameters<typeof canStageConnectedUpgrade>[0];
  assert.equal(canStageConnectedUpgrade(v0), false, 'fixture starts staged');
  assert.equal(canStageConnectedUpgrade({ ...v0, state: 'active' }), true);
  assert.equal(canStageConnectedUpgrade({ ...v0, state: 'disabled' }), true);
  assert.equal(canStageConnectedUpgrade({ ...v1, state: 'active' }), false);
});

test('only a disabled active Protocol v0 installation can re-enable without connected review', () => {
  const v0 = installation('0') as unknown as Parameters<typeof canEnableAppWithoutReview>[0];
  const v1 = installation('1') as unknown as Parameters<typeof canEnableAppWithoutReview>[0];
  assert.equal(canEnableAppWithoutReview(v0), false, 'fixture starts staged');
  assert.equal(canEnableAppWithoutReview({ ...v0, state: 'active' }), false);
  assert.equal(canEnableAppWithoutReview({ ...v0, state: 'disabled' }), true);
  assert.equal(canEnableAppWithoutReview({ ...v1, state: 'disabled' }), false);
});

test('connected management remains renderable for a v0 installation with a connected review target', () => {
  const source = readFileSync(new URL('../components/apps/connected-app-management.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!installedManifest && !target\)/);
  assert.doesNotMatch(source, /if \(!installedManifest\) return null/);
  assert.match(source, /Stage connected upgrade/);
  assert.match(source, /installedManifest\?\.compatibility\.app_protocol/);
});

test('connected grant management projects staged review, active grants, compatibility, and recent Run data', () => {
  const grants = normalizeAppGrantManagement({ grants: {
    installation: {
      id: 'installation-1', app_id: 'community.deft.campaigns-app', state: 'active', active_version_id: 'version-1',
      active_grant_snapshot_id: 'effective-1', lifecycle_epoch: 1, grant_epoch: 1,
    },
    compatibility,
    versions: [
      {
        id: 'version-2', version: '1.1.0', protocol_version: '1', state: 'staged',
        manifest: connectedManifest('1.1.0'), package_format: 'deft.app.package.v1', provenance,
        provenance_trust: 'local_unsigned', package_digest: 'sha256:package-2', manifest_digest: 'sha256:manifest-2',
        requested_grant_snapshot_id: 'requested-2', staged_at: '2026-09-01T00:03:00.000Z',
        activated_at: null, superseded_at: null,
      },
      {
        id: 'version-1', version: '1.0.0', protocol_version: '1', state: 'active',
        manifest: connectedManifest(), package_format: 'deft.app.package.v1', provenance,
        provenance_trust: 'local_unsigned', package_digest: 'sha256:package-1', manifest_digest: 'sha256:manifest-1',
        requested_grant_snapshot_id: 'requested-1', staged_at: now,
        activated_at: '2026-09-01T00:01:00.000Z', superseded_at: null,
      },
    ],
    snapshots: [
      { id: 'requested-2', app_version_id: 'version-2', snapshot_kind: 'requested', requested_snapshot_id: null, supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:requested-2', reviewed_at: null, created_at: '2026-09-01T00:03:00.000Z' },
      { id: 'requested-1', app_version_id: 'version-1', snapshot_kind: 'requested', requested_snapshot_id: null, supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:requested-1', reviewed_at: null, created_at: now },
      { id: 'effective-1', app_version_id: 'version-1', snapshot_kind: 'effective', requested_snapshot_id: 'requested-1', supersedes_snapshot_id: null, resource_rights: [{}], classification: {}, snapshot_digest: 'sha256:effective', reviewed_at: '2026-09-01T00:01:00.000Z', created_at: '2026-09-01T00:01:00.000Z' },
    ],
    review_target: {
      activation_kind: 'upgrade',
      app_version_id: 'version-2',
      version: '1.1.0',
      protocol_version: '1',
      package_format: 'deft.app.package.v1',
      package_digest: 'sha256:package-2',
      manifest_digest: 'sha256:manifest-2',
      manifest: connectedManifest('1.1.0'),
      provenance,
      provenance_trust: 'local_unsigned',
      requested_snapshot_id: 'requested-2',
      requested_snapshot_digest: 'sha256:requested-2',
      requested_authority: {
        resource_rights: [{
          requirement_key: 'campaign',
          source: { kind: 'included_module', module_id: moduleRef.module_id, version: moduleRef.version },
          resource_type: 'campaigns',
          fields: ['subject', 'body_text'],
          right: 'read',
        }],
        classification: { review_required: true },
      },
      dependency_requirements: [{
        key: 'contacts', app_id: 'community.deft.contacts-app', version: '1.0.0', status: 'ready',
        installation_id: 'contacts-installation', active_version: '1.0.0', lifecycle_epoch: 2,
      }],
      connector_requirements: [{
        key: 'mail',
        provider_kind: 'mcp',
        required_operations: ['send_email'],
        current_binding: {
          mcp_connection_id: 'connection-1', name: 'Sandbox mail', binding_digest: 'sha256:binding',
          authorization_version: 3, configured: true,
        },
        candidates: [{
          id: 'connection-1', name: 'Sandbox mail', status: 'configured', eligible_for_review: true,
          authorization_version: 3, provider_schema_check: 'pending_review',
        }],
      }],
      missing_binding_keys: [],
      readiness: { dependencies_ready: true, connector_candidates_ready: true },
    },
    dependencies: [{
      id: 'dependency-1', grant_snapshot_id: 'effective-1', dependency_key: 'contacts',
      required_app_id: 'community.deft.contacts-app', required_version: '1.0.0',
      dependency_installation_id: 'contacts-installation', dependency_version_id: 'contacts-version',
      dependency_lifecycle_epoch: 2, ownership: 'preexisting', lock_digest: 'sha256:lock',
    }],
    action_bindings: [{
      id: 'binding-1', grant_snapshot_id: 'effective-1', action_key: 'send',
      capability_requirement_key: 'send_email', connector_requirement_key: 'mail',
      interface_identity: 'private:app_lineage:send_email:1', provider_kind: 'mcp',
      mcp_connection_id: 'connection-1', operation_name: 'send_email', operation_schema_digest: 'sha256:schema',
      connector_authorization_version: 3, binding_digest: 'sha256:binding',
      host_policy: {
        risk_class: 'external_write', review_requirement: 'always', review_scope: 'full', egress_class: 'external',
        retry_class: 'idempotent_with_key', retention_class: 'standard', automation_eligibility: 'denied',
        provider_idempotency_key_required: true,
      },
    }],
    recent_runs: [{
      id: 'run-1', state: 'pending_approval', operation_name: 'send_email',
      safe_preview: { title: 'Send campaign', summary: 'One recipient' }, safe_outcome: null,
      risk_class: 'external_write', review_requirement: 'always',
      result_expires_at: '2026-09-08T00:02:00.000Z', result_purged_at: null, terminal_at: null,
      created_at: '2026-09-01T00:02:00.000Z', updated_at: '2026-09-01T00:02:00.000Z',
    }],
  } });

  assert.deepEqual(grants.compatibility, compatibility);
  assert.deepEqual(grants.versions[0].provenance, provenance);
  assert.equal(grants.versions[0].provenance_trust, 'local_unsigned');
  assert.equal(grants.review_target?.activation_kind, 'upgrade');
  assert.equal(grants.review_target?.dependency_requirements[0].status, 'ready');
  assert.deepEqual(grants.review_target?.connector_requirements[0].required_operations, ['send_email']);
  assert.deepEqual(grants.review_target?.missing_binding_keys, []);
  assert.equal(grants.snapshots.find((snapshot) => snapshot.snapshot_kind === 'effective')?.snapshot_digest, 'sha256:effective');
  assert.equal(grants.action_bindings[0].grant_snapshot_id, 'effective-1');
  assert.equal(grants.dependencies[0].grant_snapshot_id, 'effective-1');
  assert.deepEqual(grants.recent_runs[0], {
    id: 'run-1', state: 'pending_approval', title: 'Send campaign', summary: 'One recipient', outcome_summary: null,
    operation_name: 'send_email', risk_class: 'external_write', review_requirement: 'always',
    result_expires_at: '2026-09-08T00:02:00.000Z', result_purged_at: null, terminal_at: null,
    created_at: '2026-09-01T00:02:00.000Z', updated_at: '2026-09-01T00:02:00.000Z',
  });
});

test('App Run receipt normalization returns only the bounded verified projection', () => {
  const raw = {
    run: {
      id: 'run-1',
      state: 'succeeded',
      operation_name: 'send_email',
      safe_preview: { title: 'Send campaign', summary: 'One recipient' },
      safe_outcome: { summary: 'Accepted by provider' },
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'full',
      retry_class: 'idempotent_with_key',
      retention_class: 'standard',
      result_expires_at: '2026-09-08T00:02:00.000Z',
      result_purged_at: null,
      envelope: { secret: 'forbidden-run-envelope' },
      signature: 'forbidden-run-signature',
      signature_hmac: 'forbidden-run-hmac',
      actor: { user_id: 'forbidden-run-actor' },
      provider: { provider_instance_id: 'forbidden-run-provider' },
    },
    receipts: [{
      receipt_id: 'receipt-1',
      receipt_kind: 'attempt_terminal',
      run_state: 'succeeded',
      occurred_at: '2026-09-01T00:02:00.000Z',
      envelope_digest: 'sha256:receipt',
      signing_key_version: 'sig-v1',
      signed_at: '2026-09-01T00:02:00.000Z',
      verified: true,
      envelope: { secret: 'forbidden-receipt-envelope' },
      signature: 'forbidden-receipt-signature',
      signature_hmac: 'forbidden-receipt-hmac',
      actor: { user_id: 'forbidden-receipt-actor' },
      provider: { provider_instance_id: 'forbidden-receipt-provider' },
    }],
    envelope: { secret: 'forbidden-bundle-envelope' },
    signature: 'forbidden-bundle-signature',
    actor: { user_id: 'forbidden-bundle-actor' },
    provider: { provider_instance_id: 'forbidden-bundle-provider' },
  };

  const bundle = normalizeAppRunReceiptBundle(raw);
  assert.deepEqual(bundle, {
    run: {
      id: 'run-1',
      state: 'succeeded',
      operation_name: 'send_email',
      title: 'Send campaign',
      summary: 'One recipient',
      outcome_summary: 'Accepted by provider',
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'full',
      retry_class: 'idempotent_with_key',
      retention_class: 'standard',
      result_expires_at: '2026-09-08T00:02:00.000Z',
      result_purged_at: null,
    },
    receipts: [{
      receipt_id: 'receipt-1',
      receipt_kind: 'attempt_terminal',
      run_state: 'succeeded',
      occurred_at: '2026-09-01T00:02:00.000Z',
      envelope_digest: 'sha256:receipt',
      signing_key_version: 'sig-v1',
      signed_at: '2026-09-01T00:02:00.000Z',
      verified: true,
    }],
  });

  const serialized = JSON.stringify(bundle);
  for (const forbidden of [
    'forbidden-run-envelope', 'forbidden-run-signature', 'forbidden-run-hmac', 'forbidden-run-actor',
    'forbidden-run-provider', 'forbidden-receipt-envelope', 'forbidden-receipt-signature',
    'forbidden-receipt-hmac', 'forbidden-receipt-actor', 'forbidden-receipt-provider',
    'forbidden-bundle-envelope', 'forbidden-bundle-signature', 'forbidden-bundle-actor', 'forbidden-bundle-provider',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden));
});

test('App Run receipt normalization rejects an unverified receipt', () => {
  assert.throws(() => normalizeAppRunReceiptBundle({
    run: {
      id: 'run-1', state: 'succeeded', operation_name: 'send_email', safe_preview: {}, safe_outcome: null,
      risk_class: 'external_write', review_requirement: 'always', review_scope: 'full',
      retry_class: 'idempotent_with_key', retention_class: 'standard',
      result_expires_at: '2026-09-08T00:02:00.000Z', result_purged_at: null,
    },
    receipts: [{
      receipt_id: 'receipt-1', receipt_kind: 'attempt_terminal', run_state: 'succeeded',
      occurred_at: now, envelope_digest: 'sha256:receipt', signing_key_version: 'sig-v1', signed_at: now,
      verified: false,
    }],
  }), /not verified/);
});

test('review and health normalizers keep only safe management fields', () => {
  const review = normalizeConnectedAppReview({ review: {
    review_version: 'deft.app_review.v1', app_installation_id: 'installation-1', app_version_id: 'version-1',
    package_digest: 'sha256:package', requested_snapshot_id: 'requested-1', requested_snapshot_digest: 'sha256:requested',
    lifecycle_epoch: 0, grant_epoch: 0,
    permission_diff: { kind: 'initial', carry_forward_eligible: false, changed_atoms: ['action:send'], prior_authority_surface_digest: null, proposed_authority_surface_digest: 'sha256:surface' },
    classification: {}, resource_rights: [{}], dependencies: [],
    module_adoptions: [{ module_id: 'com.deft.contacts', module_installation_id: 'crm-1', name: 'Contacts', is_enabled: true, agent_access: 'read', private_value: 'must not leak' }],
    action_bindings: [{ action_key: 'send', capability_requirement_key: 'send_email', connector_requirement_key: 'mail', interface_identity: 'private:app_lineage:send_email:1', provider_kind: 'mcp', mcp_connection_id: 'connection-1', operation_name: 'send_email', operation_schema_digest: 'sha256:schema', connector_authorization_version: 1, binding_digest: 'sha256:binding' }],
    authority_surface_digest: 'sha256:surface', review_digest: 'sha256:review',
  } });
  const health = normalizeConnectedAppHealth({ health: { status: 'unhealthy', installation_id: 'installation-1', active_grant_snapshot_id: null, lifecycle_epoch: 0, grant_epoch: 0, checked_provider_schemas: true, issues: [{ code: 'APP_NOT_ACTIVE', subject_id: 'installation-1', message: 'The App is not active' }] } });
  assert.equal(review.permission_diff.kind, 'initial');
  assert.deepEqual(review.module_adoptions, [{ module_id: 'com.deft.contacts', module_installation_id: 'crm-1', name: 'Contacts', is_enabled: true, agent_access: 'read' }]);
  assert.equal(review.action_bindings[0].mcp_connection_id, 'connection-1');
  assert.equal(health.issues[0].code, 'APP_NOT_ACTIVE');
});
