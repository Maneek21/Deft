import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

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
  const allowed = new Set([
    'lib/app-run-keyrings.ts',
    'lib/app-run-secrets.ts',
    'lib/app-run-secret-repository.ts',
  ]);
  const forbidden = /\b(?:ciphertext_b64|nonce_b64|auth_tag_b64|receipt_signing)\b/g;
  const violations: string[] = [];

  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (allowed.has(sourcePath)) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(forbidden)) {
      violations.push(`${sourcePath}:${match.index ?? 0}:${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('App Run flag and key material stay confined to environment and the composition root', async () => {
  const consumers: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath.startsWith('lib/app-run-') || sourcePath === 'lib/env.ts') continue;
    const source = await readFile(path, 'utf8');
    if (/\b(?:AppRunSecretService|DEFT_APP_RUNS_ENABLED|APP_RUNS_ENABLED)\b/.test(source)) {
      consumers.push(sourcePath);
    }
  }
  assert.deepEqual(consumers, []);
});

test('C4 has one composed worker-owned attempt entrance without Capability Service cutover', async () => {
  const capabilityService = await readFile(join(sourceRoot, 'lib/capability-service.ts'), 'utf8');
  const worker = await readFile(join(sourceRoot, 'workers/index.ts'), 'utf8');
  const runtime = await readFile(join(sourceRoot, 'lib/app-run-runtime.ts'), 'utf8');
  const handler = await readFile(join(sourceRoot, 'lib/app-run-worker-handler.ts'), 'utf8');

  assert.doesNotMatch(capabilityService, /\b(?:AppRunService|getAppRunRuntime|AppRunAttemptRunner)\b/);
  assert.equal(worker.match(/case 'app-run-attempt'/g)?.length, 1);
  assert.match(handler, /getAppRunRuntime/);
  assert.match(runtime, /new PinnedMcpAppRunProviderExecutor/);
  assert.match(runtime, /postgresAppRunAttemptQueue/);
  assert.match(runtime, /new PostgresAppRunReceiptWriter/);
  assert.match(runtime, /new PostgresAppRunAttentionProjector/);
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
  assert.match(provider, /resolvePinnedExecutable/);
  assert.match(provider, /provider_instance_id/);
  assert.doesNotMatch(executor, /connection_slug/);
  assert.doesNotMatch(executor, /mcpClientManager/);
});

test('Run submission has one repository writer behind the advisory-lock service', async () => {
  const violations: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath === 'lib/app-run-repository.ts') continue;
    const source = await readFile(path, 'utf8');
    if (/\.insert\(appRuns\)/.test(source)) violations.push(sourcePath);
  }
  assert.deepEqual(violations, []);
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
