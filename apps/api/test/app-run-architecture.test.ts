import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

const runSecretBoundary = new Set([
  'lib/app-run-keyrings.ts', 'lib/app-run-secrets.ts', 'lib/app-run-secret-repository.ts',
]);
// Sync uses its own domain-bound envelope and only these reviewed persistence/read
// boundaries transport it. This does not extend access to receipt signing material.
const syncEnvelopeBoundary = new Set([
  'lib/app-resource-sync-secrets.ts', 'lib/app-resource-sync-store.ts',
  'lib/app-resource-sync-admission.ts', 'lib/app-resource-private-read.ts',
]);
function forbiddenSecretTokens(path: string, source: string): string[] {
  return [...source.matchAll(/\b(?:ciphertext_b64|nonce_b64|auth_tag_b64|receipt_signing)\b/g)]
    .filter(([token]) => !runSecretBoundary.has(path)
      && !(token !== 'receipt_signing' && syncEnvelopeBoundary.has(path)))
    .map(([token]) => token);
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

test('only the App Run secret boundary handles ciphertext and signing material', async () => {
  const violations: string[] = [];

  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    for (const token of forbiddenSecretTokens(sourcePath, source)) violations.push(`${sourcePath}:${token}`);
  }

  assert.deepEqual(violations, []);
  // A neighboring path and a signing token in an allowed sync file still fail.
  assert.deepEqual(forbiddenSecretTokens('lib/app-resource-sync-unreviewed.ts',
    'ciphertext_b64 nonce_b64 auth_tag_b64 receipt_signing'),
  ['ciphertext_b64', 'nonce_b64', 'auth_tag_b64', 'receipt_signing']);
  assert.deepEqual(forbiddenSecretTokens('lib/app-resource-sync-store.ts', 'receipt_signing'),
    ['receipt_signing']);
});

test('App Run engine flag and key material stay confined to environment and Run composition', async () => {
  const consumers: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath.startsWith('lib/app-run-') || sourcePath === 'lib/env.ts') continue;
    const source = await readFile(path, 'utf8');
    // Host sync admission receives the existing Run secret service solely to
    // persist the same encrypted Run input/fingerprints; rollout flags stay composed.
    if (/\b(?:DEFT_APP_RUNS_ENABLED|APP_RUNS_ENABLED)\b/.test(source)
      || (sourcePath !== 'lib/app-resource-sync-admission.ts' && /\bAppRunSecretService\b/.test(source))) {
      consumers.push(sourcePath);
    }
  }
  assert.deepEqual(consumers, []);
});

test('legacy MCP cutover flag has only the two intake-boundary consumers', async () => {
  const expectedConsumers = [
    'lib/agent-actions.ts',
    'lib/capability-service.ts',
  ];
  const consumers: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath === 'lib/env.ts') continue;
    const source = await readFile(path, 'utf8');
    if (/\b(?:DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED|APP_RUN_LEGACY_MCP_CUTOVER_ENABLED)\b/.test(source)) {
      consumers.push(sourcePath);
    }
  }
  assert.deepEqual(consumers.sort(), expectedConsumers);
});

test('App-origin Run intake flag defaults in env and is consumed only by Run composition', async () => {
  const consumers: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath === 'lib/env.ts') continue;
    const source = await readFile(path, 'utf8');
    if (/\b(?:DEFT_APP_RUN_APP_ORIGIN_ENABLED|APP_RUN_APP_ORIGIN_ENABLED)\b/.test(source)) {
      consumers.push(sourcePath);
    }
  }
  assert.deepEqual(consumers, ['lib/app-run-runtime.ts']);
});

