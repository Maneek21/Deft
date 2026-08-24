import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const certificatePath = resolve(repoRoot, 'dist', 'hermes-employee-release-gate.json');
const requiredPasses = Number.parseInt(process.env.DEFT_HERMES_GATE_PASSES ?? '2', 10);
const databaseUrl = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const pnpmCli = process.env.npm_execpath;

const apiSuites = [
  'test/agent-channel.test.ts',
  'test/agent-certification-stability.test.ts',
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

const scenarioCoverage = {
  conversation_locality: ['agent-channel', 'mcp-human-context-packets', 'mcp-message-privacy'],
  explicit_and_implicit_knowledge: ['deft-memory plugin', 'mcp-human-context-packets', 'mcp-server'],
  generic_module_and_contacts_writes: ['modules-contacts-acceptance', 'modules-mcp-adapter'],
  approved_external_outreach: ['deft-employee plugin'],
  destructive_and_identity_boundaries: ['deft-employee plugin', 'identity-hardening', 'mcp-connector-safety'],
  approval_delay_and_rejection: ['agent-approval-resolver', 'modules-mcp-adapter'],
  duplicate_delivery: ['agent-channel', 'Hermes bridge'],
  bridge_and_runtime_restart: ['agent-channel', 'agent-certification-stability', 'Hermes bridge'],
  credential_revocation: ['agent-channel', 'identity-hardening'],
  memory_correction_and_fresh_reuse: ['agent-channel', 'deft-memory plugin'],
  action_budget_exhaustion: ['deft-employee plugin', 'phase8-heartbeat-budget', 'modules-mcp-adapter'],
  delegated_partial_failure: ['deft-employee plugin'],
  injection_resistance: ['agent-untrusted-context', 'mcp-tool-trust-boundary', 'deft-memory plugin'],
  privacy: ['direct-route-privacy', 'mcp-message-privacy'],
  secret_redaction: ['deft-employee plugin', 'mcp-connector-safety', 'receipts'],
  progress_and_truthful_outcomes: ['agent-channel', 'agent-certification-stability', 'Hermes bridge'],
} as const;

function fail(message: string): never {
  console.error(`[hermes-release-gate] ${message}`);
  process.exit(1);
}

if (!databaseUrl) fail('DEFT_TEST_DATABASE_URL or DATABASE_URL is required');
if (!pnpmCli) fail('Run this gate through pnpm so npm_execpath is available');
if (!Number.isSafeInteger(requiredPasses) || requiredPasses < 2 || requiredPasses > 5) {
  fail('DEFT_HERMES_GATE_PASSES must be an integer from 2 through 5');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''));
if (!/(?:test|ci|acceptance|gauntlet)/i.test(databaseName)) {
  fail(`refusing to reset database "${databaseName}"; its name must contain test, ci, acceptance, or gauntlet`);
}

const childEnv = {
  ...process.env,
  CI: 'true',
  DATABASE_URL: databaseUrl,
  DEFT_TEST_DATABASE_URL: databaseUrl,
  JWT_SECRET: process.env.JWT_SECRET ?? 'hermes-release-gate-jwt-not-for-production',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'hermes-release-gate-refresh-not-for-production',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-ant-hermes-release-gate-dummy-not-real',
};

function run(label: string, args: string[]) {
  console.log(`[hermes-release-gate] ${label}`);
  const result = spawnSync(process.execPath, [pnpmCli!, ...args], {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
    timeout: Number(process.env.DEFT_HERMES_GATE_TIMEOUT_MS ?? 20 * 60 * 1000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status ?? 'unknown'}`);
}

function runPython(label: string, path: string) {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', path] : [path];
    const result = spawnSync(command, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} exited with status ${result.status ?? 'unknown'}`);
    return;
  }
  throw new Error(`${label} requires Python 3`);
}

function currentCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('could not resolve the certified Git commit');
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('certified Git commit is invalid');
  return commit;
}

async function resetDisposableDatabase(pass: number) {
  console.log(`[hermes-release-gate] pass ${pass}/${requiredPasses}: reset disposable database ${databaseName}`);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
  } finally {
    await client.end();
  }
}

async function main() {
  const startedAt = new Date();
  const passes: Array<{ pass: number; completed_at: string }> = [];

  for (let pass = 1; pass <= requiredPasses; pass += 1) {
    await resetDisposableDatabase(pass);
    run(`pass ${pass}: install fresh schema`, ['db:push-full']);
    run(`pass ${pass}: seed fresh organization`, ['db:seed:demo']);
    run(`pass ${pass}: Deft employee boundary matrix`, [
      '--filter', '@deft/api', 'test', '--', ...apiSuites,
    ]);
    run(`pass ${pass}: Agent Channel bridge recovery`, ['test:hermes-channel']);
    runPython(`pass ${pass}: Hermes employee hook`, 'integrations/hermes/deft-employee/test_deft_employee.py');
    runPython(`pass ${pass}: Hermes memory provider`, 'integrations/hermes/deft-memory/test_deft_memory.py');
    run(`pass ${pass}: matched integration bundle`, ['agent:hermes-bundle']);
    passes.push({ pass, completed_at: new Date().toISOString() });
  }

  mkdirSync(dirname(certificatePath), { recursive: true });
  const certificate = {
    schema: 'deft.hermes.employee.release_gate.v1',
    result: 'passed',
    clean_state: true,
    consecutive_passes: passes.length,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    commit: currentCommit(),
    database_name: databaseName,
    scenario_coverage: scenarioCoverage,
    api_suites: apiSuites,
    passes,
  };
  writeFileSync(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`, 'utf8');
  console.log(`[hermes-release-gate] PASSED ${passes.length} consecutive clean-state runs`);
  console.log(`[hermes-release-gate] certificate: ${certificatePath}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
