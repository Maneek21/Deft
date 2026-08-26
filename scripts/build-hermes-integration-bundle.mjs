#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(repoRoot, 'dist', 'hermes-integration');
const manifestPath = join(repoRoot, 'integrations', 'hermes', 'integration-manifest.json');
const packagePath = join(repoRoot, 'package.json');
const apiContractPath = join(repoRoot, 'apps', 'api', 'src', 'lib', 'agent-channel.ts');
const apiOnboardingPath = join(repoRoot, 'apps', 'api', 'src', 'routes', 'agent-employees.ts');
const nativeAdapterPath = join(repoRoot, 'integrations', 'hermes', 'deft-platform', 'adapter.py');
const nativeReadinessPath = join(repoRoot, 'integrations', 'hermes', 'deft-platform', 'readiness.py');
const legacyBridgePath = join(repoRoot, 'scripts', 'hermes-agent-channel-bridge.mjs');
const CONTENT_DIGEST_CANONICALIZATION = 'deft.bundle.sorted-path-nul-sha256-lf.v1';
const FORBIDDEN_BUNDLE_PATH = /(^|\/)(?:__pycache__|state|secrets?)(?:\/|$)|\.(?:pyc|pyo)$/i;

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function safeBundlePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty, forward-slash relative path`);
  }
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${label} must be relative: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe segment: ${value}`);
  }
  if (
    FORBIDDEN_BUNDLE_PATH.test(value)
    || segments.some((segment) => {
      const normalized = segment.toLowerCase();
      return normalized.includes('secret') || normalized.includes('state');
    })
  ) {
    throw new Error(`${label} is forbidden in a release bundle: ${value}`);
  }
  return value;
}

function normalizedSourceText(bytes, label) {
  if (bytes.includes(0)) throw new Error(`Bundle source must be UTF-8 text, not binary: ${label}`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`Bundle source is not valid UTF-8: ${label}`);
  }
  return text.replace(/\r\n?/g, '\n');
}

async function rejectLinkedPath(base, target, label) {
  const relativeTarget = relative(base, target);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error(`${label} is outside its trusted root: ${target}`);
  }
  let current = base;
  for (const segment of relativeTarget.split(/[\\/]/)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link or junction: ${current}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function rejectLinkedTree(directory) {
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink()) {
      throw new Error(`Bundle output is a symbolic link or junction: ${directory}`);
    }
    if (!directoryStat.isDirectory()) throw new Error(`Bundle output is not a directory: ${directory}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle output contains a symlink or junction: ${path}`);
    if (entry.isDirectory()) await rejectLinkedTree(path);
  }
}

function extractQuotedConstant(source, name, label) {
  const match = source.match(new RegExp(`(?:export\\s+const\\s+|^)${name}\\s*=\\s*[\"']([^\"']+)[\"']`, 'm'));
  if (!match) throw new Error(`Could not read ${label} constant ${name}`);
  return match[1];
}