test('C5 selects one composed worker-owned attempt entrance through Capability Service', async () => {
  const capabilityService = await readFile(join(sourceRoot, 'lib/capability-service.ts'), 'utf8');
  const worker = await readFile(join(sourceRoot, 'workers/index.ts'), 'utf8');
  const runtime = await readFile(join(sourceRoot, 'lib/app-run-runtime.ts'), 'utf8');
  const handler = await readFile(join(sourceRoot, 'lib/app-run-worker-handler.ts'), 'utf8');
  const bridge = await readFile(join(sourceRoot, 'lib/app-run-capability-bridge.ts'), 'utf8');
  const legacyActions = await readFile(join(sourceRoot, 'lib/agent-actions.ts'), 'utf8');

  assert.match(capabilityService, /legacyMcpCutoverEnabled\(\)/);
  assert.match(capabilityService, /await this\.governed\.invoke/);
  assert.match(capabilityService, /await this\.mcpProvider\.invoke/);
  assert.doesNotMatch(capabilityService, /\b(?:AppRunService|getAppRunRuntime|AppRunAttemptRunner)\b/);
  assert.equal(worker.match(/case 'app-run-attempt'/g)?.length, 1);
  assert.match(handler, /getAppRunRuntime/);
  assert.match(runtime, /new PinnedMcpAppRunProviderExecutor/);
  assert.match(runtime, /postgresAppRunAttemptQueue/);
  assert.match(runtime, /new PostgresAppRunReceiptWriter/);
  assert.match(runtime, /new PostgresAppRunAttentionProjector/);
  assert.match(bridge, /attemptRunner\.runImmediate/);
  assert.match(bridge, /legacy_action_id/);
  assert.doesNotMatch(bridge, /\.invoke\(request\)/);
  assert.match(legacyActions, /APP_RUN_LEGACY_MCP_CUTOVER_ENABLED && action\.startsWith\('mcp__'\)/);
  assert.match(legacyActions, /legacy_action_id:\s*actionId/);
  assert.doesNotMatch(runtime, /APP_RUN_LEGACY_MCP_CUTOVER_ENABLED/);
  assert.doesNotMatch(handler, /APP_RUN_LEGACY_MCP_CUTOVER_ENABLED/);
});

test('only the MCP adapter calls the low-level client and governed execution is pinned by provider id', async () => {
  const violations: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    if (sourcePath !== 'lib/capability-providers/mcp.ts' && /mcpClientManager\.executeTool/.test(source)) {
      violations.push(sourcePath);
    }
  }
  assert.deepEqual(violations, []);

  const provider = await readFile(join(sourceRoot, 'lib/capability-providers/mcp.ts'), 'utf8');
  const executor = await readFile(join(sourceRoot, 'lib/app-run-provider-executor.ts'), 'utf8');
  const capabilityService = await readFile(join(sourceRoot, 'lib/capability-service.ts'), 'utf8');
  const attemptRunner = await readFile(join(sourceRoot, 'lib/app-run-attempt-runner.ts'), 'utf8');
  const mcpRuntime = await readFile(join(sourceRoot, 'lib/mcp-runtime.ts'), 'utf8');
  assert.match(provider, /resolvePinnedExecutable/);
  assert.match(provider, /provider_instance_id/);
  assert.match(provider, /discoverToolDiscovery\(config\)/);
  assert.match(provider, /snapshot\.snapshot_digest !== request\.dispatch_pin\.provider_snapshot_digest/);
  assert.match(provider, /operation\.schema_digest !== request\.dispatch_pin\.operation_schema_digest/);
  assert.match(executor, /capabilityService\.invokePinned\(request\)/);
  assert.match(capabilityService, /this\.mcpProvider\.executePinned/);
  assert.match(attemptRunner, /loadAppProviderDispatchPin/);
  assert.match(attemptRunner, /dispatch_pin: boundary\.dispatch_pin/);
  assert.match(mcpRuntime, /app_run_authorization_version, expectedAuthorizationVersion/);
  assert.doesNotMatch(executor, /connection_slug/);
  assert.doesNotMatch(executor, /mcpClientManager/);
});

