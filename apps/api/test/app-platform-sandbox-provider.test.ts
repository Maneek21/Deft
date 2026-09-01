import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DEFT_APP_KIT_VERSION,
  SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS,
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
} from '@deft/app-kit';
import { MCPClientManager } from '@deft/mcp';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const providerSource = resolve(repositoryRoot, 'examples', 'app-platform-sandbox-email-provider');
const proofBundlePath = resolve(repositoryRoot, 'examples', 'app-platform-connected-proof-bundle.json');

function runPnpm(args: string[], cwd: string) {
  const npmExecPath = process.env.npm_execpath
    ?? (process.platform === 'win32' && process.env.APPDATA
      ? resolve(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      : null);
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...args], { cwd, encoding: 'utf8' })
    : spawnSync('pnpm', args, { cwd, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'),
  );
  return result;
}

test('packed standalone sandbox provider conforms through the official stdio transport', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'deft-app-provider-'));
  const artifacts = resolve(temporaryRoot, 'artifacts');
  const consumer = resolve(temporaryRoot, 'consumer');
  const previous = {
    selfHosted: process.env.DEFT_SELF_HOSTED,
    unsafeStdio: process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO,
    allowlist: process.env.MCP_STDIO_ALLOWED_COMMANDS,
  };
  const manager = new MCPClientManager();
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(consumer, { recursive: true });
    runPnpm(['--dir', providerSource, 'pack', '--pack-destination', artifacts, '--json'], repositoryRoot);
    const archives = (await readdir(artifacts)).filter((entry) => entry.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    const archive = resolve(artifacts, archives[0]!);
    const proofBundle = JSON.parse(await readFile(proofBundlePath, 'utf8')) as any;
    const providerPin = proofBundle.providers.sandbox_email;
    assert.equal(proofBundle.schema, 'deft.app_platform.connected_proof_bundle.v1');
    assert.equal(proofBundle.app_kit.version, DEFT_APP_KIT_VERSION);
    assert.equal(archives[0], providerPin.artifact.filename);
    assert.equal((await stat(archive)).size, providerPin.artifact.byte_length);
    assert.equal(
      `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}`,
      providerPin.artifact.digest,
    );
    const contactsLock = JSON.parse(await readFile(
      resolve(repositoryRoot, proofBundle.dependencies.contacts.lock_path),
      'utf8',
    )) as any;
    assert.equal(contactsLock.app_id, proofBundle.dependencies.contacts.app_id);
    assert.equal(contactsLock.version, proofBundle.dependencies.contacts.version);
    assert.equal(contactsLock.package_digest, proofBundle.dependencies.contacts.package_digest);
    assert.equal(contactsLock.manifest_digest, proofBundle.dependencies.contacts.manifest_digest);

    await writeFile(resolve(consumer, 'package.json'), JSON.stringify({
      name: 'deft-sandbox-provider-consumer',
      version: '1.0.0',
      private: true,
      dependencies: {
        '@deft/app-platform-sandbox-email-provider': `file:${archive}`,
      },
    }, null, 2), 'utf8');
    runPnpm(['--dir', consumer, 'install', '--ignore-workspace', '--offline'], repositoryRoot);

    const serverPath = resolve(
      consumer,
      'node_modules',
      '@deft',
      'app-platform-sandbox-email-provider',
      'server.mjs',
    );
    assert.match(await readFile(serverPath, 'utf8'), /server\/discover/);
    process.env.DEFT_SELF_HOSTED = 'true';
    process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
    process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
    const config = {
      connectionId: 'phase6-packed-sandbox-provider',
      connectionSlug: 'phase6_sandbox',
      orgId: '00000000-0000-4000-8000-000000000006',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [serverPath],
    };

    const discovery = await manager.testToolDiscovery(config);
    assert.equal(discovery.providerTools.length, 1);
    assert.deepEqual(discovery.providerTools[0], {
      name: 'send_email',
      title: 'Send sandbox email',
      description: 'Accept one deterministic sandbox email without network egress.',
      inputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
      outputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    });

    const first = await manager.executeTool(
      config,
      'send_email',
      { ...SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input },
    );
    assert.equal(first.success, true, first.error);
    assert.deepEqual(first.structuredContent, SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.output);
    const replay = await manager.executeTool(
      config,
      'send_email',
      { ...SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input },
    );
    assert.equal(replay.success, true, replay.error);
    assert.deepEqual(replay.structuredContent, first.structuredContent);

    const conflict = await manager.executeTool(config, 'send_email', {
      ...SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input,
      subject: 'Different input',
    });
    assert.equal(conflict.success, false);
    assert.match(conflict.error ?? '', /idempotency key was reused with different input/i);

    const invalid = await manager.executeTool(
      config,
      'send_email',
      { ...SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.invalid[0].input },
    );
    assert.equal(invalid.success, false);
    assert.match(invalid.error ?? '', /valid email address/i);
  } finally {
    await manager.shutdown();
    if (previous.selfHosted === undefined) delete process.env.DEFT_SELF_HOSTED;
    else process.env.DEFT_SELF_HOSTED = previous.selfHosted;
    if (previous.unsafeStdio === undefined) delete process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO;
    else process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = previous.unsafeStdio;
    if (previous.allowlist === undefined) delete process.env.MCP_STDIO_ALLOWED_COMMANDS;
    else process.env.MCP_STDIO_ALLOWED_COMMANDS = previous.allowlist;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
