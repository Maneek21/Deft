import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const certificatePath = resolve(repoRoot, 'dist', 'hermes-employee-release-gate.json');
const packagePath = resolve(repoRoot, 'package.json');
const integrationManifestPath = resolve(repoRoot, 'integrations', 'hermes', 'integration-manifest.json');
const bundlePath = resolve(repoRoot, 'dist', 'hermes-integration');
const bundleVerifierPath = resolve(repoRoot, 'scripts', 'verify-hermes-integration-bundle.mjs');

export const API_SUITES = [
  'test/agent-action-budget-reset.test.ts',
  'test/agent-channel.test.ts',
  'test/agent-certification-stability.test.ts',
  'test/agent-onboarding-preflight.test.ts',
  'test/agent-runtime-recovery.test.ts',
  'test/hermes-native-onboarding.test.ts',
  'test/agent-approval-resolver.test.ts',
  'test/agent-untrusted-context.test.ts',
  'test/direct-route-privacy.test.ts',
  'test/identity-hardening.test.ts',
  'test/mcp-connector-safety.test.ts',
  'test/mcp-human-context-packets.test.ts',
  'test/mcp-message-privacy.test.ts',
  'test/mcp-server.test.ts',
  'test/mcp-tool-trust-boundary.test.ts',
  'test/mcp-write-tools.test.ts',
  'test/modules-contacts-acceptance.test.ts',
  'test/modules-mcp-adapter.test.ts',
  'test/phase8-heartbeat-budget.test.ts',
  'test/receipts.test.ts',
] as const;

export const SUITE_CONTRACT = [
  { id: 'deft.database.fresh_schema', role: 'clean_state_database' },
  { id: 'deft.database.demo_seed', role: 'clean_state_database' },
  { id: 'deft.api.employee_boundary', role: 'api_boundary' },
  { id: 'hermes.native.deft-platform', role: 'default_adapter' },
  { id: 'hermes.legacy.agent-channel', role: 'fallback_adapter' },
  { id: 'hermes.legacy.channel-service', role: 'fallback_adapter' },
  { id: 'hermes.common.deft-employee', role: 'common_plugin' },
  { id: 'hermes.common.deft-memory', role: 'common_plugin' },
  { id: 'deft.hermes.bundle.build', role: 'bundle_build' },
  { id: 'deft.hermes.bundle.verify', role: 'bundle_verification' },
] as const;

type SuiteId = typeof SUITE_CONTRACT[number]['id'];

type SuiteEvidence = {
  id: SuiteId;
  role: typeof SUITE_CONTRACT[number]['role'];
  result: 'passed';
};

type AdapterDescriptor = {
  id: string;
  name: string;
  version: string;
  role: string;
};

type IntegrationManifest = {
  schema: string;
  integration_version: string;
  deft_release: string;
  deft_release_compatibility: string;
  hermes_compatibility: string;
  hermes_tested: {
    distribution: string;
    version: string;
    repository: string;
    ref: string;
    commit: string;
  };
  default_adapter: string;
  adapters: AdapterDescriptor[];
};

type BundleEvidence = {
  schema: 'deft.hermes.integration.bundle_evidence.v1';
  manifest_sha256: string;
  content_sha256: string;
  manifest: Record<string, unknown>;
};

type BundleDigests = {
  manifest_sha256: string;
  content_sha256: string;
};

type PassEvidence = {
  pass: number;
  completed_at: string;
  suites: SuiteEvidence[];
  bundle: BundleDigests;
};

type DeftProvenance = {
  release: string;
  expected_tag: string;
  tag_verified: boolean;
  commit: string;
};

type HermesRuntimeProvenance = {
  distribution: string;
  version: string;
  repository: string;
  ref: string;
  commit: string;
  python_version: string;
};

type CertificateInput = {
  deft: DeftProvenance;
  hermes: {
    declared_compatibility: string;
    tested_runtime: HermesRuntimeProvenance;
  };
  integration: {
    schema: string;
    version: string;
    default_adapter: { id: string; name: string; version: string };
    fallback_adapters: Array<{ id: string; name: string; version: string }>;
    manifest_sha256: string;
    content_sha256: string;
  };
  passes: PassEvidence[];
};

