import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = join(repoRoot, 'scripts', 'build-hermes-integration-bundle.mjs');
const verifyScript = join(repoRoot, 'scripts', 'verify-hermes-integration-bundle.mjs');

let testRoot;
let firstDirectory;
let secondDirectory;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(script, args) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runFailure(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `expected command to fail: ${script} ${args.join(' ')}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function build(directory, style = 'flag') {
  const args = style === 'positional' ? [directory] : ['--directory', directory];
  return run(buildScript, args);
}

function verify(directory, style = 'flag') {
  const args = style === 'positional'
    ? [directory, '--json']
    : ['--directory', directory, '--json'];
  return JSON.parse(run(verifyScript, args));
}

async function outputFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `bundle must not contain symlink ${path}`);
    if (entry.isDirectory()) files.push(...await outputFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files.sort();
}

async function snapshot(directory) {
  const result = {};
  for (const path of await outputFiles(directory)) {
    result[path] = sha256(await readFile(join(directory, path)));
  }
  return result;
}

async function freshBundle(name) {
  const directory = join(testRoot, name);
  build(directory);
  return directory;
}

before(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'deft-hermes-bundle-'));
  firstDirectory = await freshBundle('first');
  secondDirectory = join(testRoot, 'second');
  build(secondDirectory, 'positional');
});

after(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

test('native-first bundle and verifier evidence are deterministic across isolated directories', async () => {
  const firstEvidence = verify(firstDirectory, 'positional');
  const secondEvidence = verify(secondDirectory);
  assert.deepEqual(secondEvidence, firstEvidence);
  assert.deepEqual(await snapshot(secondDirectory), await snapshot(firstDirectory));

  assert.equal(firstEvidence.schema, 'deft.hermes.integration.bundle_evidence.v1');
  assert.match(firstEvidence.manifest_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(firstEvidence.content_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(firstEvidence.manifest.schema, 'deft.hermes.integration.v2');
  assert.equal(firstEvidence.manifest.default_adapter, 'native');
  assert.equal(firstEvidence.manifest.mcp.default_transport, 'direct_http');
  assert.equal(firstEvidence.manifest.mcp.endpoint_path, '/api/mcp/hermes/v1');
  assert.equal(firstEvidence.manifest.hermes_compatibility, '>=0.20.5 <0.21.0');
  assert.deepEqual(firstEvidence.manifest.hermes_tested, {
    distribution: 'hermes-agent',
    version: '0.20.5',
    repository: 'https://github.com/NousResearch/hermes-agent.git',
    ref: 'refs/tags/v2026.8.19',
    commit: 'fcbd1076a93841fa88855acce810e342a5b78101',
    provenance: {
      runtime_audit: 'docs/superpowers/audits/2026-08-26-hermes-native-runtime-provenance.md',
      native_adapter_suite: 'integrations/hermes/deft-platform/test_deft_platform.py',
    },
  });

  const expectedFiles = [
    'README.md',
    'config.example.yaml',
    'legacy/bridge/README.md',
    'legacy/bridge/deft-mcp-stdio.mjs',
    'legacy/bridge/hermes-agent-channel-bridge.mjs',
    'legacy/bridge/hermes-channel-service.ps1',
    'legacy/bridge/run-hermes-channel-service.ps1',
    'manifest.json',
    'plugins/deft-employee/README.md',
    'plugins/deft-employee/SKILL.md',
    'plugins/deft-employee/__init__.py',
    'plugins/deft-employee/plugin.yaml',
    'plugins/deft-memory/README.md',
    'plugins/deft-memory/__init__.py',
    'plugins/deft-memory/plugin.yaml',
    'plugins/deft-platform/README.md',
    'plugins/deft-platform/__init__.py',
    'plugins/deft-platform/adapter.py',
    'plugins/deft-platform/plugin.yaml',
    'plugins/deft-platform/readiness.py',
  ].sort();
  assert.deepEqual(await outputFiles(firstDirectory), expectedFiles);
  assert.deepEqual(
    Object.keys(firstEvidence.manifest.checksums),
    expectedFiles.filter((path) => path !== 'manifest.json'),
  );

  for (const path of expectedFiles) {
    const bytes = await readFile(join(firstDirectory, path));
    assert.equal(bytes.includes(13), false, `${path} must use canonical LF line endings`);
  }
  const manifestBytes = await readFile(join(firstDirectory, 'manifest.json'));
  assert.equal(firstEvidence.manifest_sha256, `sha256:${sha256(manifestBytes)}`);
  assert.equal(
    firstEvidence.content_sha256,
    `sha256:${firstEvidence.manifest.content_digest.value}`,
  );
});

test('verifier rejects a changed file even if its manifest checksums are rewritten', async () => {
  const directory = await freshBundle('changed');
  const target = join(directory, 'plugins', 'deft-platform', 'adapter.py');
  const changed = Buffer.concat([await readFile(target), Buffer.from('# tampered\n')]);
  await writeFile(target, changed);

  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.checksums['plugins/deft-platform/adapter.py'] = sha256(changed);
  const canonicalContent = Object.entries(manifest.checksums)
    .map(([path, digest]) => `${path}\0${digest}\n`)
    .join('');
  manifest.content_digest.value = sha256(Buffer.from(canonicalContent, 'utf8'));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  assert.match(
    runFailure(verifyScript, ['--directory', directory, '--json']),
    /does not match its source: plugins\/deft-platform\/adapter\.py/,
  );
});

test('verifier rejects added and unsafe files', async () => {
  const addedDirectory = await freshBundle('added');
  await writeFile(join(addedDirectory, 'notes.txt'), 'unexpected\n', 'utf8');
  assert.match(
    runFailure(verifyScript, [addedDirectory, '--json']),
    /Bundle files mismatch/,
  );

  const unsafeDirectory = await freshBundle('unsafe');
  await mkdir(join(unsafeDirectory, 'state'));
  await writeFile(join(unsafeDirectory, 'state', 'event.json'), '{}\n', 'utf8');
  assert.match(
    runFailure(verifyScript, [unsafeDirectory, '--json']),
    /forbidden in a release bundle/,
  );
});

test('verifier rejects deleted files', async () => {
  const directory = await freshBundle('deleted');
  await unlink(join(directory, 'plugins', 'deft-memory', 'README.md'));
  assert.match(runFailure(verifyScript, [directory, '--json']), /Bundle files mismatch/);
});

test('verifier rejects symlinked or junctioned bundle paths', async () => {
  const directory = await freshBundle('linked');
  const external = join(testRoot, 'external-link-target');
  await mkdir(external);
  await symlink(external, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(
    runFailure(verifyScript, [directory, '--json']),
    /symlink or junction|symbolic link or junction/,
  );
});

test('verifier rejects source-manifest drift, unsorted checksums, and bad content digests', async () => {
  const driftDirectory = await freshBundle('manifest-drift');
  const driftManifestPath = join(driftDirectory, 'manifest.json');
  const driftManifest = JSON.parse(await readFile(driftManifestPath, 'utf8'));
  driftManifest.deft_release = '0.0.0-invalid';
  await writeFile(driftManifestPath, `${JSON.stringify(driftManifest, null, 2)}\n`, 'utf8');
  assert.match(runFailure(verifyScript, [driftDirectory, '--json']), /Bundle\/source manifest mismatch/);

  const orderDirectory = await freshBundle('checksum-order');
  const orderManifestPath = join(orderDirectory, 'manifest.json');
  const orderManifest = JSON.parse(await readFile(orderManifestPath, 'utf8'));
  orderManifest.checksums = Object.fromEntries(Object.entries(orderManifest.checksums).reverse());
  await writeFile(orderManifestPath, `${JSON.stringify(orderManifest, null, 2)}\n`, 'utf8');
  assert.match(runFailure(verifyScript, [orderDirectory, '--json']), /Sorted bundle checksum paths mismatch/);

  const digestDirectory = await freshBundle('content-digest');
  const digestManifestPath = join(digestDirectory, 'manifest.json');
  const digestManifest = JSON.parse(await readFile(digestManifestPath, 'utf8'));
  digestManifest.content_digest.value = '0'.repeat(64);
  await writeFile(digestManifestPath, `${JSON.stringify(digestManifest, null, 2)}\n`, 'utf8');
  assert.match(runFailure(verifyScript, [digestDirectory, '--json']), /Bundle content digest mismatch/);
});

test('explicit build directory never replaces pre-existing content', async () => {
  const directory = join(testRoot, 'non-empty');
  await mkdir(directory);
  const sentinel = join(directory, 'keep.txt');
  await writeFile(sentinel, 'keep\n', 'utf8');
  assert.match(
    runFailure(buildScript, ['--directory', directory]),
    /Explicit bundle output directory must be new or empty/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'keep\n');
});

test('bundle CLIs reject conflicting directories and unsupported options', () => {
  assert.match(
    runFailure(verifyScript, ['one', '--directory', 'two', '--json']),
    /Bundle directory may be specified only once/,
  );
  assert.match(runFailure(buildScript, ['--json']), /--json is only supported by the verifier/);
  assert.match(runFailure(verifyScript, ['--unknown']), /Unknown option/);
});