function extractQuotedArray(source, name, label) {
  const match = source.match(new RegExp(`(?:export\\s+const\\s+|^)${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  if (!match) throw new Error(`Could not read ${label} array ${name}`);
  return [...match[1].matchAll(/[\"']([^\"']+)[\"']/g)].map((entry) => entry[1]);
}

function extractPythonTuple(source, name, label) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)^\\)`, 'm'));
  if (!match) throw new Error(`Could not read ${label} tuple ${name}`);
  return [...match[1].matchAll(/[\"']([^\"']+)[\"']/g)].map((entry) => entry[1]);
}

function yamlScalar(source, name, label) {
  const match = source.match(new RegExp(`^${name}:\\s*([^#\\r\\n]+)`, 'm'));
  if (!match) throw new Error(`Could not read ${label} field ${name}`);
  return match[1].trim().replace(/^[\"']|[\"']$/g, '');
}

function testedMinorRange(version) {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid tested Hermes version: ${version ?? 'missing'}`);
  return `>=${version} <${match[1]}.${Number.parseInt(match[2], 10) + 1}.0`;
}

function findAdapter(manifest, id) {
  const adapter = manifest.adapters?.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`Hermes manifest is missing adapter ${id}`);
  return adapter;
}

function componentCopies(component, label) {
  const targetRoot = safeBundlePath(component.target, `${label}.target`);
  if (!Array.isArray(component.files) || component.files.length === 0) {
    throw new Error(`${label}.files must be a non-empty explicit allowlist`);
  }
  return component.files.map((file, index) => {
    const source = safeBundlePath(file.source, `${label}.files[${index}].source`);
    const target = safeBundlePath(file.target, `${label}.files[${index}].target`);
    return { source, target: `${targetRoot}/${target}` };
  });
}

async function validateManifest(manifest, packageJson) {
  if (manifest.schema !== 'deft.hermes.integration.v2') {
    throw new Error(`Unsupported Hermes manifest schema: ${manifest.schema ?? 'missing'}`);
  }
  if (manifest.deft_release !== packageJson.version) {
    throw new Error(`Hermes manifest targets ${manifest.deft_release}, but package.json is ${packageJson.version}`);
  }
  if (manifest.deft_release_compatibility !== `=${manifest.deft_release}`) {
    throw new Error('Hermes Deft compatibility must exactly match the bundled release');
  }
  if (!Array.isArray(manifest.adapters) || manifest.adapters.filter((adapter) => adapter.role === 'default').length !== 1) {
    throw new Error('Hermes manifest must declare exactly one default adapter');
  }
  if (!Array.isArray(manifest.common_plugins)) {
    throw new Error('Hermes manifest must declare its common plugins');
  }

  const native = findAdapter(manifest, 'native');
  const legacy = findAdapter(manifest, 'legacy');
  assertEqual(manifest.adapters.map((adapter) => adapter.id), ['native', 'legacy'], 'Hermes adapters');
  if (manifest.default_adapter !== native.id || native.role !== 'default' || native.kind !== 'native_platform') {
    throw new Error('deft-platform must be the native default adapter');
  }
  if (
    native.name !== 'deft-platform'
    || native.version !== '0.2.0'
    || native.mcp_transport !== 'direct_http'
    || native.target !== 'plugins/deft-platform'
  ) {
    throw new Error('Native adapter must be deft-platform 0.2.0 with direct HTTP MCP');
  }
  if (
    legacy.role !== 'fallback'
    || legacy.kind !== 'legacy_bridge'
    || legacy.version !== '0.3.0'
    || legacy.mcp_transport !== 'stdio_shim'
  ) {
    throw new Error('Legacy bridge 0.3.0 must be an explicit fallback');
  }
  if (safeBundlePath(legacy.target, 'legacy.target') !== 'legacy/bridge') {
    throw new Error('Legacy bridge assets must be isolated under legacy/bridge');
  }
  if (manifest.mcp?.default_transport !== 'direct_http' || manifest.mcp?.endpoint_path !== '/api/mcp/v1') {
    throw new Error('The root Hermes configuration must default to direct HTTP MCP');
  }
  if (manifest.hermes_compatibility !== testedMinorRange(manifest.hermes_tested?.version)) {
    throw new Error('Hermes compatibility must be limited to the tested runtime minor line');
  }
  if (
    manifest.hermes_tested?.distribution !== 'hermes-agent'
    || manifest.hermes_tested?.repository !== 'https://github.com/NousResearch/hermes-agent.git'
    || !/^refs\/tags\/v\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/.test(manifest.hermes_tested?.ref ?? '')
    || !/^[0-9a-f]{40}$/.test(manifest.hermes_tested?.commit ?? '')
  ) {
    throw new Error('Hermes tested runtime must identify a pinned upstream tag and commit');
  }
  assertEqual(
    Object.keys(manifest.hermes_tested?.provenance ?? {}),
    ['runtime_audit', 'native_adapter_suite'],
    'Hermes compatibility provenance',
  );
  assertEqual(
    manifest.common_plugins.map((plugin) => ({ name: plugin.name, target: plugin.target })),
    [
      { name: 'deft-employee', target: 'plugins/deft-employee' },
      { name: 'deft-memory', target: 'plugins/deft-memory' },
    ],
    'Hermes common plugins',
  );

  const [apiContract, apiOnboarding, nativeAdapter, nativeReadiness, legacyBridge] = await Promise.all([
    readFile(apiContractPath, 'utf8'),
    readFile(apiOnboardingPath, 'utf8'),
    readFile(nativeAdapterPath, 'utf8'),
    readFile(nativeReadinessPath, 'utf8'),
    readFile(legacyBridgePath, 'utf8'),
  ]);
  assertEqual(
    extractQuotedConstant(apiOnboarding, 'HERMES_INTEGRATION_VERSION', 'API Hermes onboarding'),
    manifest.integration_version,
    'Hermes integration version',
  );
  const runtimeAuditPath = safeBundlePath(
    manifest.hermes_tested.provenance.runtime_audit,
    'hermes_tested.provenance.runtime_audit',
  );
  const nativeSuitePath = safeBundlePath(
    manifest.hermes_tested.provenance.native_adapter_suite,
    'hermes_tested.provenance.native_adapter_suite',
  );
  const [runtimeAudit, nativeSuite] = await Promise.all([
    readFile(join(repoRoot, runtimeAuditPath), 'utf8'),
    readFile(join(repoRoot, nativeSuitePath), 'utf8'),
  ]);
  const expectedRuntimeProvenance = [
    `distribution: ${manifest.hermes_tested.distribution}`,
    `version: ${manifest.hermes_tested.version}`,
    `repository: ${manifest.hermes_tested.repository}`,
    `ref: ${manifest.hermes_tested.ref}`,
    `commit: ${manifest.hermes_tested.commit}`,
  ];
  if (!expectedRuntimeProvenance.every((line) => runtimeAudit.includes(line))) {
    throw new Error('Hermes runtime provenance does not match the manifest pin');
  }
  if (!nativeSuite.includes('PLUGIN_DIR / "adapter.py"')) {
    throw new Error('Hermes native adapter suite provenance is not linked to adapter.py');
  }
  const apiProtocol = extractQuotedConstant(apiContract, 'AGENT_CHANNEL_PROTOCOL_VERSION', 'API Agent Channel');
  const apiCapabilities = extractQuotedArray(apiContract, 'AGENT_CHANNEL_CAPABILITIES', 'API Agent Channel');
  const apiNativeCapabilities = extractQuotedArray(
    apiContract,
    'AGENT_CHANNEL_AUTONOMOUS_REQUIRED_RUNTIME_CAPABILITIES',
    'API Agent Channel',
  );
  const apiLegacyCapabilities = extractQuotedArray(
    apiContract,
    'AGENT_CHANNEL_REQUIRED_RUNTIME_CAPABILITIES',
    'API Agent Channel',
  );
  assertEqual(manifest.agent_channel_protocols, [apiProtocol], 'Agent Channel protocols');
  assertEqual(manifest.required_channel_capabilities, apiCapabilities, 'Agent Channel capabilities');

  const nativeVersion = extractQuotedConstant(nativeAdapter, 'ADAPTER_VERSION', 'native adapter');
  const nativeProtocol = extractQuotedConstant(nativeAdapter, 'PROTOCOL_VERSION', 'native adapter');
  const nativeCapabilities = extractPythonTuple(nativeAdapter, 'CAPABILITIES', 'native adapter');
  assertEqual(native.version, nativeVersion, 'Native adapter version');
  assertEqual(native.protocol, nativeProtocol, 'Native adapter protocol');
  assertEqual(native.runtime_capabilities, nativeCapabilities, 'Native adapter capabilities');
  assertEqual(native.runtime_capabilities, apiNativeCapabilities, 'Native/API capabilities');
  assertEqual(
    extractQuotedConstant(nativeReadiness, 'ADAPTER_VERSION', 'native readiness'),
    nativeVersion,
    'Native readiness version',
  );
  assertEqual(
    extractQuotedConstant(nativeReadiness, 'PROTOCOL_VERSION', 'native readiness'),
    nativeProtocol,
    'Native readiness protocol',
  );
  assertEqual(
    extractQuotedConstant(nativeReadiness, 'CAPABILITY', 'native readiness').split(','),
    nativeCapabilities,
    'Native readiness capabilities',
  );

  const legacyVersion = extractQuotedConstant(legacyBridge, 'HERMES_DEFT_ADAPTER_VERSION', 'legacy bridge');
  const legacyProtocol = extractQuotedConstant(legacyBridge, 'AGENT_CHANNEL_PROTOCOL_VERSION', 'legacy bridge');
  const legacyCapabilities = extractQuotedArray(legacyBridge, 'AGENT_CHANNEL_CAPABILITIES', 'legacy bridge');
  assertEqual(legacy.version, legacyVersion, 'Legacy bridge version');
  assertEqual(legacy.protocol, legacyProtocol, 'Legacy bridge protocol');
  assertEqual(legacy.runtime_capabilities, legacyCapabilities, 'Legacy bridge capabilities');
  const missingLegacyCapabilities = apiLegacyCapabilities.filter(
    (capability) => !legacy.runtime_capabilities.includes(capability),
  );
  if (missingLegacyCapabilities.length > 0) {
    throw new Error(`Legacy bridge is missing API-required capabilities: ${missingLegacyCapabilities.join(', ')}`);
  }

  for (const plugin of manifest.common_plugins ?? []) {
    const pluginYamlFile = plugin.files?.find((file) => file.target === 'plugin.yaml');
    if (!pluginYamlFile) throw new Error(`Common plugin ${plugin.name} must allowlist plugin.yaml`);
    const pluginYaml = await readFile(join(repoRoot, pluginYamlFile.source), 'utf8');
    assertEqual(yamlScalar(pluginYaml, 'name', plugin.name), plugin.name, `${plugin.name} plugin name`);
    assertEqual(yamlScalar(pluginYaml, 'version', plugin.name), plugin.version, `${plugin.name} plugin version`);
  }

  const nativePluginYamlFile = native.files?.find((file) => file.target === 'plugin.yaml');
  if (!nativePluginYamlFile) throw new Error('Native adapter must allowlist plugin.yaml');
  const nativePluginYaml = await readFile(join(repoRoot, nativePluginYamlFile.source), 'utf8');
  assertEqual(yamlScalar(nativePluginYaml, 'name', native.name), native.name, 'Native plugin name');
  assertEqual(yamlScalar(nativePluginYaml, 'version', native.name), native.version, 'Native plugin version');
}

function nativeReadme(manifest) {
  const native = findAdapter(manifest, 'native');
  const legacy = findAdapter(manifest, 'legacy');
  return `# Deft Hermes integration ${manifest.integration_version}\n\n` +
    `This immutable bundle targets Deft ${manifest.deft_release}, Agent Channel ${native.protocol}, and Hermes ${manifest.hermes_compatibility}.\n\n` +
    `The default adapter is the native ${native.name} ${native.version} plugin. Install the three directories under plugins/ into the active Hermes profile, start from config.example.yaml, and run plugins/deft-platform/readiness.py before enabling delivery. The default configuration connects Hermes directly to Deft MCP over HTTP; it needs no Deft source checkout, stdio shim, or sidecar bridge.\n\n` +
    'Hermes remains responsible for models, reasoning, skills, browser and research tools, external MCP servers, private memory, and process supervision. Deft remains authoritative for employee identity, tenant policy, approvals, receipts, shared Knowledge, tasks, conversations, and durable writes.\n\n' +
    `The ${legacy.name} ${legacy.version} assets under legacy/bridge are fallback-only for the bounded rollback window. Never run the native adapter and legacy bridge for the same employee at the same time. Rollback requires stopping and disabling the native plugin, revoking its credentials, and issuing fresh employee credentials for the bridge.\n\n` +
    `manifest.json contains sorted SHA-256 checksums for every bundled content file. Its content_digest hashes each sorted \`path\\0sha256\\n\` record using ${CONTENT_DIGEST_CANONICALIZATION}. The manifest itself is excluded from that digest.\n`;
}

function nativeConfig() {
  return `# Native-first Deft employee profile. Replace placeholders without committing credentials.\n` +
    `plugins:\n` +
    `  enabled:\n` +
    `    - deft-platform\n` +
    `    - deft-employee\n` +
    `    - deft-memory\n\n` +
    `platforms:\n` +
    `  deft:\n` +
    `    enabled: true\n` +
    `    home_channel:\n` +
    `      platform: deft\n` +
    `      chat_id: <organization-id>:<space-id>\n` +
    `      name: Deft home\n` +
    `    extra:\n` +
    `      channel_url: https://deft.example/api/agent-channel/v1\n` +
    `      token: <employee-agent-channel-token>\n` +
    `      employee_slug: <employee-slug>\n\n` +
    `mcp_servers:\n` +
    `  deft:\n` +
    `    url: https://deft.example/api/mcp/v1\n` +
    `    headers:\n` +
    `      Authorization: Bearer <employee-mcp-token>\n` +
    `    enabled: true\n\n` +
    `memory:\n` +
    `  provider: deft-memory\n\n` +
    `display:\n` +
    `  busy_input_mode: queue\n` +
    `  busy_ack_enabled: false\n`;
}

function legacyReadme(manifest) {
  const legacy = findAdapter(manifest, 'legacy');
  return `# Legacy Deft bridge fallback ${legacy.version}\n\n` +
    `These files are an explicit rollback path for Deft ${manifest.deft_release}; they are not the default installation. Do not run this bridge while deft-platform is active for the same employee.\n\n` +
    'Before rollback, stop and disable the native plugin, revoke both native employee credentials, wait for any native lease to expire, and issue fresh Agent Channel and MCP credentials. The bridge and its Windows service scripts are colocated here so their relative-path contract remains intact. deft-mcp-stdio.mjs is provided only for a legacy Hermes MCP configuration.\n\n' +
    'Create a locally protected service.env beside these files with the matched replacement credentials:\n\n' +
    '```dotenv\n' +
    'DEFT_CHANNEL_URL=https://deft.example/api/agent-channel/v1\n' +
    'DEFT_CHANNEL_TOKEN=<replacement-agent-channel-token>\n' +
    'DEFT_EMPLOYEE_SLUG=<employee-slug>\n' +
    'DEFT_MCP_URL=https://deft.example/api/mcp/v1\n' +
    'DEFT_MCP_TOKEN=<replacement-mcp-token>\n' +
    'HERMES_API_URL=http://127.0.0.1:8642\n' +
    'HERMES_API_KEY=<hermes-api-key>\n' +
    'HERMES_API_MODEL=hermes-agent\n' +
    '```\n\n' +
    'Start the authenticated Hermes gateway, then run hermes-agent-channel-bridge.mjs directly or install the Windows wrapper with hermes-channel-service.ps1.\n';
}

async function bundledFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle output contains a symlink: ${path}`);
    if (entry.isDirectory()) paths.push(...await bundledFiles(path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Bundle output contains a non-file entry: ${path}`);
  }
  return paths;
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
await validateManifest(manifest, packageJson);
const realRepoRoot = await realpath(repoRoot);

const copies = [
  ...manifest.adapters.flatMap((adapter) => componentCopies(adapter, `adapter.${adapter.id}`)),
  ...manifest.common_plugins.flatMap((plugin) => componentCopies(plugin, `plugin.${plugin.name}`)),
];
const generatedFiles = (manifest.generated_files ?? []).map((path, index) =>
  safeBundlePath(path, `generated_files[${index}]`));
const targetPaths = [...copies.map((copy) => copy.target), ...generatedFiles];
if (new Set(targetPaths).size !== targetPaths.length) {
  throw new Error('Hermes manifest contains duplicate output paths');
}

for (const copy of copies) {
  const sourcePath = join(repoRoot, copy.source);
  const relativeSource = relative(repoRoot, sourcePath);
  if (!relativeSource || relativeSource.startsWith('..') || isAbsolute(relativeSource)) {
    throw new Error(`Refusing to read bundle source outside the repository: ${copy.source}`);
  }
  await rejectLinkedPath(repoRoot, sourcePath, `Bundle source ${copy.source}`);
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Bundle allowlist source must be a regular file: ${copy.source}`);
  }
  const realSourcePath = await realpath(sourcePath);
  const relativeRealSource = relative(realRepoRoot, realSourcePath);
  if (!relativeRealSource || relativeRealSource.startsWith('..') || isAbsolute(relativeRealSource)) {
    throw new Error(`Bundle source resolves outside the repository: ${copy.source}`);
  }
}

const relativeOutput = relative(repoRoot, outputRoot);
if (!relativeOutput || relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
  throw new Error(`Refusing to replace unsafe bundle output path: ${outputRoot}`);
}
await rejectLinkedPath(repoRoot, outputRoot, 'Bundle output path');
await rejectLinkedTree(outputRoot);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const copy of copies) {
  const destination = join(outputRoot, copy.target);
  await mkdir(dirname(destination), { recursive: true });
  const bytes = await readFile(join(repoRoot, copy.source));
  await writeFile(destination, normalizedSourceText(bytes, copy.source), 'utf8');
}

const generatedContent = new Map([
  ['README.md', nativeReadme(manifest)],
  ['config.example.yaml', nativeConfig()],
  ['legacy/bridge/README.md', legacyReadme(manifest)],
]);
assertEqual(sorted(generatedContent.keys()), sorted(generatedFiles), 'Generated bundle files');
for (const [target, content] of generatedContent) {
  const destination = join(outputRoot, target);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, 'utf8');
}

const actualContentPaths = (await bundledFiles(outputRoot)).map((path) =>
  relative(outputRoot, path).replaceAll('\\', '/'));
assertEqual(actualContentPaths, sorted(targetPaths), 'Bundle output allowlist');

const checksums = {};
for (const target of actualContentPaths) {
  const bytes = await readFile(join(outputRoot, target));
  checksums[target] = createHash('sha256').update(bytes).digest('hex');
}
const canonicalContent = Object.entries(checksums)
  .map(([target, digest]) => `${target}\0${digest}\n`)
  .join('');
const contentDigest = createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
await writeFile(
  join(outputRoot, 'manifest.json'),
  `${JSON.stringify({
    ...manifest,
    checksums,
    content_digest: {
      algorithm: 'sha256',
      canonicalization: CONTENT_DIGEST_CANONICALIZATION,
      value: contentDigest,
    },
  }, null, 2)}\n`,
  'utf8',
);

console.log(
  `Built Deft Hermes integration ${manifest.integration_version} for ${manifest.deft_release} ` +
  `with content sha256:${contentDigest} at ${outputRoot}`,
);