type GateConfig = {
  databaseUrl: string;
  databaseName: string;
  pnpmCli: string;
  hermesPython: string;
  hermesRepo: string;
  releaseTag?: string;
  releaseCommit?: string;
  timeoutMs: number;
  childEnv: NodeJS.ProcessEnv;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  invariant(typeof field === 'string' && field.length > 0, `${label}.${key} must be a non-empty string`);
  return field;
}

function arrayField(value: Record<string, unknown>, key: string, label: string): unknown[] {
  const field = value[key];
  invariant(Array.isArray(field), `${label}.${key} must be an array`);
  return field;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseIntegrationManifest(value: unknown): IntegrationManifest {
  const manifest = record(value, 'integration manifest');
  const tested = record(manifest.hermes_tested, 'integration manifest.hermes_tested');
  const adapters = arrayField(manifest, 'adapters', 'integration manifest').map((candidate, index) => {
    const adapter = record(candidate, `integration manifest.adapters[${index}]`);
    return {
      id: stringField(adapter, 'id', `integration manifest.adapters[${index}]`),
      name: stringField(adapter, 'name', `integration manifest.adapters[${index}]`),
      version: stringField(adapter, 'version', `integration manifest.adapters[${index}]`),
      role: stringField(adapter, 'role', `integration manifest.adapters[${index}]`),
    };
  });
  return {
    schema: stringField(manifest, 'schema', 'integration manifest'),
    integration_version: stringField(manifest, 'integration_version', 'integration manifest'),
    deft_release: stringField(manifest, 'deft_release', 'integration manifest'),
    deft_release_compatibility: stringField(manifest, 'deft_release_compatibility', 'integration manifest'),
    hermes_compatibility: stringField(manifest, 'hermes_compatibility', 'integration manifest'),
    hermes_tested: {
      distribution: stringField(tested, 'distribution', 'integration manifest.hermes_tested'),
      version: stringField(tested, 'version', 'integration manifest.hermes_tested'),
      repository: stringField(tested, 'repository', 'integration manifest.hermes_tested'),
      ref: stringField(tested, 'ref', 'integration manifest.hermes_tested'),
      commit: stringField(tested, 'commit', 'integration manifest.hermes_tested'),
    },
    default_adapter: stringField(manifest, 'default_adapter', 'integration manifest'),
    adapters,
  };
}

export function parseBundleEvidence(value: string | unknown): BundleEvidence {
  const evidence = record(typeof value === 'string' ? parseJson(value, 'bundle verifier output') : value, 'bundle evidence');
  const schema = stringField(evidence, 'schema', 'bundle evidence');
  invariant(
    schema === 'deft.hermes.integration.bundle_evidence.v1',
    `bundle verifier returned unsupported schema ${schema}`,
  );
  const manifestSha256 = stringField(evidence, 'manifest_sha256', 'bundle evidence');
  const contentSha256 = stringField(evidence, 'content_sha256', 'bundle evidence');
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  invariant(digestPattern.test(manifestSha256), 'bundle manifest digest must be sha256:<64 lowercase hex>');
  invariant(digestPattern.test(contentSha256), 'bundle content digest must be sha256:<64 lowercase hex>');
  return {
    schema,
    manifest_sha256: manifestSha256,
    content_sha256: contentSha256,
    manifest: record(evidence.manifest, 'bundle evidence.manifest'),
  };
}

export function buildCertificateV2(input: CertificateInput) {
  invariant(input.passes.length === 2, 'certificate v2 requires exactly two consecutive passes');
  return {
    schema: 'deft.hermes.employee.release_gate.v2' as const,
    result: 'passed' as const,
    source_tree_clean: true,
    clean_state_database: true,
    consecutive_passes: input.passes.length,
    deft: input.deft,
    hermes: input.hermes,
    integration: input.integration,
    passes: input.passes,
  };
}

export function removeStaleCertificate(path = certificatePath): void {
  rmSync(path, { force: true });
}

export function assertDisposableDatabaseName(databaseName: string): void {
  invariant(
    /^deft(?:_[a-z0-9]+)*_(?:test|ci|acceptance|gauntlet)$/i.test(databaseName),
    `refusing to reset database "${databaseName}"; its name must start with deft_ and end with `
      + 'test, ci, acceptance, or gauntlet as a separate suffix',
  );
}

function loadGateConfig(): GateConfig {
  const databaseUrl = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  invariant(databaseUrl, 'DEFT_TEST_DATABASE_URL or DATABASE_URL is required');
  const pnpmCli = process.env.npm_execpath;
  invariant(pnpmCli, 'Run this gate through pnpm so npm_execpath is available');
  const hermesPython = process.env.DEFT_HERMES_PYTHON?.trim();
  const hermesRepo = process.env.DEFT_HERMES_REPO?.trim();
  invariant(hermesPython, 'DEFT_HERMES_PYTHON is required for authoritative Hermes certification');
  invariant(hermesRepo, 'DEFT_HERMES_REPO is required for authoritative Hermes certification');
  const requiredPasses = Number.parseInt(process.env.DEFT_HERMES_GATE_PASSES ?? '2', 10);
  invariant(requiredPasses === 2, 'DEFT_HERMES_GATE_PASSES must be exactly 2 for certificate v2');
  const timeoutMs = Number.parseInt(process.env.DEFT_HERMES_GATE_TIMEOUT_MS ?? `${20 * 60 * 1000}`, 10);
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'DEFT_HERMES_GATE_TIMEOUT_MS must be positive');

  const parsedDatabaseUrl = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''));
  assertDisposableDatabaseName(databaseName);

  const resolvedPython = resolve(hermesPython);
  const resolvedRepo = resolve(hermesRepo);
  invariant(statSync(resolvedPython).isFile(), `DEFT_HERMES_PYTHON is not a file: ${resolvedPython}`);
  invariant(statSync(resolvedRepo).isDirectory(), `DEFT_HERMES_REPO is not a directory: ${resolvedRepo}`);

  const childEnv = {
    ...process.env,
    CI: 'true',
    DATABASE_URL: databaseUrl,
    DEFT_TEST_DATABASE_URL: databaseUrl,
    JWT_SECRET: process.env.JWT_SECRET ?? 'hermes-release-gate-jwt-not-for-production',
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'hermes-release-gate-refresh-not-for-production',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-ant-hermes-release-gate-dummy-not-real',
  };

  return {
    databaseUrl,
    databaseName,
    pnpmCli,
    hermesPython: resolvedPython,
    hermesRepo: resolvedRepo,
    releaseTag: process.env.DEFT_RELEASE_TAG?.trim() || undefined,
    releaseCommit: process.env.DEFT_RELEASE_COMMIT?.trim() || undefined,
    timeoutMs,
    childEnv,
  };
}

