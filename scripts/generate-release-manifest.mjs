#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function fail(message) {
  throw new Error(`[release-manifest] ${message}`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function expectDigest(value, label) {
  expect(/^sha256:[0-9a-f]{64}$/.test(value ?? ''), `${label} must be a sha256 digest`);
  return value;
}

function componentIdentity(component) {
  return { id: component?.id, name: component?.name, version: component?.version };
}

function sameJson(actual, expected, label) {
  expect(JSON.stringify(actual) === JSON.stringify(expected), `${label} does not match the verified bundle`);
}

const expectedSuites = [
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

async function sha256(path) {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}

const verifyOnly = process.argv.includes('--verify-only');
const certificatePath = resolve(requiredEnv('HERMES_CERTIFICATE_PATH'));
const evidencePath = resolve(requiredEnv('HERMES_BUNDLE_EVIDENCE_PATH'));
const releaseTag = requiredEnv('RELEASE_TAG');
const releaseVersion = requiredEnv('RELEASE_VERSION');
const releaseCommit = requiredEnv('RELEASE_COMMIT');
expect(/^v.+/.test(releaseTag), 'RELEASE_TAG must be v-prefixed');
expect(releaseTag === `v${releaseVersion}`, 'release tag and version do not match');
expect(/^[0-9a-f]{40}$/.test(releaseCommit), 'RELEASE_COMMIT must be a full Git commit');

const [certificate, evidence] = await Promise.all([
  readJson(certificatePath, 'Hermes employee certificate'),
  readJson(evidencePath, 'Hermes bundle evidence'),
]);

expect(certificate.schema === 'deft.hermes.employee.release_gate.v2', 'v2 Hermes employee certificate is required');
expect(certificate.result === 'passed', 'Hermes employee certificate did not pass');
expect(certificate.source_tree_clean === true, 'certificate source tree was not clean');
expect(certificate.clean_state_database === true, 'certificate database was not clean-state');
expect(certificate.consecutive_passes === 2, 'certificate must contain exactly two consecutive passes');
expect(certificate.deft?.release === releaseVersion, 'certificate Deft release does not match the release version');
expect(certificate.deft?.expected_tag === releaseTag, 'certificate expected tag does not match the release tag');
expect(certificate.deft?.tag_verified === true, 'certificate did not verify the release tag');
expect(certificate.deft?.commit === releaseCommit, 'certificate commit does not match the release tag commit');

expect(evidence.schema === 'deft.hermes.integration.bundle_evidence.v1', 'unsupported Hermes bundle evidence schema');
const manifestDigest = expectDigest(evidence.manifest_sha256, 'bundle manifest digest');
const contentDigest = expectDigest(evidence.content_sha256, 'bundle content digest');
const manifest = evidence.manifest;
expect(manifest?.schema === 'deft.hermes.integration.v2', 'verified bundle must contain a v2 integration manifest');
expect(manifest.deft_release === releaseVersion, 'verified bundle targets a different Deft release');
expect(manifest.deft_release_compatibility === `=${releaseVersion}`, 'verified bundle compatibility is not release-exact');
expect(typeof manifest.hermes_compatibility === 'string' && manifest.hermes_compatibility.length > 0,
  'verified bundle has no Hermes compatibility declaration');
expect(contentDigest === `sha256:${manifest.content_digest?.value ?? ''}`,
  'verified content digest does not match the bundle manifest');

const testedRuntime = certificate.hermes?.tested_runtime;
const declaredRuntime = manifest.hermes_tested;
expect(certificate.hermes?.declared_compatibility === manifest.hermes_compatibility,
  'certificate Hermes compatibility does not match the bundle');
for (const field of ['distribution', 'version', 'repository', 'ref', 'commit']) {
  expect(typeof testedRuntime?.[field] === 'string' && testedRuntime[field].length > 0,
    `certificate Hermes tested runtime ${field} is missing`);
  expect(typeof declaredRuntime?.[field] === 'string' && declaredRuntime[field].length > 0,
    `bundle Hermes tested runtime ${field} is missing`);
  expect(testedRuntime?.[field] === declaredRuntime?.[field],
    `certificate Hermes tested runtime ${field} does not match the bundle`);
}
expect(/^[0-9a-f]{40}$/.test(testedRuntime.commit), 'certificate Hermes commit must be a full Git commit');
expect(/^3\.11\.\d+$/.test(testedRuntime?.python_version ?? ''),
  'certificate must record an observed Python 3.11 patch version');

expect(Array.isArray(manifest.adapters), 'verified bundle has no adapter declarations');
const defaultAdapters = manifest.adapters.filter((adapter) => adapter?.role === 'default');
expect(defaultAdapters.length === 1, 'verified bundle must declare exactly one default adapter');
const defaultAdapter = defaultAdapters[0];
expect(defaultAdapter.id === manifest.default_adapter, 'verified bundle default adapter id is inconsistent');
const fallbackAdapters = manifest.adapters
  .filter((adapter) => adapter.role === 'fallback')
  .map(componentIdentity);
expect(fallbackAdapters.length > 0, 'verified bundle must retain at least one fallback adapter');
for (const [label, component] of [
  ['default adapter', componentIdentity(defaultAdapter)],
  ...fallbackAdapters.map((component, index) => [`fallback adapter ${index + 1}`, component]),
]) {
  expect(Object.values(component).every((value) => typeof value === 'string' && value.length > 0),
    `verified bundle ${label} identity is incomplete`);
}
expect(certificate.integration?.schema === manifest.schema, 'certificate integration schema does not match the bundle');
expect(certificate.integration?.version === manifest.integration_version, 'certificate integration version does not match the bundle');
sameJson(componentIdentity(certificate.integration?.default_adapter), componentIdentity(defaultAdapter),
  'certificate default adapter');
sameJson((certificate.integration?.fallback_adapters ?? []).map(componentIdentity), fallbackAdapters,
  'certificate fallback adapters');
expect(certificate.integration?.manifest_sha256 === manifestDigest,
  'certificate manifest digest does not match the downloaded bundle');
expect(certificate.integration?.content_sha256 === contentDigest,
  'certificate content digest does not match the downloaded bundle');

expect(Array.isArray(certificate.passes) && certificate.passes.length === certificate.consecutive_passes,
  'certificate pass count does not match consecutive_passes');
for (const [index, pass] of certificate.passes.entries()) {
  expect(pass?.pass === index + 1, `certificate pass ${index + 1} is out of order`);
  expect(typeof pass.completed_at === 'string' && !Number.isNaN(Date.parse(pass.completed_at)),
    `certificate pass ${index + 1} has no valid completion time`);
  sameJson(
    pass.suites,
    expectedSuites.map((suite) => ({ ...suite, result: 'passed' })),
    `certificate pass ${index + 1} suite evidence`,
  );
  expect(pass.bundle?.manifest_sha256 === manifestDigest,
    `certificate pass ${index + 1} manifest digest does not match the downloaded bundle`);
  expect(pass.bundle?.content_sha256 === contentDigest,
    `certificate pass ${index + 1} content digest does not match the downloaded bundle`);
}

if (verifyOnly) {
  console.log(JSON.stringify({ ok: true, manifest_sha256: manifestDigest, content_sha256: contentDigest }));
  process.exit(0);
}

const archivePath = resolve(requiredEnv('HERMES_ARCHIVE_PATH'));
const outputPath = resolve(process.env.RELEASE_MANIFEST_PATH?.trim() || 'dist/release-manifest.json');
const manifestOutput = {
  schema: 'deft.release.v1',
  tag: releaseTag,
  commit: releaseCommit,
  image: requiredEnv('RELEASE_IMAGE'),
  digest: expectDigest(requiredEnv('RELEASE_IMAGE_DIGEST'), 'release image digest'),
  signature: 'sigstore-keyless',
  signature_identity: requiredEnv('RELEASE_SIGNATURE_IDENTITY'),
  provenance: 'github-build-attestation',
  license: 'AGPL-3.0-only',
  source: requiredEnv('RELEASE_SOURCE_URL'),
  platforms: ['linux/amd64'],
  upgrade_support: 'versioned-from-v0.2.0-preview.1',
  agent_channel_protocol: 'deft.agent_channel.v2',
  hermes_integration: basename(archivePath),
  hermes_employee_certification: basename(certificatePath),
  hermes_integration_manifest_sha256: manifestDigest,
  hermes_integration_content_sha256: contentDigest,
  hermes_integration_archive_sha256: await sha256(archivePath),
  hermes_employee_certification_sha256: await sha256(certificatePath),
  hermes_compatibility: manifest.hermes_compatibility,
  hermes_tested_runtime: testedRuntime,
};

await writeFile(outputPath, `${JSON.stringify(manifestOutput, null, 2)}\n`, 'utf8');
console.log(`[release-manifest] wrote ${outputPath}`);
