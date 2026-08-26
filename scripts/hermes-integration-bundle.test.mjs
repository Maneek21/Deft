import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(repoRoot, 'dist', 'hermes-integration');
const buildScript = join(repoRoot, 'scripts', 'build-hermes-integration-bundle.mjs');

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function build() {
  return execFileSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

async function outputFiles(directory = outputRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `bundle must not contain symlink ${path}`);
    if (entry.isDirectory()) files.push(...await outputFiles(path));
    else if (entry.isFile()) files.push(relative(outputRoot, path).replaceAll('\\', '/'));
  }
  return sorted(files);
}

async function snapshot() {
  const result = {};
  for (const path of await outputFiles()) result[path] = sha256(await readFile(join(outputRoot, path)));
  return result;
}

test('native-first Hermes bundle is allowlisted, self-verifying, and deterministic', async () => {
  const firstBuild = build();
  assert.match(firstBuild, /Built Deft Hermes integration 0\.4\.0/);
  const firstSnapshot = await snapshot();
  const manifest = JSON.parse(await readFile(join(outputRoot, 'manifest.json'), 'utf8'));

  assert.equal(manifest.schema, 'deft.hermes.integration.v2');
  assert.equal(manifest.default_adapter, 'native');
  assert.equal(manifest.mcp.default_transport, 'direct_http');
  assert.equal(manifest.hermes_compatibility, '>=0.20.5 <0.21.0');
  assert.deepEqual(manifest.hermes_tested, {
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
  assert.deepEqual(
    manifest.adapters.map(({ id, name, version, role, target }) => ({ id, name, version, role, target })),
    [
      {
        id: 'native',
        name: 'deft-platform',
        version: '0.2.0',
        role: 'default',
        target: 'plugins/deft-platform',
      },
      {
        id: 'legacy',
        name: 'deft-agent-channel-bridge',
        version: '0.3.0',
        role: 'fallback',
        target: 'legacy/bridge',
      },
    ],
  );
  assert.deepEqual(
    manifest.common_plugins.map(({ name, version, target }) => ({ name, version, target })),
    [
      { name: 'deft-employee', version: '0.2.1', target: 'plugins/deft-employee' },
      { name: 'deft-memory', version: '0.2.1', target: 'plugins/deft-memory' },
    ],
  );

  const expectedFiles = sorted([
    'README.md',
    'config.example.yaml',
    'legacy/bridge/README.md',
    'legacy/bridge/deft-mcp-stdio.mjs',
    'legacy/bridge/hermes-agent-channel-bridge.mjs',
    'legacy/bridge/hermes-channel-service.ps1',
    'legacy/bridge/run-hermes-channel-service.ps1',
    'manifest.json',
    'plugins/deft-employee/README.md',
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
  ]);
  assert.deepEqual(await outputFiles(), expectedFiles);
  assert.equal(expectedFiles.some((path) => /__pycache__|\.pyc$|state|secret|test_/i.test(path)), false);

  const checksumPaths = Object.keys(manifest.checksums);
  assert.deepEqual(checksumPaths, expectedFiles.filter((path) => path !== 'manifest.json'));
  for (const path of checksumPaths) {
    const bytes = await readFile(join(outputRoot, path));
    assert.equal(manifest.checksums[path], sha256(bytes), path);
    assert.equal(bytes.includes(13), false, `${path} must use canonical LF line endings`);
  }
  const canonicalContent = checksumPaths
    .map((path) => `${path}\0${manifest.checksums[path]}\n`)
    .join('');
  assert.deepEqual(manifest.content_digest, {
    algorithm: 'sha256',
    canonicalization: 'deft.bundle.sorted-path-nul-sha256-lf.v1',
    value: sha256(Buffer.from(canonicalContent, 'utf8')),
  });

  const rootReadme = await readFile(join(outputRoot, 'README.md'), 'utf8');
  const nativeConfig = await readFile(join(outputRoot, 'config.example.yaml'), 'utf8');
  const legacyReadme = await readFile(join(outputRoot, 'legacy', 'bridge', 'README.md'), 'utf8');
  assert.match(rootReadme, /default adapter is the native deft-platform 0\.2\.0/);
  assert.match(rootReadme, /Never run the native adapter and legacy bridge/);
  assert.match(nativeConfig, /- deft-platform/);
  assert.match(nativeConfig, /url: https:\/\/deft\.example\/api\/mcp\/v1/);
  assert.doesNotMatch(nativeConfig, /stdio|legacy|bridge/i);
  assert.match(legacyReadme, /explicit rollback path/);
  assert.match(legacyReadme, /HERMES_API_URL=http:\/\/127\.0\.0\.1:8642/);
  assert.match(legacyReadme, /DEFT_CHANNEL_TOKEN=<replacement-agent-channel-token>/);

  const secondBuild = build();
  assert.match(secondBuild, new RegExp(`sha256:${manifest.content_digest.value}`));
  assert.deepEqual(await snapshot(), firstSnapshot);
});