test('Run submission is confined to the advisory-lock repository and checkpoint-locked host sync admission', async () => {
  const violations: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath === 'lib/app-run-repository.ts'
      || sourcePath === 'lib/app-resource-sync-admission.ts') continue;
    const source = await readFile(path, 'utf8');
    if (/\.insert\(appRuns\)/.test(source)) violations.push(sourcePath);
  }
  assert.deepEqual(violations, []);
  const admission = await readFile(join(sourceRoot, 'lib/app-resource-sync-admission.ts'), 'utf8');
  const authority = await readFile(join(sourceRoot, 'lib/app-resource-sync-authority.ts'), 'utf8');
  const reviewed = await readFile(join(sourceRoot, 'lib/app-resource-sync-reviewed.ts'), 'utf8');
  const runtime = await readFile(join(sourceRoot, 'lib/app-run-runtime.ts'), 'utf8');
  // The second writer is the already-reviewed host sync entrance. It serializes
  // on checkpoint rather than reversing the Run-before-checkpoint completion lock.
  assert.match(admission, /HostTargetSchema = z\.strictObject\(\{ org_id: z\.string\(\)\.uuid\(\),\s*resource_binding_id: z\.string\(\)\.uuid\(\) \}\)/);
  assert.match(admission, /if \(!this\.enabled\(\)\) throw/);
  assert.match(runtime, /new AppResourceSyncAdmissionService\([\s\S]*?isAppResourceSyncChannelEnabled\)/);
  const environment = await readFile(join(sourceRoot, 'lib/env.ts'), 'utf8');
  assert.match(environment, /function isAppResourceSyncChannelEnabled\(\): boolean \{\s*return APPS_ENABLED && APP_RUNS_ENABLED && APP_RUN_APP_ORIGIN_ENABLED\s*&& process\.env\.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED === 'true';\s*\}/);
  const authorityLoad = admission.indexOf('await loadLiveResourceSyncBindingAuthority(');
  const checkpointLock = admission.indexOf(".limit(1).for('update')", authorityLoad);
  const runInsert = admission.indexOf('tx.insert(appRuns)');
  assert.ok(authorityLoad > 0 && checkpointLock > authorityLoad && runInsert > checkpointLock);
  assert.match(authority, /SELECT id FROM org_members[\s\S]*?FOR SHARE/);
  assert.ok(authority.indexOf('SELECT id FROM org_members')
    < authority.indexOf('reviewed = await loadReviewedResourceSyncDescriptor'));
  assert.match(reviewed, /from\(appInstallations\)[\s\S]*?\.for\('share'\)/);
  assert.match(admission, /this\.repository\.transaction\(async \(tx\)/);
  assert.match(admission, /state: 'existing', run_id: existing\.run_id/);
  assert.match(admission, /eq\(appSyncIntents\.expected_cursor_sequence, checkpoint\.cursor_sequence\)/);
  assert.match(admission, /this\.runInputs\.insertInput\(tx/);
  assert.match(admission, /tx\.insert\(appSyncIntents\)/);
  assert.match(admission, /scheduleResourceSyncInTransaction\(tx, run, now\)/);
  assert.deepEqual([...admission.matchAll(/tx\.insert\((\w+)\)/g)].map((match) => match[1]),
    ['appRuns', 'appSyncIntents']);
  assert.doesNotMatch(admission, /\b(?:fetch|executeTool|executePinned|mcpClientManager|AppRunProviderExecutor|pgTable)\b/);
});

test('the App Run approval bridge has one safe compatibility writer and no executor', async () => {
  const adapter = await readFile(join(sourceRoot, 'lib/app-run-approval-adapter.ts'), 'utf8');
  const service = await readFile(join(sourceRoot, 'lib/app-run-service.ts'), 'utf8');
  const resolver = await readFile(join(sourceRoot, 'lib/agent-approval-resolver.ts'), 'utf8');

  assert.match(adapter, /\.insert\(agentActions\)/);
  assert.match(adapter, /action:\s*APP_RUN_APPROVAL_ACTION/);
  assert.match(adapter, /approval_tier:\s*'full'/);
  assert.match(adapter, /resource_ids/);
  assert.match(adapter, /safe_preview/);
  assert.doesNotMatch(adapter, /\b(?:executeTool|AppRunAttemptRunner|idempotency_key|raw_input|raw_output)\b/);
  assert.match(service, /approvalAdapter\.create/);
  assert.match(service, /attemptScheduler\.scheduleInTransaction/);
  assert.match(adapter, /attemptScheduler\.scheduleInTransaction/);
  assert.match(resolver, /row\.action === APP_RUN_APPROVAL_ACTION/);
});

test('Run operations can repair projections but cannot call a provider', async () => {
  const operations = await readFile(join(sourceRoot, 'lib/app-run-operations.ts'), 'utf8');
  const receipts = await readFile(join(sourceRoot, 'lib/app-run-receipts.ts'), 'utf8');
  const attention = await readFile(join(sourceRoot, 'lib/app-run-attention.ts'), 'utf8');

  for (const source of [operations, receipts, attention]) {
    assert.doesNotMatch(source, /\b(?:executeTool|AppRunProviderExecutor|provider_idempotency_key|claim_token)\b/);
  }
  assert.match(operations, /safeRunSelection/);
  assert.match(operations, /Math\.max\(1, Math\.min\(limit \?\? 50, 100\)\)/);
  assert.match(operations, /receipt_kind:\s*'repair'/);
  assert.match(operations, /event_type:\s*'repair_gap'/);
  assert.doesNotMatch(operations, /\b(?:authorization_snapshot|idempotency_fingerprint|input_fingerprint)\b/);
  assert.match(receipts, /parseAppRunReceiptEnvelope/);
  assert.match(attention, /sourceType:\s*'app_run'/);
});