function runInherited(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): void {
  console.log(`[hermes-release-gate] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env,
    stdio: 'inherit',
    timeout: options.timeoutMs,
  });
  if (result.error) throw result.error;
  invariant(result.status === 0, `${label} exited with status ${result.status ?? 'unknown'}`);
}

function captureCommand(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  invariant(
    result.status === 0,
    `${label} exited with status ${result.status ?? 'unknown'}: ${(result.stderr ?? '').trim()}`,
  );
  return (result.stdout ?? '').trim();
}

function git(cwd: string, args: string[], label: string): string {
  return captureCommand(label, 'git', ['-C', cwd, ...args], { cwd: repoRoot });
}

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function assertDeftTreeClean(): void {
  const status = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'inspect Deft source tree');
  invariant(!status, `Deft source tree is not clean:\n${status}`);
}

function resolveDeftProvenance(config: GateConfig, manifest: IntegrationManifest): DeftProvenance {
  const packageJson = record(parseJson(readFileSync(packagePath, 'utf8'), 'package.json'), 'package.json');
  const release = stringField(packageJson, 'version', 'package.json');
  invariant(manifest.deft_release === release, 'package.json and Hermes manifest release do not match');
  invariant(
    manifest.deft_release_compatibility === `=${release}`,
    'Hermes manifest release compatibility must exactly match package.json',
  );
  const expectedTag = `v${release}`;
  const commit = git(repoRoot, ['rev-parse', 'HEAD'], 'resolve Deft HEAD');
  invariant(/^[0-9a-f]{40}$/.test(commit), 'Deft HEAD is not a full Git commit');
  if (config.releaseCommit) {
    invariant(/^[0-9a-f]{40}$/.test(config.releaseCommit), 'DEFT_RELEASE_COMMIT must be a full Git commit');
    invariant(config.releaseCommit === commit, 'DEFT_RELEASE_COMMIT does not match Deft HEAD');
  }
  let tagVerified = false;
  if (config.releaseTag) {
    invariant(config.releaseTag === expectedTag, `DEFT_RELEASE_TAG must equal ${expectedTag}`);
    const taggedCommit = git(
      repoRoot,
      ['rev-parse', '--verify', `${config.releaseTag}^{commit}`],
      `resolve Deft release tag ${config.releaseTag}`,
    );
    invariant(taggedCommit === commit, `Deft release tag ${config.releaseTag} does not resolve to HEAD`);
    tagVerified = true;
  }
  return { release, expected_tag: expectedTag, tag_verified: tagVerified, commit };
}

function probeHermesRuntime(config: GateConfig, manifest: IntegrationManifest): HermesRuntimeProvenance {
  const repo = realpathSync(config.hermesRepo);
  const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=all'], 'inspect Hermes checkout');
  invariant(!status, `Hermes upstream checkout is not clean:\n${status}`);
  const repository = git(repo, ['remote', 'get-url', 'origin'], 'resolve Hermes origin');
  invariant(repository === manifest.hermes_tested.repository, 'Hermes origin does not match the manifest repository');
  const commit = git(repo, ['rev-parse', 'HEAD'], 'resolve Hermes HEAD');
  invariant(commit === manifest.hermes_tested.commit, 'Hermes HEAD does not match the manifest commit');
  const refCommit = git(
    repo,
    ['rev-parse', '--verify', `${manifest.hermes_tested.ref}^{commit}`],
    'resolve Hermes tested ref',
  );
  invariant(refCommit === commit, 'Hermes tested ref does not resolve to its manifest commit');

  const probeScript = [
    'import importlib.metadata',
    'import json',
    'import os',
    'import platform',
    'import sys',
    'import hermes_cli',
    'distribution = os.environ["DEFT_HERMES_DISTRIBUTION"]',
    'print(json.dumps({',
    '  "distribution": distribution,',
    '  "version": importlib.metadata.version(distribution),',
    '  "python_version": platform.python_version(),',
    '  "module_file": hermes_cli.__file__,',
    '}))',
  ].join('\n');
  const output = captureCommand(
    'probe Hermes Python runtime',
    config.hermesPython,
    ['-c', probeScript],
    {
      cwd: repo,
      env: {
        ...config.childEnv,
        DEFT_HERMES_DISTRIBUTION: manifest.hermes_tested.distribution,
      },
      timeoutMs: config.timeoutMs,
    },
  );
  const probe = record(parseJson(output, 'Hermes Python probe'), 'Hermes Python probe');
  const distribution = stringField(probe, 'distribution', 'Hermes Python probe');
  const version = stringField(probe, 'version', 'Hermes Python probe');
  const pythonVersion = stringField(probe, 'python_version', 'Hermes Python probe');
  invariant(distribution === manifest.hermes_tested.distribution, 'Hermes Python distribution does not match manifest');
  invariant(version === manifest.hermes_tested.version, 'Hermes Python distribution version does not match manifest');
  invariant(/^\d+\.\d+\.\d+/.test(pythonVersion), 'Hermes Python probe returned an invalid Python version');
  const moduleFile = realpathSync(stringField(probe, 'module_file', 'Hermes Python probe'));
  invariant(pathWithin(repo, moduleFile), 'Hermes Python imports hermes_cli outside the tested checkout');

  return {
    distribution,
    version,
    repository,
    ref: manifest.hermes_tested.ref,
    commit,
    python_version: pythonVersion,
  };
}

function suite(id: SuiteId): SuiteEvidence {
  const definition = SUITE_CONTRACT.find((candidate) => candidate.id === id);
  invariant(definition, `unknown certificate suite ${id}`);
  return { ...definition, result: 'passed' };
}

async function resetDisposableDatabase(config: GateConfig, pass: number): Promise<void> {
  console.log(`[hermes-release-gate] pass ${pass}/2: reset disposable database ${config.databaseName}`);
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
  } finally {
    await client.end();
  }
}

function runPnpm(config: GateConfig, label: string, args: string[]): void {
  runInherited(label, process.execPath, [config.pnpmCli, ...args], {
    env: config.childEnv,
    timeoutMs: config.timeoutMs,
  });
}

function runPythonSuite(config: GateConfig, label: string, path: string): void {
  runInherited(label, config.hermesPython, [path], {
    env: config.childEnv,
    timeoutMs: config.timeoutMs,
  });
}

function validateBundleEvidence(evidence: BundleEvidence, source: IntegrationManifest): void {
  const manifest = evidence.manifest;
  invariant(stringField(manifest, 'schema', 'verified bundle manifest') === source.schema, 'bundle schema drifted');
  invariant(
    stringField(manifest, 'integration_version', 'verified bundle manifest') === source.integration_version,
    'bundle integration version drifted',
  );
  invariant(
    stringField(manifest, 'deft_release', 'verified bundle manifest') === source.deft_release,
    'bundle Deft release drifted',
  );
  invariant(
    stringField(manifest, 'default_adapter', 'verified bundle manifest') === source.default_adapter,
    'bundle default adapter drifted',
  );
  const bundleAdapters = arrayField(manifest, 'adapters', 'verified bundle manifest').map((value, index) => {
    const adapter = record(value, `verified bundle manifest.adapters[${index}]`);
    return {
      id: stringField(adapter, 'id', `verified bundle manifest.adapters[${index}]`),
      name: stringField(adapter, 'name', `verified bundle manifest.adapters[${index}]`),
      version: stringField(adapter, 'version', `verified bundle manifest.adapters[${index}]`),
      role: stringField(adapter, 'role', `verified bundle manifest.adapters[${index}]`),
    };
  });
  invariant(JSON.stringify(bundleAdapters) === JSON.stringify(source.adapters), 'bundle adapter declarations drifted');
  const contentDigest = record(manifest.content_digest, 'verified bundle manifest.content_digest');
  invariant(
    `sha256:${stringField(contentDigest, 'value', 'verified bundle manifest.content_digest')}` === evidence.content_sha256,
    'bundle verifier content digest disagrees with its manifest',
  );
}

function verifyBundle(config: GateConfig, source: IntegrationManifest): BundleEvidence {
  invariant(existsSync(bundleVerifierPath), `bundle verifier is missing: ${bundleVerifierPath}`);
  const output = captureCommand(
    'verify matched Hermes integration bundle',
    process.execPath,
    [bundleVerifierPath, '--json', bundlePath],
    { cwd: repoRoot, env: config.childEnv, timeoutMs: config.timeoutMs },
  );
  const evidence = parseBundleEvidence(output);
  validateBundleEvidence(evidence, source);
  return evidence;
}

async function runPass(
  config: GateConfig,
  manifest: IntegrationManifest,
  pass: number,
  previousBundle?: BundleDigests,
): Promise<PassEvidence> {
  const suites: SuiteEvidence[] = [];
  await resetDisposableDatabase(config, pass);
  runPnpm(config, `pass ${pass}: install fresh schema`, ['db:push-full']);
  suites.push(suite('deft.database.fresh_schema'));
  runPnpm(config, `pass ${pass}: seed fresh organization`, ['db:seed:demo']);
  suites.push(suite('deft.database.demo_seed'));
  runPnpm(config, `pass ${pass}: Deft employee boundary matrix`, [
    '--filter', '@deft/api', 'test', '--', ...API_SUITES,
  ]);
  suites.push(suite('deft.api.employee_boundary'));
  runPythonSuite(config, `pass ${pass}: native Deft platform adapter`, 'integrations/hermes/deft-platform/test_deft_platform.py');
  suites.push(suite('hermes.native.deft-platform'));
  runPnpm(config, `pass ${pass}: legacy Agent Channel fallback`, ['test:hermes-channel']);
  suites.push(suite('hermes.legacy.agent-channel'));
  runPnpm(config, `pass ${pass}: legacy Windows service fallback`, ['test:hermes-channel-service']);
  suites.push(suite('hermes.legacy.channel-service'));
  runPythonSuite(config, `pass ${pass}: Hermes employee policy plugin`, 'integrations/hermes/deft-employee/test_deft_employee.py');
  suites.push(suite('hermes.common.deft-employee'));
  runPythonSuite(config, `pass ${pass}: Hermes memory provider`, 'integrations/hermes/deft-memory/test_deft_memory.py');
  suites.push(suite('hermes.common.deft-memory'));
  runPnpm(config, `pass ${pass}: build matched integration bundle`, ['agent:hermes-bundle']);
  suites.push(suite('deft.hermes.bundle.build'));
  const verified = verifyBundle(config, manifest);
  suites.push(suite('deft.hermes.bundle.verify'));
  const bundle = {
    manifest_sha256: verified.manifest_sha256,
    content_sha256: verified.content_sha256,
  };
  if (previousBundle) {
    invariant(
      bundle.manifest_sha256 === previousBundle.manifest_sha256
      && bundle.content_sha256 === previousBundle.content_sha256,
      'two clean-state passes produced different Hermes bundle digests',
    );
  }
  invariant(
    JSON.stringify(suites) === JSON.stringify(SUITE_CONTRACT.map((definition) => ({ ...definition, result: 'passed' }))),
    'certificate suite order or role drifted',
  );
  return { pass, completed_at: new Date().toISOString(), suites, bundle };
}

export async function main(): Promise<void> {
  removeStaleCertificate();
  const config = loadGateConfig();
  invariant(existsSync(bundleVerifierPath), `bundle verifier is missing: ${bundleVerifierPath}`);
  assertDeftTreeClean();
  const manifest = parseIntegrationManifest(
    parseJson(readFileSync(integrationManifestPath, 'utf8'), 'Hermes integration manifest'),
  );
  invariant(manifest.schema === 'deft.hermes.integration.v2', 'certificate v2 requires integration manifest v2');
  const deft = resolveDeftProvenance(config, manifest);
  const testedRuntime = probeHermesRuntime(config, manifest);

  const firstPass = await runPass(config, manifest, 1);
  const secondPass = await runPass(config, manifest, 2, firstPass.bundle);
  const finalRuntime = probeHermesRuntime(config, manifest);
  invariant(
    JSON.stringify(finalRuntime) === JSON.stringify(testedRuntime),
    'Hermes runtime provenance changed during certification',
  );
  invariant(git(repoRoot, ['rev-parse', 'HEAD'], 'recheck Deft HEAD') === deft.commit, 'Deft HEAD changed during certification');
  assertDeftTreeClean();

  const defaultAdapter = manifest.adapters.find((adapter) => adapter.id === manifest.default_adapter);
  invariant(defaultAdapter?.role === 'default', 'manifest default adapter is missing or not marked default');
  const fallbackAdapters = manifest.adapters.filter((adapter) => adapter.role === 'fallback');
  invariant(fallbackAdapters.length > 0, 'manifest must retain at least one fallback adapter');
  const certificate = buildCertificateV2({
    deft,
    hermes: {
      declared_compatibility: manifest.hermes_compatibility,
      tested_runtime: testedRuntime,
    },
    integration: {
      schema: manifest.schema,
      version: manifest.integration_version,
      default_adapter: {
        id: defaultAdapter.id,
        name: defaultAdapter.name,
        version: defaultAdapter.version,
      },
      fallback_adapters: fallbackAdapters.map(({ id, name, version }) => ({ id, name, version })),
      manifest_sha256: secondPass.bundle.manifest_sha256,
      content_sha256: secondPass.bundle.content_sha256,
    },
    passes: [firstPass, secondPass],
  });
  mkdirSync(dirname(certificatePath), { recursive: true });
  writeFileSync(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`, 'utf8');
  console.log('[hermes-release-gate] PASSED 2 consecutive clean-state runs');
  console.log(`[hermes-release-gate] certificate: ${certificatePath}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
const isMain = process.platform === 'win32'
  ? invokedPath.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath;
if (isMain) {
  main().catch((error) => {
    console.error(`[hermes-release-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
