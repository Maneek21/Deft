export const APP_PACKAGE_MAX_BYTES = 1024 * 1024;

export type AppModuleReference = {
  module_id: string;
  version: string;
  manifest_path: string;
  manifest_digest: string;
};

type AppManifestBase = {
  id: string;
  version: string;
  name: string;
  description?: string;
  license: string;
  provenance?: { source_repository: string; source_commit: string };
  modules: AppModuleReference[];
  navigation: Array<{ key: string; label: string; module_id: string; collection_key: string; view_key?: string }>;
};

export type AppManifestV0 = AppManifestBase & {
  schema_version: '0';
  compatibility: { app_protocol: '0' };
};

export type AppResourceSource =
  | { kind: 'included_module'; module_id: string; version: string }
  | { kind: 'dependency_module'; dependency_key: string; module_id: string; version: string };

export type AppActionInputSource =
  | { kind: 'resource_field'; resource_requirement_key: string; field_key: string }
  | {
      kind: 'selected_relation_field';
      source_resource_requirement_key: string;
      relation_field_key: string;
      target_resource_requirement_key: string;
      target_field_key: string;
      selection: 'one';
    }
  | { kind: 'user_input'; input_type: 'email' | 'text'; label: string; required: true };

export type AppManifestV1 = AppManifestBase & {
  schema_version: '1';
  compatibility: { app_protocol: '1' };
  dependencies: Array<{ key: string; app_id: string; version: string }>;
  resource_requirements: Array<{
    key: string;
    source: AppResourceSource;
    resource_type: string;
    fields: string[];
  }>;
  capability_requirements: Array<{
    key: string;
    interface: { kind: 'private'; namespace: 'app_lineage'; key: string; version: string };
  }>;
  connector_requirements: Array<{ key: string; provider_kind: 'mcp' }>;
  actions: Array<{
    key: string;
    label: string;
    capability_requirement_key: string;
    connector_requirement_key: string;
    placement: { kind: 'resource_detail'; resource_requirement_key: string };
    input_bindings: Array<{ input_key: 'to' | 'subject' | 'body_text'; source: AppActionInputSource }>;
  }>;
};

export type AppManifest = AppManifestV0 | AppManifestV1;

export function isConnectedAppManifest(manifest: AppManifest): manifest is AppManifestV1 {
  return manifest.compatibility.app_protocol === '1';
}

export type AppInstallation = {
  id: string;
  version_id: string;
  app_id: string;
  name: string;
  version: string;
  state: 'staged' | 'active' | 'disabled' | 'failed';
  lifecycle_epoch: number;
  grant_epoch: number;
  active_version_id: string | null;
  package_digest: string;
  manifest_digest: string;
  manifest: AppManifest;
  created_at: string;
  updated_at: string;
};

export type AppInspection = {
  manifest: AppManifest;
  package_format: 'deft.app.package.v0' | 'deft.app.package.v1';
  manifest_digest: string;
  package_digest: string;
  canonical_package_json: string;
  permissions: unknown[];
};

export type AppGrantVersion = {
  id: string;
  version: string;
  protocol_version: '0' | '1';
  state: string;
  manifest: AppManifest;
  package_format: 'deft.app.package.v0' | 'deft.app.package.v1';
  provenance: AppManifestBase['provenance'] | null;
  provenance_trust: 'local_unsigned';
  package_digest: string;
  manifest_digest: string;
  requested_grant_snapshot_id: string | null;
  staged_at: string;
  activated_at: string | null;
  superseded_at: string | null;
};

export type AppGrantSnapshot = {
  id: string;
  app_version_id: string;
  snapshot_kind: 'requested' | 'effective';
  requested_snapshot_id: string | null;
  supersedes_snapshot_id: string | null;
  resource_rights: unknown[];
  classification: Record<string, unknown>;
  snapshot_digest: string;
  reviewed_at: string | null;
  created_at: string;
};

export type AppDependencyLock = {
  id: string;
  grant_snapshot_id: string;
  dependency_key: string;
  required_app_id: string;
  required_version: string;
  dependency_installation_id: string;
  dependency_version_id: string;
  dependency_lifecycle_epoch: number;
  ownership: 'preexisting';
  lock_digest: string;
};

export type AppActionBinding = {
  id: string;
  grant_snapshot_id: string;
  action_key: string;
  capability_requirement_key: string;
  connector_requirement_key: string;
  interface_identity: string;
  provider_kind: 'mcp';
  mcp_connection_id: string;
  operation_name: string;
  operation_schema_digest: string;
  connector_authorization_version: number;
  binding_digest: string;
  host_policy: {
    risk_class: string;
    review_requirement: string;
    review_scope: string;
    egress_class: string;
    retry_class: string;
    retention_class: string;
    automation_eligibility: string;
    provider_idempotency_key_required: boolean;
  };
};

