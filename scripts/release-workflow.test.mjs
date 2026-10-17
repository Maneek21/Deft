import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const generatorUrl = new URL('./generate-release-manifest.mjs', import.meta.url);
const generator = readFileSync(generatorUrl, 'utf8');
const scopeResolverUrl = new URL('./resolve-release-scope.mjs', import.meta.url);
const sourceRepoRoot = fileURLToPath(new URL('..', import.meta.url));
const suiteContract = [
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
];

function position(label) {
  const index = workflow.indexOf(label);
  assert.notEqual(index, -1, `release workflow is missing: ${label}`);
  return index;
}

function createPinnedHermesFixture(root) {
  const manifest = JSON.parse(readFileSync(join(sourceRepoRoot, 'integrations/hermes/integration-manifest.json'), 'utf8'));
  const sources = new Set([
    'integrations/hermes/integration-manifest.json',
    'apps/api/src/lib/agent-channel.ts',
    'apps/api/src/routes/agent-employees.ts',
    'scripts/hermes-agent-channel-bridge.mjs',
    'scripts/hermes-channel-service.ps1',
    'scripts/run-hermes-channel-service.ps1',
    'scripts/build-hermes-integration-bundle.mjs',
    'scripts/verify-hermes-integration-bundle.mjs',
    'scripts/lib/hermes-integration-bundle.mjs',
    manifest.hermes_tested.provenance.runtime_audit,
    manifest.hermes_tested.provenance.native_adapter_suite,
    ...manifest.adapters.flatMap((adapter) => adapter.files.map((file) => file.source)),
    ...manifest.common_plugins.flatMap((plugin) => plugin.files.map((file) => file.source)),
  ]);
  for (const relativePath of sources) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRepoRoot, relativePath), target);
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: manifest.deft_release }, null, 2)}\n`);
}

test('release publication signs and verifies the exact image digest before creating a release', () => {
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /IMAGE_REF:\s*\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}@\$\{\{ steps\.digest\.outputs\.digest \}\}/);
  assert.match(workflow, /cosign sign --yes "\$IMAGE_REF"/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /gh attestation verify "oci:\/\/\$IMAGE_REF" --repo "\$GITHUB_REPOSITORY"/);
  assert.ok(position('- name: Attest image provenance') < position('- name: Sign release image digest'));
  assert.ok(position('- name: Sign release image digest') < position('- name: Verify signature and provenance'));
  assert.ok(position('- name: Verify signature and provenance') < position('- name: Create GitHub release'));
});

test('manual recovery reuses and verifies the original tag-signed digest', () => {
  assert.match(workflow, /reuse_existing_image:/);
  assert.match(workflow, /Resolve existing signed image digest/);
  assert.match(workflow, /if: steps\.existing\.outputs\.digest == ''/);
  assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(workflow, /RELEASE_IMAGE_DIGEST:\s*\$\{\{ steps\.digest\.outputs\.digest \}\}/);
  assert.match(workflow, /RELEASE_SIGNATURE_IDENTITY:\s*\$\{\{ steps\.verification\.outputs\.signature_identity \}\}/);
});

test('certification provisions the exact pinned Hermes runtime outside its clean checkout', () => {
  const certify = workflow.slice(position('  certify:'), position('  publish:'));
  for (const source of [certify, ciWorkflow]) {
    assert.match(source, /python-version: '3\.11'/);
    assert.match(source, /hermes_tested\.repository/);
    assert.match(source, /hermes_tested\.ref/);
    assert.match(source, /hermes_tested\.commit/);
    assert.match(source, /hermes_root="\$RUNNER_TEMP\/hermes-agent"/);
    assert.match(source, /hermes_venv="\$RUNNER_TEMP\/hermes-venv"/);
    assert.match(source, /git -C "\$hermes_root" checkout --detach FETCH_HEAD/);
    assert.match(source, /git -C "\$hermes_root" status --porcelain=v1 --untracked-files=all/);
    assert.match(source, /"\$hermes_venv\/bin\/python" -m pip install -e "\$hermes_root"/);
    assert.match(source, /DEFT_HERMES_REPO=\$hermes_root/);
    assert.match(source, /DEFT_HERMES_PYTHON=\$hermes_venv\/bin\/python/);
  }
});

test('publish verifies and archives the carried certificate and exact bundle without rebuilding', () => {
  const publish = workflow.slice(position('  publish:'));
  assert.match(workflow, /publish:\s*[\s\S]*?needs: \[scope, certify\]/);
  assert.match(publish, /tag_commit="\$\(git rev-parse "\$tag\^\{commit\}"\)"/);
  assert.match(publish, /\[\[ "\$\(git rev-parse HEAD\)" == "\$tag_commit" \]\]/);
  assert.match(workflow, /name: hermes-employee-release-certification/);
  assert.match(workflow, /dist\/hermes-employee-release-gate\.json\s+dist\/hermes-integration/);
  assert.match(publish, /node scripts\/verify-hermes-integration-bundle\.mjs --json dist\/hermes-integration/);
  assert.match(publish, /node scripts\/generate-release-manifest\.mjs --verify-only/);
  assert.match(publish, /cmp --silent "\$HERMES_BUNDLE_EVIDENCE_PATH" "\$prearchive_evidence"/);
  assert.match(publish, /tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner --format=gnu/);
  assert.match(publish, /\| gzip -n > "dist\/deft-hermes-integration-/);
  assert.match(publish, /tar -xzf "dist\/deft-hermes-integration-/);
  assert.match(publish, /node scripts\/verify-hermes-integration-bundle\.mjs --json "\$archive_verify_root"/);
  assert.match(publish, /cmp --silent "\$HERMES_BUNDLE_EVIDENCE_PATH" "\$archive_evidence"/);
  assert.doesNotMatch(publish, /build-hermes-integration-bundle|agent:hermes-bundle/);

  const download = position('- name: Download Hermes employee certification');
  const verify = position('- name: Verify carried Hermes certificate and bundle');
  const sbom = position('- name: Generate SPDX SBOM');
  const archive = position('- name: Archive and reverify the carried Hermes integration');
  const manifest = position('- name: Generate release manifest');
  const checksums = position('- name: Generate checksums');
  const release = position('- name: Create GitHub release');
  assert.ok(
    download < verify && verify < sbom && sbom < archive
      && archive < manifest && manifest < checksums && checksums < release,
  );
});

test('release scope is commit-pinned and fails closed before publication', () => {
  const scope = JSON.parse(readFileSync(new URL('../release/release-scope.json', import.meta.url), 'utf8'));
  assert.equal(scope.schema, 'deft.release.scope.v1');
  assert.ok(['core', 'hermes-certified'].includes(scope.scope));
  assert.match(workflow, /Validate commit-pinned release scope/);
  assert.match(workflow, /node scripts\/resolve-release-scope\.mjs --github-output/);
  assert.match(workflow, /needs\.scope\.result == 'success'/);
  assert.match(workflow, /always\(\) && !cancelled\(\)/);
  assert.match(workflow, /needs\.scope\.outputs\.release_scope == 'core' \|\| needs\.certify\.result == 'success'/);
  assert.match(workflow, /certify:[\s\S]*?if: needs\.scope\.outputs\.release_scope == 'hermes-certified'/);
  for (const step of [
    'Download Hermes employee certification',
    'Verify carried Hermes certificate and bundle',
    'Archive and reverify the carried Hermes integration',
  ]) {
    assert.match(workflow, new RegExp(`- name: ${step}\\n\\s+if: needs\\.scope\\.outputs\\.release_scope == 'hermes-certified'`));
  }
});

test('release scope resolver rejects missing, unknown, and contradictory decisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-release-scope-'));
  const invoke = (document) => {
    const scopePath = join(directory, 'scope.json');
    if (document !== undefined) writeFileSync(scopePath, JSON.stringify(document));
    return spawnSync(process.execPath, [fileURLToPath(scopeResolverUrl)], {
      encoding: 'utf8', env: { ...process.env, RELEASE_SCOPE_PATH: scopePath },
    });
  };
  try {
    assert.notEqual(invoke(undefined).status, 0);
    assert.notEqual(invoke({ schema: 'deft.release.scope.v1', scope: 'other' }).status, 0);
    assert.notEqual(invoke({ schema: 'deft.release.scope.v1', scope: 'core', hermes: true }).status, 0);
    assert.equal(invoke({ schema: 'deft.release.scope.v1', scope: 'hermes-certified' }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pre-archive verification rejects bundle bytes changed after initial evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-release-bundle-carry-'));
  const fixtureRoot = join(directory, 'repository');
  createPinnedHermesFixture(fixtureRoot);
  const bundleDirectory = join(directory, 'bundle');
  const fixtureBuildUrl = join(fixtureRoot, 'scripts', 'build-hermes-integration-bundle.mjs');
  const fixtureVerifyUrl = join(fixtureRoot, 'scripts', 'verify-hermes-integration-bundle.mjs');
  const invoke = (path) => spawnSync(process.execPath, [path, '--directory', bundleDirectory, '--json'], {
    encoding: 'utf8', cwd: fixtureRoot,
  });
  try {
    const built = spawnSync(
      process.execPath,
      [fixtureBuildUrl, '--directory', bundleDirectory],
      { encoding: 'utf8', cwd: fixtureRoot },
    );
    assert.equal(built.status, 0, built.stderr);
    const initial = invoke(fixtureVerifyUrl);
    assert.equal(initial.status, 0, initial.stderr);
    const configPath = join(bundleDirectory, 'config.example.yaml');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}# late mutation\n`, 'utf8');
    const rejected = invoke(fixtureVerifyUrl);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /does not match its source/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v2 evidence is rejected unless tag, release, runtime, adapters, and every pass digest match', () => {
  assert.match(generator, /deft\.hermes\.employee\.release_gate\.v2/);
  assert.match(generator, /deft\.hermes\.integration\.bundle_evidence\.v1/);
  assert.match(generator, /source_tree_clean === true/);
  assert.match(generator, /clean_state_database === true/);
  assert.match(generator, /certificate\.consecutive_passes === 2/);
  assert.match(generator, /certificate\.deft\?\.expected_tag === releaseTag/);
  assert.match(generator, /certificate\.deft\?\.tag_verified === true/);
  assert.match(generator, /certificate\.deft\?\.commit === releaseCommit/);
  assert.match(generator, /testedRuntime\?\.\[field\] === declaredRuntime\?\.\[field\]/);
  assert.match(generator, /certificate\.integration\?\.manifest_sha256 === manifestDigest/);
  assert.match(generator, /certificate\.integration\?\.content_sha256 === contentDigest/);
  assert.match(generator, /pass\.bundle\?\.manifest_sha256 === manifestDigest/);
  assert.match(generator, /pass\.bundle\?\.content_sha256 === contentDigest/);
  assert.match(generator, /expectedSuites\.map\(\(suite\) => \(\{ \.\.\.suite, result: ["']passed["'] \}\)\)/);
});

test('release manifest v2 keeps integrity fields and adds explicit scope', () => {
  for (const field of [
    'schema', 'tag', 'commit', 'image', 'digest', 'signature', 'signature_identity',
    'provenance', 'license', 'source', 'platforms', 'upgrade_support',
    'agent_channel_protocol', 'hermes_integration', 'hermes_employee_certification',
  ]) assert.match(generator, new RegExp(`\\b${field}:`));
  assert.match(generator, /hermes_integration_manifest_sha256: manifestDigest/);
  assert.match(generator, /hermes_integration_content_sha256: contentDigest/);
  assert.match(generator, /hermes_integration_archive_sha256: await sha256\(archivePath\)/);
  assert.match(generator, /hermes_employee_certification_sha256: await sha256\(certificatePath\)/);
  assert.match(generator, /hermes_compatibility: manifest\.hermes_compatibility/);
  assert.match(generator, /hermes_tested_runtime: testedRuntime/);
});

test('release-manifest generator computes the carried archive and certificate hashes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-release-manifest-'));
  try {
    const certificatePath = join(directory, 'hermes-employee-release-gate.json');
    const evidencePath = join(directory, 'bundle-evidence.json');
    const archivePath = join(directory, 'deft-hermes-integration-1.2.3.tar.gz');
    const outputPath = join(directory, 'release-manifest.json');
    const scopePath = join(directory, 'scope.json');
    writeFileSync(scopePath, JSON.stringify({ schema: 'deft.release.scope.v1', scope: 'hermes-certified' }));
    const manifestDigest = `sha256:${'a'.repeat(64)}`;
    const contentDigest = `sha256:${'b'.repeat(64)}`;
    const runtime = {
      distribution: 'hermes-agent', version: '0.20.5',
      repository: 'https://github.com/NousResearch/hermes-agent.git',
      ref: 'refs/tags/v2026.8.19', commit: 'd'.repeat(40), python_version: '3.11.15',
    };
    const defaultAdapter = { id: 'native', name: 'deft-platform', version: '0.2.0' };
    const fallback = [{ id: 'legacy', name: 'deft-agent-channel-bridge', version: '0.3.0' }];
    const certificate = {
      schema: 'deft.hermes.employee.release_gate.v2', result: 'passed',
      source_tree_clean: true, clean_state_database: true, consecutive_passes: 2,
      deft: { release: '1.2.3', expected_tag: 'v1.2.3', tag_verified: true, commit: 'c'.repeat(40) },
      hermes: { declared_compatibility: '>=0.20.5 <0.21.0', tested_runtime: runtime },
      integration: {
        schema: 'deft.hermes.integration.v2', version: '0.4.0',
        default_adapter: defaultAdapter, fallback_adapters: fallback,
        manifest_sha256: manifestDigest, content_sha256: contentDigest,
      },
      passes: [1, 2].map((pass) => ({
        pass, completed_at: '2026-08-26T00:00:00.000Z',
        suites: suiteContract.map((suite) => ({ ...suite, result: 'passed' })),
        bundle: { manifest_sha256: manifestDigest, content_sha256: contentDigest },
      })),
    };
    writeFileSync(certificatePath, JSON.stringify(certificate));
    writeFileSync(evidencePath, JSON.stringify({
      schema: 'deft.hermes.integration.bundle_evidence.v1',
      manifest_sha256: manifestDigest, content_sha256: contentDigest,
      manifest: {
        schema: 'deft.hermes.integration.v2', integration_version: '0.4.0',
        deft_release: '1.2.3', deft_release_compatibility: '=1.2.3',
        hermes_compatibility: '>=0.20.5 <0.21.0',
        default_adapter: 'native',
        hermes_tested: {
          distribution: runtime.distribution, version: runtime.version,
          repository: runtime.repository, ref: runtime.ref, commit: runtime.commit,
        },
        adapters: [{ ...defaultAdapter, role: 'default' }, { ...fallback[0], role: 'fallback' }],
        content_digest: { value: 'b'.repeat(64) },
      },
    }));
    writeFileSync(archivePath, 'verified archive bytes');
    const generatorEnv = {
      ...process.env,
      RELEASE_TAG: 'v1.2.3', RELEASE_VERSION: '1.2.3', RELEASE_COMMIT: 'c'.repeat(40),
      RELEASE_IMAGE: 'ghcr.io/maneek21/deft:1.2.3',
      RELEASE_IMAGE_DIGEST: `sha256:${'e'.repeat(64)}`,
      RELEASE_SIGNATURE_IDENTITY: 'https://github.com/example/release.yml@refs/tags/v1.2.3',
      RELEASE_SOURCE_URL: `https://github.com/example/deft/tree/${'c'.repeat(40)}`,
      HERMES_CERTIFICATE_PATH: certificatePath, HERMES_BUNDLE_EVIDENCE_PATH: evidencePath,
      HERMES_ARCHIVE_PATH: archivePath, RELEASE_MANIFEST_PATH: outputPath,
      RELEASE_SCOPE_PATH: scopePath,
    };
    const invokeGenerator = (...args) => spawnSync(process.execPath, [fileURLToPath(generatorUrl), ...args], {
      encoding: 'utf8', env: generatorEnv,
    });
    const result = invokeGenerator();
    assert.equal(result.status, 0, result.stderr);
    const releaseManifest = JSON.parse(readFileSync(outputPath, 'utf8'));
    const digest = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    assert.equal(releaseManifest.schema, 'deft.release.v2');
    assert.equal(releaseManifest.release_scope, 'hermes-certified');
    assert.equal(releaseManifest.hermes_integration, 'deft-hermes-integration-1.2.3.tar.gz');
    assert.equal(releaseManifest.hermes_integration_archive_sha256, digest(archivePath));
    assert.equal(releaseManifest.hermes_employee_certification_sha256, digest(certificatePath));
    assert.deepEqual(releaseManifest.hermes_tested_runtime, runtime);
    const verified = invokeGenerator('--verify-only');
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), {
      ok: true,
      release_scope: 'hermes-certified',
      manifest_sha256: manifestDigest,
      content_sha256: contentDigest,
    });

    const rejectionCases = [
      ['v1 schema', (value) => { value.schema = 'deft.hermes.employee.release_gate.v1'; }],
      ['release', (value) => { value.deft.release = '1.2.4'; }],
      ['tag', (value) => { value.deft.expected_tag = 'v1.2.4'; }],
      ['commit', (value) => { value.deft.commit = 'f'.repeat(40); }],
      ['runtime', (value) => { value.hermes.tested_runtime.version = '0.20.4'; }],
      ['integration digest', (value) => { value.integration.content_sha256 = `sha256:${'f'.repeat(64)}`; }],
      ['pass digest', (value) => { value.passes[1].bundle.manifest_sha256 = `sha256:${'f'.repeat(64)}`; }],
      ['suite evidence', (value) => { value.passes[0].suites.pop(); }],
    ];
    for (const [label, mutate] of rejectionCases) {
      const invalidCertificate = structuredClone(certificate);
      mutate(invalidCertificate);
      writeFileSync(certificatePath, JSON.stringify(invalidCertificate));
      const rejected = invokeGenerator('--verify-only');
      assert.notEqual(rejected.status, 0, `${label} mismatch was accepted`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('core manifest keeps release integrity fields and contains no Hermes claims', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-core-release-manifest-'));
  try {
    const scopePath = join(directory, 'scope.json');
    const outputPath = join(directory, 'manifest.json');
    writeFileSync(scopePath, JSON.stringify({ schema: 'deft.release.scope.v1', scope: 'core' }));
    const result = spawnSync(process.execPath, [fileURLToPath(generatorUrl)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_SCOPE_PATH: scopePath,
        RELEASE_TAG: 'v1.2.3', RELEASE_VERSION: '1.2.3', RELEASE_COMMIT: 'c'.repeat(40),
        RELEASE_IMAGE: 'ghcr.io/maneek21/deft:1.2.3',
        RELEASE_IMAGE_DIGEST: `sha256:${'e'.repeat(64)}`,
        RELEASE_SIGNATURE_IDENTITY: 'https://github.com/example/release.yml@refs/tags/v1.2.3',
        RELEASE_SOURCE_URL: `https://github.com/example/deft/tree/${'c'.repeat(40)}`,
        RELEASE_MANIFEST_PATH: outputPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(manifest.schema, 'deft.release.v2');
    assert.equal(manifest.release_scope, 'core');
    assert.equal(manifest.signature, 'sigstore-keyless');
    assert.equal(manifest.provenance, 'github-build-attestation');
    assert.equal(Object.keys(manifest).some((field) => field.startsWith('hermes_')), false);
    const verified = spawnSync(process.execPath, [fileURLToPath(generatorUrl), '--verify-only'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_SCOPE_PATH: scopePath,
        RELEASE_TAG: 'v1.2.3', RELEASE_VERSION: '1.2.3', RELEASE_COMMIT: 'c'.repeat(40),
        HERMES_CERTIFICATE_PATH: join(directory, 'absent-certificate.json'),
      },
    });
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), { ok: true, release_scope: 'core' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI retains the v2 certificate and exact verified bundle directory', () => {
  assert.match(ciWorkflow, /run: pnpm test:hermes-integration-bundle/);
  assert.match(ciWorkflow, /Verify deterministic Hermes integration bundle\s+run: pnpm test:hermes-integration-bundle/);
  assert.match(ciWorkflow, /hermes-release-gate:[\s\S]*?if: needs\.release-scope\.outputs\.release_scope == 'hermes-certified'/);
  assert.match(ciWorkflow, /name: hermes-employee-release-gate/);
  assert.match(ciWorkflow, /path: \|\s+dist\/hermes-employee-release-gate\.json\s+dist\/hermes-integration/);
});

test('core CI still requires product typecheck, API tests, and build', () => {
  assert.match(ciWorkflow, /build:[\s\S]*?needs: \[release-scope, typecheck, test, hermes-release-gate\]/);
  assert.match(ciWorkflow, /needs\.typecheck\.result == 'success'/);
  assert.match(ciWorkflow, /needs\.test\.result == 'success'/);
  assert.match(ciWorkflow, /always\(\) && !cancelled\(\)/);
  assert.match(ciWorkflow, /needs\.release-scope\.outputs\.release_scope == 'core' \|\| needs\.hermes-release-gate\.result == 'success'/);
});

test('release environment template and every final asset receive checksum-stable names', () => {
  assert.match(workflow, /cp \.env\.example dist\/default\.env\.example/);
  assert.match(workflow, /cp docs\/self-hosting\.md dist\/self-hosting\.md/);
  assert.match(workflow, /find \. -maxdepth 1 -type f ! -name SHA256SUMS[\s\S]*sha256sum > SHA256SUMS/);
  assert.doesNotMatch(workflow, /dist\/\.env\.example/);
});

test('download-only release compose has no source-checkout initialization bind', () => {
  assert.doesNotMatch(compose, /scripts\/docker\/enable-pgvector\.sql/);
  assert.doesNotMatch(compose, /docker-entrypoint-initdb\.d/);
});