export type AppRunSummary = {
  id: string;
  state: 'pending' | 'pending_approval' | 'running' | 'waiting_external' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown_outcome';
  title: string;
  summary: string | null;
  outcome_summary: string | null;
  operation_name: string;
  risk_class: string;
  review_requirement: string;
  result_expires_at: string;
  result_purged_at: string | null;
  terminal_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AppRunReceiptBundle = {
  run: {
    id: string;
    state: AppRunSummary['state'];
    operation_name: string;
    title: string;
    summary: string | null;
    outcome_summary: string | null;
    risk_class: string;
    review_requirement: string;
    review_scope: string;
    retry_class: string;
    retention_class: string;
    result_expires_at: string;
    result_purged_at: string | null;
  };
  receipts: Array<{
    receipt_id: string;
    receipt_kind: 'approval' | 'attempt_terminal' | 'reconciliation' | 'repair';
    run_state: AppRunSummary['state'];
    occurred_at: string;
    envelope_digest: string;
    signing_key_version: string;
    signed_at: string;
    verified: true;
  }>;
};

export type AppHostCompatibility = {
  schema: string;
  app_kit: { package: string; versions: string[] };
  protocol_flows: {
    '0': { package_format: 'deft.app.package.v0'; install_mode: 'stage_and_activate' };
    '1': { package_format: 'deft.app.package.v1'; install_mode: 'stage_only' };
  };
};

export type ConnectedAppReviewTarget = {
  activation_kind: 'initial' | 'upgrade' | 'reenable';
  app_version_id: string;
  version: string;
  protocol_version: '1';
  package_format: 'deft.app.package.v1';
  package_digest: string;
  manifest_digest: string;
  manifest: AppManifestV1;
  provenance: AppManifestBase['provenance'] | null;
  provenance_trust: 'local_unsigned';
  requested_snapshot_id: string;
  requested_snapshot_digest: string;
  requested_authority: {
    resource_rights: Array<{
      requirement_key: string;
      source: AppResourceSource;
      resource_type: string;
      fields: string[];
      right: 'read';
    }>;
    classification: Record<string, unknown>;
  };
  dependency_requirements: Array<{
    key: string;
    app_id: string;
    version: string;
    status: 'ready' | 'missing' | 'disabled' | 'version_mismatch';
    installation_id: string | null;
    active_version: string | null;
    lifecycle_epoch: number | null;
  }>;
  connector_requirements: Array<{
    key: string;
    provider_kind: 'mcp';
    required_operations: string[];
    current_binding: {
      mcp_connection_id: string;
      name: string;
      binding_digest: string;
      authorization_version: number;
      configured: boolean;
    } | null;
    candidates: Array<{
      id: string;
      name: string;
      status: 'inactive' | 'unhealthy' | 'configured' | 'operation_disabled';
      eligible_for_review: boolean;
      authorization_version: number;
      provider_schema_check: 'pending_review';
    }>;
  }>;
  missing_binding_keys: string[];
  readiness: { dependencies_ready: boolean; connector_candidates_ready: boolean };
};

export type AppGrantManagement = {
  installation: {
    id: string;
    app_id: string;
    state: AppInstallation['state'];
    active_version_id: string | null;
    active_grant_snapshot_id: string | null;
    lifecycle_epoch: number;
    grant_epoch: number;
  };
  compatibility: AppHostCompatibility;
  versions: AppGrantVersion[];
  snapshots: AppGrantSnapshot[];
  review_target: ConnectedAppReviewTarget | null;
  dependencies: AppDependencyLock[];
  action_bindings: AppActionBinding[];
  recent_runs: AppRunSummary[];
};

export type ConnectedAppReview = {
  review_version: string;
  app_installation_id: string;
  app_version_id: string;
  package_digest: string;
  requested_snapshot_id: string;
  requested_snapshot_digest: string;
  lifecycle_epoch: number;
  grant_epoch: number;
  permission_diff: {
    kind: 'initial' | 'unchanged' | 'widening_or_incompatible';
    carry_forward_eligible: boolean;
    changed_atoms: string[];
    prior_authority_surface_digest: string | null;
    proposed_authority_surface_digest: string;
  };
  classification: Record<string, unknown>;
  resource_rights: unknown[];
  dependencies: Array<{
    dependency_key: string;
    required_app_id: string;
    required_version: string;
    dependency_installation_id: string;
    dependency_version_id: string;
    dependency_lifecycle_epoch: number;
    ownership: 'preexisting';
    lock_digest: string;
  }>;
  action_bindings: Array<{
    action_key: string;
    capability_requirement_key: string;
    connector_requirement_key: string;
    interface_identity: string;
    provider_kind: 'mcp';
    mcp_connection_id: string;
    operation_name: string;
    operation_schema_digest: string;
    connector_authorization_version: number;
    binding_digest: string;
  }>;
  authority_surface_digest: string;
  review_digest: string;
};

export type ConnectedAppHealth = {
  status: 'healthy' | 'unhealthy';
  installation_id: string;
  active_grant_snapshot_id: string | null;
  lifecycle_epoch: number;
  grant_epoch: number;
  checked_provider_schemas: boolean;
  issues: Array<{ code: string; subject_id: string; message: string }>;
};

export type AppConnector = {
  id: string;
  name: string;
  is_active: boolean;
  connection_error: string | null;
};

type UnknownRecord = Record<string, unknown>;

function object(value: unknown, label = 'App response'): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as UnknownRecord;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label}.`);
  return value;
}

function packageFormat(value: unknown): 'deft.app.package.v0' | 'deft.app.package.v1' {
  if (value !== 'deft.app.package.v0' && value !== 'deft.app.package.v1') {
    throw new Error('Invalid App package format.');
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, label);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value.map((entry) => stringValue(entry, label));
}

function recordArray(value: unknown, label: string): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value.map((entry) => object(entry, label));
}

function normalizeModuleReference(value: unknown): AppModuleReference {
  const row = object(value, 'App Module reference');
  return {
    module_id: stringValue(row.module_id, 'App Module identity'),
    version: stringValue(row.version, 'App Module version'),
    manifest_path: stringValue(row.manifest_path, 'App Module path'),
    manifest_digest: stringValue(row.manifest_digest, 'App Module digest'),
  };
}

function normalizeResourceSource(value: unknown): AppResourceSource {
  const row = object(value, 'App resource source');
  if (row.kind === 'included_module') return {
    kind: 'included_module',
    module_id: stringValue(row.module_id, 'App resource Module'),
    version: stringValue(row.version, 'App resource Module version'),
  };
  if (row.kind === 'dependency_module') return {
    kind: 'dependency_module',
    dependency_key: stringValue(row.dependency_key, 'App resource dependency'),
    module_id: stringValue(row.module_id, 'App resource Module'),
    version: stringValue(row.version, 'App resource Module version'),
  };
  throw new Error('Invalid App resource source.');
}

function normalizeActionInputSource(value: unknown): AppActionInputSource {
  const row = object(value, 'App action input source');
  if (row.kind === 'resource_field') return {
    kind: 'resource_field',
    resource_requirement_key: stringValue(row.resource_requirement_key, 'App action resource requirement'),
    field_key: stringValue(row.field_key, 'App action resource field'),
  };
  if (row.kind === 'selected_relation_field') {
    if (row.selection !== 'one') throw new Error('Invalid App action relation selection.');
    return {
      kind: 'selected_relation_field',
      source_resource_requirement_key: stringValue(row.source_resource_requirement_key, 'App action source resource'),
      relation_field_key: stringValue(row.relation_field_key, 'App action relation field'),
      target_resource_requirement_key: stringValue(row.target_resource_requirement_key, 'App action target resource'),
      target_field_key: stringValue(row.target_field_key, 'App action target field'),
      selection: 'one',
    };
  }
  if (row.kind === 'user_input') {
    if ((row.input_type !== 'email' && row.input_type !== 'text') || row.required !== true) {
      throw new Error('Invalid App action user input.');
    }
    return {
      kind: 'user_input',
      input_type: row.input_type,
      label: stringValue(row.label, 'App action input label'),
      required: true,
    };
  }
  throw new Error('Invalid App action input source.');
}

function normalizeManifest(value: unknown): AppManifest {
  const row = object(value, 'App manifest');
  const compatibility = object(row.compatibility, 'App compatibility');
  const protocol = compatibility.app_protocol;
  if (protocol !== '0' && protocol !== '1') throw new Error('Unsupported App protocol.');
  if (row.schema_version !== protocol) throw new Error('App manifest protocol and schema do not match.');
  const base: AppManifestBase = {
    id: stringValue(row.id, 'App identity'),
    version: stringValue(row.version, 'App version'),
    name: stringValue(row.name, 'App name'),
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
    license: stringValue(row.license, 'App license'),
    modules: recordArray(row.modules, 'App Modules').map(normalizeModuleReference),
    navigation: recordArray(row.navigation ?? [], 'App navigation').map((entry) => ({
      key: stringValue(entry.key, 'App navigation key'),
      label: stringValue(entry.label, 'App navigation label'),
      module_id: stringValue(entry.module_id, 'App navigation Module'),
      collection_key: stringValue(entry.collection_key, 'App navigation collection'),
      ...(typeof entry.view_key === 'string' ? { view_key: entry.view_key } : {}),
    })),
    ...(row.provenance ? {
      provenance: (() => {
        const provenance = object(row.provenance, 'App provenance');
        return {
          source_repository: stringValue(provenance.source_repository, 'App source repository'),
          source_commit: stringValue(provenance.source_commit, 'App source commit'),
        };
      })(),
    } : {}),
  };
  if (protocol === '0') return { ...base, schema_version: '0', compatibility: { app_protocol: '0' } };
  return {
    ...base,
    schema_version: '1',
    compatibility: { app_protocol: '1' },
    dependencies: recordArray(row.dependencies ?? [], 'App dependencies').map((entry) => ({
      key: stringValue(entry.key, 'App dependency key'),
      app_id: stringValue(entry.app_id, 'App dependency identity'),
      version: stringValue(entry.version, 'App dependency version'),
    })),
    resource_requirements: recordArray(row.resource_requirements ?? [], 'App resource requirements').map((entry) => ({
      key: stringValue(entry.key, 'App resource requirement key'),
      source: normalizeResourceSource(entry.source),
      resource_type: stringValue(entry.resource_type, 'App resource type'),
      fields: stringArray(entry.fields ?? [], 'App resource fields'),
    })),
    capability_requirements: recordArray(row.capability_requirements ?? [], 'App capability requirements').map((entry) => {
      const descriptor = object(entry.interface, 'App capability interface');
      if (descriptor.kind !== 'private' || descriptor.namespace !== 'app_lineage') {
        throw new Error('Unsupported App capability interface.');
      }
      return {
        key: stringValue(entry.key, 'App capability requirement key'),
        interface: {
          kind: 'private' as const,
          namespace: 'app_lineage' as const,
          key: stringValue(descriptor.key, 'App capability interface key'),
          version: stringValue(descriptor.version, 'App capability interface version'),
        },
      };
    }),
    connector_requirements: recordArray(row.connector_requirements ?? [], 'App connector requirements').map((entry) => {
      if (entry.provider_kind !== 'mcp') throw new Error('Unsupported App connector provider.');
      return { key: stringValue(entry.key, 'App connector requirement key'), provider_kind: 'mcp' as const };
    }),
    actions: recordArray(row.actions ?? [], 'App actions').map((entry) => {
      const placement = object(entry.placement, 'App action placement');
      if (placement.kind !== 'resource_detail') throw new Error('Unsupported App action placement.');
      return {
        key: stringValue(entry.key, 'App action key'),
        label: stringValue(entry.label, 'App action label'),
        capability_requirement_key: stringValue(entry.capability_requirement_key, 'App action capability'),
        connector_requirement_key: stringValue(entry.connector_requirement_key, 'App action connector'),
        placement: {
          kind: 'resource_detail' as const,
          resource_requirement_key: stringValue(
            placement.resource_requirement_key,
            'App action placement resource',
          ),
        },
        input_bindings: recordArray(entry.input_bindings ?? [], 'App action input bindings').map((binding) => {
          if (binding.input_key !== 'to' && binding.input_key !== 'subject' && binding.input_key !== 'body_text') {
            throw new Error('Unsupported App action input key.');
          }
          return { input_key: binding.input_key, source: normalizeActionInputSource(binding.source) };
        }),
      };
    }),
  };
}

export function normalizeAppInstallation(value: unknown): AppInstallation {
  const row = object(value, 'App installation response');
  const state = row.state;
  if (state !== 'staged' && state !== 'active' && state !== 'disabled' && state !== 'failed') throw new Error('Invalid App installation state.');
  return {
    id: stringValue(row.id, 'App installation identity'),
    version_id: stringValue(row.version_id, 'App version identity'),
    app_id: stringValue(row.app_id, 'App identity'),
    name: stringValue(row.name, 'App name'),
    version: stringValue(row.version, 'App version'),
    state,
    lifecycle_epoch: integer(row.lifecycle_epoch, 'App lifecycle epoch'),
    grant_epoch: integer(row.grant_epoch, 'App grant epoch'),
    active_version_id: nullableString(row.active_version_id, 'active App version identity'),
    package_digest: stringValue(row.package_digest, 'App package digest'),
    manifest_digest: stringValue(row.manifest_digest, 'App manifest digest'),
    manifest: normalizeManifest(row.manifest),
    created_at: stringValue(row.created_at, 'App created time'),
    updated_at: stringValue(row.updated_at, 'App updated time'),
  };
}

export function normalizeAppsResponse(value: unknown): AppInstallation[] {
  const rows = object(value).apps;
  if (!Array.isArray(rows)) throw new Error('Invalid Apps response.');
  return rows.map(normalizeAppInstallation);
}

export function normalizeAppInspection(value: unknown): AppInspection {
  const body = object(value, 'App inspection response');
  const row = object(body.inspection ?? value, 'App inspection');
  const packageValue = object(row.package, 'App package');
  if (!Array.isArray(row.permissions)) throw new Error('Invalid App inspection permissions.');
  return {
    manifest: normalizeManifest(row.manifest),
    package_format: packageFormat(packageValue.package_format),
    manifest_digest: stringValue(row.manifest_digest, 'App manifest digest'),
    package_digest: stringValue(row.package_digest, 'App package digest'),
    canonical_package_json: stringValue(row.canonical_package_json, 'canonical App package'),
    permissions: row.permissions,
  };
}

function normalizeRunSummary(value: unknown): AppRunSummary {
  const row = object(value, 'App Run summary');
  const state = row.state;
  if (!['pending', 'pending_approval', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(String(state))) throw new Error('Invalid App Run state.');
  const preview = row.safe_preview ? object(row.safe_preview, 'App Run preview') : {};
  const outcome = row.safe_outcome ? object(row.safe_outcome, 'App Run outcome') : {};
  return {
    id: stringValue(row.id, 'App Run identity'),
    state: state as AppRunSummary['state'],
    title: typeof preview.title === 'string' && preview.title.trim() ? preview.title : 'App action',
    summary: typeof preview.summary === 'string' ? preview.summary : null,
    outcome_summary: typeof outcome.summary === 'string' ? outcome.summary : null,
    operation_name: stringValue(row.operation_name, 'App Run operation'),
    risk_class: stringValue(row.risk_class, 'App Run risk class'),
    review_requirement: stringValue(row.review_requirement, 'App Run review requirement'),
    result_expires_at: stringValue(row.result_expires_at, 'App Run result expiry'),
    result_purged_at: nullableString(row.result_purged_at, 'App Run result purge time'),
    terminal_at: nullableString(row.terminal_at, 'App Run terminal time'),
    created_at: stringValue(row.created_at, 'App Run created time'),
    updated_at: stringValue(row.updated_at, 'App Run updated time'),
  };
}

export function normalizeAppRunReceiptBundle(value: unknown): AppRunReceiptBundle {
  const body = object(value, 'App Run receipt response');
  const run = object(body.run, 'App Run receipt metadata');
  const state = run.state;
  if (!['pending', 'pending_approval', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(String(state))) {
    throw new Error('Invalid App Run receipt state.');
  }
  const preview = run.safe_preview ? object(run.safe_preview, 'App Run receipt preview') : {};
  const outcome = run.safe_outcome ? object(run.safe_outcome, 'App Run receipt outcome') : {};
  const receipts = recordArray(body.receipts ?? [], 'App Run receipts').map((receipt) => {
    if (!['approval', 'attempt_terminal', 'reconciliation', 'repair'].includes(String(receipt.receipt_kind))) {
      throw new Error('Invalid App Run receipt kind.');
    }
    if (!['pending', 'pending_approval', 'running', 'waiting_external', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].includes(String(receipt.run_state))) {
      throw new Error('Invalid App Run receipt state.');
    }
    if (receipt.verified !== true) throw new Error('App Run receipt is not verified.');
    return {
      receipt_id: stringValue(receipt.receipt_id, 'App Run receipt identity'),
      receipt_kind: receipt.receipt_kind as AppRunReceiptBundle['receipts'][number]['receipt_kind'],
      run_state: receipt.run_state as AppRunSummary['state'],
      occurred_at: stringValue(receipt.occurred_at, 'App Run receipt time'),
      envelope_digest: stringValue(receipt.envelope_digest, 'App Run receipt digest'),
      signing_key_version: stringValue(receipt.signing_key_version, 'App Run receipt signing key'),
      signed_at: stringValue(receipt.signed_at, 'App Run receipt signature time'),
      verified: true as const,
    };
  });
  return {
    run: {
      id: stringValue(run.id, 'App Run identity'),
      state: state as AppRunSummary['state'],
      operation_name: stringValue(run.operation_name, 'App Run operation'),
      title: typeof preview.title === 'string' && preview.title.trim() ? preview.title : 'App action',
      summary: typeof preview.summary === 'string' ? preview.summary : null,
      outcome_summary: typeof outcome.summary === 'string' ? outcome.summary : null,
      risk_class: stringValue(run.risk_class, 'App Run risk class'),
      review_requirement: stringValue(run.review_requirement, 'App Run review requirement'),
      review_scope: stringValue(run.review_scope, 'App Run review scope'),
      retry_class: stringValue(run.retry_class, 'App Run retry class'),
      retention_class: stringValue(run.retention_class, 'App Run retention class'),
      result_expires_at: stringValue(run.result_expires_at, 'App Run result expiry'),
      result_purged_at: nullableString(run.result_purged_at, 'App Run result purge time'),
    },
    receipts,
  };
}

function normalizeHostCompatibility(value: unknown): AppHostCompatibility {
  const row = object(value, 'App host compatibility');
  const appKit = object(row.app_kit, 'App Kit compatibility');
  const flows = object(row.protocol_flows, 'App protocol flows');
  const v0 = object(flows['0'], 'App Protocol v0 flow');
  const v1 = object(flows['1'], 'App Protocol v1 flow');
  if (v0.install_mode !== 'stage_and_activate' || v1.install_mode !== 'stage_only') {
    throw new Error('Invalid App install flow.');
  }
  const v0Format = packageFormat(v0.package_format);
  const v1Format = packageFormat(v1.package_format);
  if (v0Format !== 'deft.app.package.v0' || v1Format !== 'deft.app.package.v1') {
    throw new Error('Invalid App protocol package format.');
  }
  return {
    schema: stringValue(row.schema, 'App compatibility schema'),
    app_kit: {
      package: stringValue(appKit.package, 'App Kit package'),
      versions: stringArray(appKit.versions, 'App Kit versions'),
    },
    protocol_flows: {
      '0': { package_format: v0Format, install_mode: 'stage_and_activate' },
      '1': { package_format: v1Format, install_mode: 'stage_only' },
    },
  };
}

function normalizeConnectedAppReviewTarget(value: unknown): ConnectedAppReviewTarget | null {
  if (value === null || value === undefined) return null;
  const row = object(value, 'connected App review target');
  if (row.activation_kind !== 'initial' && row.activation_kind !== 'upgrade' && row.activation_kind !== 'reenable') {
    throw new Error('Invalid connected App activation kind.');
  }
  if (row.protocol_version !== '1' || packageFormat(row.package_format) !== 'deft.app.package.v1') {
    throw new Error('Invalid connected App review protocol.');
  }
  if (row.provenance_trust !== 'local_unsigned') throw new Error('Invalid App provenance trust.');
  const manifest = normalizeManifest(row.manifest);
  if (!isConnectedAppManifest(manifest)) throw new Error('Invalid connected App review manifest.');
  const authority = object(row.requested_authority, 'requested App authority');
  const dependencies = recordArray(row.dependency_requirements ?? [], 'App dependency requirements').map((entry) => {
    if (!['ready', 'missing', 'disabled', 'version_mismatch'].includes(String(entry.status))) {
      throw new Error('Invalid App dependency status.');
    }
    return {
      key: stringValue(entry.key, 'App dependency key'),
      app_id: stringValue(entry.app_id, 'App dependency identity'),
      version: stringValue(entry.version, 'App dependency version'),
      status: entry.status as ConnectedAppReviewTarget['dependency_requirements'][number]['status'],
      installation_id: nullableString(entry.installation_id, 'App dependency installation'),
      active_version: nullableString(entry.active_version, 'active dependency version'),
      lifecycle_epoch: nullableInteger(entry.lifecycle_epoch, 'dependency lifecycle epoch'),
    };
  });
  const connectors = recordArray(row.connector_requirements ?? [], 'App connector requirements').map((entry) => {
    if (entry.provider_kind !== 'mcp') throw new Error('Invalid App connector provider.');
    const currentValue = entry.current_binding;
    const current = currentValue === null || currentValue === undefined ? null : (() => {
      const binding = object(currentValue, 'current App connector binding');
      return {
        mcp_connection_id: stringValue(binding.mcp_connection_id, 'App connector identity'),
        name: stringValue(binding.name, 'App connector name'),
        binding_digest: stringValue(binding.binding_digest, 'App connector binding digest'),
        authorization_version: integer(binding.authorization_version, 'App connector authorization version'),
        configured: binding.configured === true,
      };
    })();
    return {
      key: stringValue(entry.key, 'App connector requirement key'),
      provider_kind: 'mcp' as const,
      required_operations: stringArray(entry.required_operations ?? [], 'App connector operations'),
      current_binding: current,
      candidates: recordArray(entry.candidates ?? [], 'App connector candidates').map((candidate) => {
        if (!['inactive', 'unhealthy', 'configured', 'operation_disabled'].includes(String(candidate.status))) {
          throw new Error('Invalid App connector candidate status.');
        }
        if (candidate.provider_schema_check !== 'pending_review') {
          throw new Error('Invalid App provider schema check state.');
        }
        return {
          id: stringValue(candidate.id, 'App connector candidate identity'),
          name: stringValue(candidate.name, 'App connector candidate name'),
          status: candidate.status as ConnectedAppReviewTarget['connector_requirements'][number]['candidates'][number]['status'],
          eligible_for_review: candidate.eligible_for_review === true,
          authorization_version: integer(candidate.authorization_version, 'App connector candidate authorization version'),
          provider_schema_check: 'pending_review' as const,
        };
      }),
    };
  });
  const readiness = object(row.readiness, 'App review readiness');
  return {
    activation_kind: row.activation_kind,
    app_version_id: stringValue(row.app_version_id, 'App review version identity'),
    version: stringValue(row.version, 'App review version'),
    protocol_version: '1',
    package_format: 'deft.app.package.v1',
    package_digest: stringValue(row.package_digest, 'App review package digest'),
    manifest_digest: stringValue(row.manifest_digest, 'App review manifest digest'),
    manifest,
    provenance: manifest.provenance ?? null,
    provenance_trust: 'local_unsigned',
    requested_snapshot_id: stringValue(row.requested_snapshot_id, 'requested App snapshot identity'),
    requested_snapshot_digest: stringValue(row.requested_snapshot_digest, 'requested App snapshot digest'),
    requested_authority: {
      resource_rights: recordArray(authority.resource_rights ?? [], 'requested App resource rights').map((right) => {
        if (right.right !== 'read') throw new Error('Invalid requested App resource right.');
        return {
          requirement_key: stringValue(right.requirement_key, 'App resource requirement key'),
          source: normalizeResourceSource(right.source),
          resource_type: stringValue(right.resource_type, 'App resource type'),
          fields: stringArray(right.fields ?? [], 'App resource fields'),
          right: 'read' as const,
        };
      }),
      classification: object(authority.classification ?? {}, 'requested App classification'),
    },
    dependency_requirements: dependencies,
    connector_requirements: connectors,
    missing_binding_keys: stringArray(row.missing_binding_keys ?? [], 'missing App binding keys'),
    readiness: {
      dependencies_ready: readiness.dependencies_ready === true,
      connector_candidates_ready: readiness.connector_candidates_ready === true,
    },
  };
}

export function normalizeAppGrantManagement(value: unknown): AppGrantManagement {
  const body = object(value, 'App grant response');
  const root = object(body.grants ?? value, 'App grants');
  const installation = object(root.installation, 'App grant installation');
  const state = installation.state;
  if (state !== 'staged' && state !== 'active' && state !== 'disabled' && state !== 'failed') throw new Error('Invalid App grant state.');
  return {
    installation: {
      id: stringValue(installation.id, 'App installation identity'),
      app_id: stringValue(installation.app_id, 'App identity'),
      state,
      active_version_id: nullableString(installation.active_version_id, 'active App version identity'),
      active_grant_snapshot_id: nullableString(installation.active_grant_snapshot_id, 'active App grant identity'),
      lifecycle_epoch: integer(installation.lifecycle_epoch, 'App lifecycle epoch'),
      grant_epoch: integer(installation.grant_epoch, 'App grant epoch'),
    },
    compatibility: normalizeHostCompatibility(root.compatibility),
    versions: recordArray(root.versions ?? [], 'App grant versions').map((row) => {
      if (row.protocol_version !== '0' && row.protocol_version !== '1') throw new Error('Invalid App protocol version.');
      if (row.provenance_trust !== 'local_unsigned') throw new Error('Invalid App version provenance trust.');
      const manifest = normalizeManifest(row.manifest);
      return {
        id: stringValue(row.id, 'App version identity'),
        version: stringValue(row.version, 'App version'),
        protocol_version: row.protocol_version,
        state: stringValue(row.state, 'App version state'),
        manifest,
        package_format: packageFormat(row.package_format),
        provenance: manifest.provenance ?? null,
        provenance_trust: 'local_unsigned' as const,
        package_digest: stringValue(row.package_digest, 'App package digest'),
        manifest_digest: stringValue(row.manifest_digest, 'App manifest digest'),
        requested_grant_snapshot_id: nullableString(row.requested_grant_snapshot_id, 'requested App grant identity'),
        staged_at: stringValue(row.staged_at, 'App staged time'),
        activated_at: nullableString(row.activated_at, 'App activated time'),
        superseded_at: nullableString(row.superseded_at, 'App superseded time'),
      };
    }),
    snapshots: recordArray(root.snapshots ?? [], 'App grant snapshots').map((row) => {
      if (row.snapshot_kind !== 'requested' && row.snapshot_kind !== 'effective') throw new Error('Invalid App grant snapshot kind.');
      return {
        id: stringValue(row.id, 'App grant snapshot identity'),
        app_version_id: stringValue(row.app_version_id, 'App grant version identity'),
        snapshot_kind: row.snapshot_kind,
        requested_snapshot_id: nullableString(row.requested_snapshot_id, 'requested grant snapshot identity'),
        supersedes_snapshot_id: nullableString(row.supersedes_snapshot_id, 'superseded grant snapshot identity'),
        resource_rights: Array.isArray(row.resource_rights) ? row.resource_rights : [],
        classification: object(row.classification ?? {}, 'App grant classification'),
        snapshot_digest: stringValue(row.snapshot_digest, 'App grant snapshot digest'),
        reviewed_at: nullableString(row.reviewed_at, 'App grant review time'),
        created_at: stringValue(row.created_at, 'App grant created time'),
      };
    }),
    review_target: normalizeConnectedAppReviewTarget(root.review_target),
    dependencies: recordArray(root.dependencies ?? [], 'App dependency locks').map((row) => ({
      id: stringValue(row.id, 'App dependency lock identity'),
      grant_snapshot_id: stringValue(row.grant_snapshot_id, 'App dependency grant identity'),
      dependency_key: stringValue(row.dependency_key, 'App dependency key'),
      required_app_id: stringValue(row.required_app_id, 'required App identity'),
      required_version: stringValue(row.required_version, 'required App version'),
      dependency_installation_id: stringValue(row.dependency_installation_id, 'dependency installation identity'),
      dependency_version_id: stringValue(row.dependency_version_id, 'dependency version identity'),
      dependency_lifecycle_epoch: integer(row.dependency_lifecycle_epoch, 'dependency lifecycle epoch'),
      ownership: row.ownership === 'preexisting' ? 'preexisting' : invalidOwnership(),
      lock_digest: stringValue(row.lock_digest, 'App dependency lock digest'),
    })),
    action_bindings: recordArray(root.action_bindings ?? [], 'App action bindings').map(normalizeActionBinding),
    recent_runs: recordArray(root.recent_runs ?? [], 'recent App Runs').map(normalizeRunSummary),
  };
}

function invalidOwnership(): never {
  throw new Error('Invalid App dependency ownership.');
}

function normalizeActionBinding(row: UnknownRecord): AppActionBinding {
  if (row.provider_kind !== 'mcp') throw new Error('Invalid App action provider.');
  const host = object(row.host_policy, 'App action host policy');
  return {
    id: stringValue(row.id, 'App action binding identity'),
    grant_snapshot_id: stringValue(row.grant_snapshot_id, 'App action grant identity'),
    action_key: stringValue(row.action_key, 'App action key'),
    capability_requirement_key: stringValue(row.capability_requirement_key, 'App capability key'),
    connector_requirement_key: stringValue(row.connector_requirement_key, 'App connector key'),
    interface_identity: stringValue(row.interface_identity, 'App capability interface'),
    provider_kind: 'mcp',
    mcp_connection_id: stringValue(row.mcp_connection_id, 'App connector identity'),
    operation_name: stringValue(row.operation_name, 'App operation name'),
    operation_schema_digest: stringValue(row.operation_schema_digest, 'App operation schema digest'),
    connector_authorization_version: integer(row.connector_authorization_version, 'App connector authorization version'),
    binding_digest: stringValue(row.binding_digest, 'App action binding digest'),
    host_policy: {
      risk_class: stringValue(host.risk_class, 'App risk class'),
      review_requirement: stringValue(host.review_requirement, 'App review requirement'),
      review_scope: stringValue(host.review_scope, 'App review scope'),
      egress_class: stringValue(host.egress_class, 'App egress class'),
      retry_class: stringValue(host.retry_class, 'App retry class'),
      retention_class: stringValue(host.retention_class, 'App retention class'),
      automation_eligibility: stringValue(host.automation_eligibility, 'App automation eligibility'),
      provider_idempotency_key_required: host.provider_idempotency_key_required === true,
    },
  };
}

export function normalizeConnectedAppReview(value: unknown): ConnectedAppReview {
  const body = object(value, 'connected App review response');
  const row = object(body.review ?? value, 'connected App review');
  const diff = object(row.permission_diff, 'App permission diff');
  if (diff.kind !== 'initial' && diff.kind !== 'unchanged' && diff.kind !== 'widening_or_incompatible') throw new Error('Invalid App permission diff.');
  return {
    review_version: stringValue(row.review_version, 'App review version'),
    app_installation_id: stringValue(row.app_installation_id, 'App installation identity'),
    app_version_id: stringValue(row.app_version_id, 'App version identity'),
    package_digest: stringValue(row.package_digest, 'App package digest'),
    requested_snapshot_id: stringValue(row.requested_snapshot_id, 'requested grant snapshot identity'),
    requested_snapshot_digest: stringValue(row.requested_snapshot_digest, 'requested grant snapshot digest'),
    lifecycle_epoch: integer(row.lifecycle_epoch, 'App lifecycle epoch'),
    grant_epoch: integer(row.grant_epoch, 'App grant epoch'),
    permission_diff: {
      kind: diff.kind,
      carry_forward_eligible: diff.carry_forward_eligible === true,
      changed_atoms: stringArray(diff.changed_atoms ?? [], 'changed App permission atoms'),
      prior_authority_surface_digest: nullableString(diff.prior_authority_surface_digest, 'prior App authority digest'),
      proposed_authority_surface_digest: stringValue(diff.proposed_authority_surface_digest, 'proposed App authority digest'),
    },
    classification: object(row.classification ?? {}, 'App classification'),
    resource_rights: Array.isArray(row.resource_rights) ? row.resource_rights : [],
    dependencies: recordArray(row.dependencies ?? [], 'reviewed App dependencies').map((entry) => ({
      dependency_key: stringValue(entry.dependency_key, 'App dependency key'),
      required_app_id: stringValue(entry.required_app_id, 'required App identity'),
      required_version: stringValue(entry.required_version, 'required App version'),
      dependency_installation_id: stringValue(entry.dependency_installation_id, 'dependency installation identity'),
      dependency_version_id: stringValue(entry.dependency_version_id, 'dependency version identity'),
      dependency_lifecycle_epoch: integer(entry.dependency_lifecycle_epoch, 'dependency lifecycle epoch'),
      ownership: entry.ownership === 'preexisting' ? 'preexisting' : invalidOwnership(),
      lock_digest: stringValue(entry.lock_digest, 'App dependency lock digest'),
    })),
    action_bindings: recordArray(row.action_bindings ?? [], 'reviewed App action bindings').map((entry) => {
      if (entry.provider_kind !== 'mcp') throw new Error('Invalid reviewed App action provider.');
      return {
        action_key: stringValue(entry.action_key, 'App action key'),
        capability_requirement_key: stringValue(entry.capability_requirement_key, 'App capability key'),
        connector_requirement_key: stringValue(entry.connector_requirement_key, 'App connector key'),
        interface_identity: stringValue(entry.interface_identity, 'App interface identity'),
        provider_kind: 'mcp' as const,
        mcp_connection_id: stringValue(entry.mcp_connection_id, 'App connector identity'),
        operation_name: stringValue(entry.operation_name, 'App operation name'),
        operation_schema_digest: stringValue(entry.operation_schema_digest, 'App operation schema digest'),
        connector_authorization_version: integer(entry.connector_authorization_version, 'App connector authorization version'),
        binding_digest: stringValue(entry.binding_digest, 'App binding digest'),
      };
    }),
    authority_surface_digest: stringValue(row.authority_surface_digest, 'App authority surface digest'),
    review_digest: stringValue(row.review_digest, 'App review digest'),
  };
}

export function normalizeConnectedAppHealth(value: unknown): ConnectedAppHealth {
  const body = object(value, 'connected App health response');
  const row = object(body.health ?? value, 'connected App health');
  if (row.status !== 'healthy' && row.status !== 'unhealthy') throw new Error('Invalid connected App health status.');
  return {
    status: row.status,
    installation_id: stringValue(row.installation_id, 'App installation identity'),
    active_grant_snapshot_id: nullableString(row.active_grant_snapshot_id, 'active App grant identity'),
    lifecycle_epoch: integer(row.lifecycle_epoch, 'App lifecycle epoch'),
    grant_epoch: integer(row.grant_epoch, 'App grant epoch'),
    checked_provider_schemas: row.checked_provider_schemas === true,
    issues: recordArray(row.issues ?? [], 'App health issues').map((issue) => ({
      code: stringValue(issue.code, 'App health issue code'),
      subject_id: stringValue(issue.subject_id, 'App health issue subject'),
      message: stringValue(issue.message, 'App health issue message'),
    })),
  };
}

export function normalizeAppConnectors(value: unknown): AppConnector[] {
  if (!Array.isArray(value)) throw new Error('Invalid connector response.');
  return value.map((entry) => {
    const row = object(entry, 'connector');
    return {
      id: stringValue(row.id, 'connector identity'),
      name: stringValue(row.name, 'connector name'),
      is_active: row.is_active === true,
      connection_error: nullableString(row.connection_error, 'connector error'),
    };
  });
}

export async function appApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : fallback;
}
