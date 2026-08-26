import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from 'node:path';

export const CONTENT_DIGEST_CANONICALIZATION = 'deft.bundle.sorted-path-nul-sha256-lf.v1';
export const BUNDLE_EVIDENCE_SCHEMA = 'deft.hermes.integration.bundle_evidence.v1';

const FORBIDDEN_BUNDLE_PATH = /(^|\/)(?:__pycache__|state|secrets?)(?:\/|$)|\.(?:pyc|pyo)$/i;

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
  if (segments.some((segment) => (
    /[\u0000-\u001f<>:"|?*]/.test(segment)
    || /[ .]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
  ))) {
    throw new Error(`${label} is not portable across supported filesystems: ${value}`);
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

async function rejectLinkedPathWithin(base, target, label) {
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

async function readTrustedRepositoryFile(repoRoot, target, label) {
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteTarget = resolve(target);
  const relativeTarget = relative(absoluteRepoRoot, absoluteTarget);
  if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error(`${label} is outside the repository: ${absoluteTarget}`);
  }
  await rejectLinkedPathWithin(absoluteRepoRoot, absoluteTarget, label);
  const stat = await lstat(absoluteTarget);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error(`${label} must be an unlinked regular file: ${absoluteTarget}`);
  }
  const [realRepoRoot, realTarget] = await Promise.all([
    realpath(absoluteRepoRoot),
    realpath(absoluteTarget),
  ]);
  const relativeRealTarget = relative(realRepoRoot, realTarget);
  if (!relativeRealTarget || relativeRealTarget.startsWith('..') || isAbsolute(relativeRealTarget)) {
    throw new Error(`${label} resolves outside the repository: ${absoluteTarget}`);
  }
  return readFile(absoluteTarget);
}

async function rejectLinkedAncestors(target, label) {
  const absoluteTarget = resolve(target);
  const root = parse(absoluteTarget).root;
  let current = root;
  const relativeTarget = relative(root, absoluteTarget);
  for (const segment of relativeTarget.split(/[\\/]/).filter(Boolean)) {
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

async function rejectLinkedTree(directory, label = 'Bundle output') {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link or junction: ${directory}`);
  }
  if (!directoryStat.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction: ${path}`);
    if (entry.isDirectory()) await rejectLinkedTree(path, label);
    else if (entry.isFile()) {
      const stat = await lstat(path);
      if (stat.nlink > 1) throw new Error(`${label} contains a hard-linked file: ${path}`);
    } else {
      throw new Error(`${label} contains a non-file entry: ${path}`);
    }
  }
  return true;
}

function assertSafeDirectory(repoRoot, directory) {
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteDirectory = resolve(directory);
  const filesystemRoot = parse(absoluteDirectory).root;
  if (
    absoluteDirectory === filesystemRoot
    || absoluteDirectory === absoluteRepoRoot
    || absoluteDirectory === resolve(homedir())
  ) {
    throw new Error(`Refusing unsafe bundle directory: ${absoluteDirectory}`);
  }

  const relativeToRepo = relative(absoluteRepoRoot, absoluteDirectory);
  const insideRepo = relativeToRepo && !relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo);
  if (insideRepo) {
    const normalized = relativeToRepo.replaceAll('\\', '/');
    if (normalized !== 'dist' && !normalized.startsWith('dist/')) {
      throw new Error(`Bundle directory inside the repository must be under dist/: ${absoluteDirectory}`);
    }
    if (normalized === 'dist') {
      throw new Error(`Refusing to use the broad dist directory as a bundle target: ${absoluteDirectory}`);
    }
  }
  return absoluteDirectory;
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

function repositoryPaths(repoRoot) {
  return {
    manifest: join(repoRoot, 'integrations', 'hermes', 'integration-manifest.json'),
    package: join(repoRoot, 'package.json'),
    apiContract: join(repoRoot, 'apps', 'api', 'src', 'lib', 'agent-channel.ts'),
    apiOnboarding: join(repoRoot, 'apps', 'api', 'src', 'routes', 'agent-employees.ts'),
    nativeAdapter: join(repoRoot, 'integrations', 'hermes', 'deft-platform', 'adapter.py'),
    nativeReadiness: join(repoRoot, 'integrations', 'hermes', 'deft-platform', 'readiness.py'),
    legacyBridge: join(repoRoot, 'scripts', 'hermes-agent-channel-bridge.mjs'),
  };
}

async function validateManifest(repoRoot, manifest, packageJson) {
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

  const paths = repositoryPaths(repoRoot);
  const [apiContract, apiOnboarding, nativeAdapter, nativeReadiness, legacyBridge] = await Promise.all([
    readTrustedRepositoryFile(repoRoot, paths.apiContract, 'API Agent Channel contract').then(String),
    readTrustedRepositoryFile(repoRoot, paths.apiOnboarding, 'API Hermes onboarding').then(String),
    readTrustedRepositoryFile(repoRoot, paths.nativeAdapter, 'Native Hermes adapter').then(String),
    readTrustedRepositoryFile(repoRoot, paths.nativeReadiness, 'Native Hermes readiness probe').then(String),
    readTrustedRepositoryFile(repoRoot, paths.legacyBridge, 'Legacy Hermes bridge').then(String),
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
    readTrustedRepositoryFile(repoRoot, join(repoRoot, runtimeAuditPath), 'Hermes runtime audit').then(String),
    readTrustedRepositoryFile(repoRoot, join(repoRoot, nativeSuitePath), 'Hermes native adapter suite').then(String),
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

  for (const plugin of manifest.common_plugins) {
    const pluginYamlFile = plugin.files?.find((file) => file.target === 'plugin.yaml');
    if (!pluginYamlFile) throw new Error(`Common plugin ${plugin.name} must allowlist plugin.yaml`);
    const pluginYamlSource = safeBundlePath(pluginYamlFile.source, `${plugin.name} plugin.yaml source`);
    const pluginYaml = String(await readTrustedRepositoryFile(
      repoRoot,
      join(repoRoot, pluginYamlSource),
      `${plugin.name} plugin.yaml`,
    ));
    assertEqual(yamlScalar(pluginYaml, 'name', plugin.name), plugin.name, `${plugin.name} plugin name`);
    assertEqual(yamlScalar(pluginYaml, 'version', plugin.name), plugin.version, `${plugin.name} plugin version`);
  }

  const nativePluginYamlFile = native.files?.find((file) => file.target === 'plugin.yaml');
  if (!nativePluginYamlFile) throw new Error('Native adapter must allowlist plugin.yaml');
  const nativePluginYamlSource = safeBundlePath(nativePluginYamlFile.source, 'Native plugin.yaml source');
  const nativePluginYaml = String(await readTrustedRepositoryFile(
    repoRoot,
    join(repoRoot, nativePluginYamlSource),
    'Native plugin.yaml',
  ));
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

function generatedContent(manifest) {
  return new Map([
    ['README.md', nativeReadme(manifest)],
    ['config.example.yaml', nativeConfig()],
    ['legacy/bridge/README.md', legacyReadme(manifest)],
  ]);
}

function bundlePlan(manifest) {
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
  const portableTargetPaths = targetPaths.map((target) => target.normalize('NFC').toLowerCase());
  if (new Set(portableTargetPaths).size !== portableTargetPaths.length) {
    throw new Error('Hermes manifest contains output paths that collide on a case-insensitive filesystem');
  }
  const generated = generatedContent(manifest);
  assertEqual(sorted(generated.keys()), sorted(generatedFiles), 'Generated bundle files');
  return { copies, generated, targetPaths: sorted(targetPaths) };
}

async function loadSourceContract(repoRoot) {
  const paths = repositoryPaths(repoRoot);
  const [manifestBytes, packageBytes] = await Promise.all([
    readTrustedRepositoryFile(repoRoot, paths.manifest, 'Hermes integration source manifest'),
    readTrustedRepositoryFile(repoRoot, paths.package, 'Deft package manifest'),
  ]);
  const manifest = JSON.parse(String(manifestBytes));
  const packageJson = JSON.parse(String(packageBytes));
  await validateManifest(repoRoot, manifest, packageJson);
  return { manifest, packageJson, plan: bundlePlan(manifest) };
}

async function expectedContent(repoRoot, manifest, plan) {
  const expected = new Map();
  for (const copy of plan.copies) {
    const sourcePath = join(repoRoot, copy.source);
    const sourceBytes = await readTrustedRepositoryFile(repoRoot, sourcePath, `Bundle source ${copy.source}`);
    expected.set(
      copy.target,
      Buffer.from(normalizedSourceText(sourceBytes, copy.source), 'utf8'),
    );
  }
  for (const [target, content] of plan.generated) {
    expected.set(target, Buffer.from(content.replace(/\r\n?/g, '\n'), 'utf8'));
  }
  assertEqual(sorted(expected.keys()), plan.targetPaths, 'Expected bundle files');
  return expected;
}

async function bundleFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle contains a symlink or junction: ${path}`);
    if (entry.isDirectory()) files.push(...await bundleFiles(path, root));
    else if (entry.isFile()) {
      const stat = await lstat(path);
      if (stat.nlink > 1) throw new Error(`Bundle contains a hard-linked file: ${path}`);
      files.push(safeBundlePath(relative(root, path).replaceAll('\\', '/'), 'Bundle file'));
    } else {
      throw new Error(`Bundle contains a non-file entry: ${path}`);
    }
  }
  return files;
}

function canonicalContentDigest(checksums) {
  const canonical = Object.entries(checksums)
    .map(([target, digest]) => `${target}\0${digest}\n`)
    .join('');
  return sha256(Buffer.from(canonical, 'utf8'));
}

export async function verifyHermesIntegrationBundle({ repoRoot, directory }) {
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteDirectory = assertSafeDirectory(absoluteRepoRoot, directory);
  await rejectLinkedAncestors(absoluteDirectory, 'Bundle directory');
  const exists = await rejectLinkedTree(absoluteDirectory, 'Bundle');
  if (!exists) throw new Error(`Bundle directory does not exist: ${absoluteDirectory}`);

  const { manifest: sourceManifest, plan } = await loadSourceContract(absoluteRepoRoot);
  const expected = await expectedContent(absoluteRepoRoot, sourceManifest, plan);
  const actualPaths = await bundleFiles(absoluteDirectory);
  assertEqual(actualPaths, [...plan.targetPaths, 'manifest.json'].sort(), 'Bundle files');

  const manifestPath = join(absoluteDirectory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.includes(13)) throw new Error('Bundle manifest must use canonical LF line endings');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Bundle manifest is not valid JSON: ${error.message}`);
  }

  const { checksums, content_digest: contentDigest, ...baseManifest } = manifest;
  assertEqual(baseManifest, sourceManifest, 'Bundle/source manifest');
  if (!checksums || Array.isArray(checksums) || typeof checksums !== 'object') {
    throw new Error('Bundle manifest checksums must be an object');
  }
  const checksumPaths = Object.keys(checksums);
  assertEqual(checksumPaths, plan.targetPaths, 'Sorted bundle checksum paths');

  const verifiedChecksums = {};
  for (const target of plan.targetPaths) {
    safeBundlePath(target, 'Bundle checksum path');
    const actualBytes = await readFile(join(absoluteDirectory, target));
    const expectedBytes = expected.get(target);
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(`Bundle file does not match its source: ${target}`);
    }
    const digest = sha256(actualBytes);
    if (!/^[0-9a-f]{64}$/.test(checksums[target] ?? '') || checksums[target] !== digest) {
      throw new Error(`Bundle checksum mismatch: ${target}`);
    }
    verifiedChecksums[target] = digest;
  }

  const contentSha256 = canonicalContentDigest(verifiedChecksums);
  assertEqual(contentDigest, {
    algorithm: 'sha256',
    canonicalization: CONTENT_DIGEST_CANONICALIZATION,
    value: contentSha256,
  }, 'Bundle content digest');

  const canonicalManifestBytes = Buffer.from(`${JSON.stringify({
    ...sourceManifest,
    checksums: verifiedChecksums,
    content_digest: contentDigest,
  }, null, 2)}\n`, 'utf8');
  if (!manifestBytes.equals(canonicalManifestBytes)) {
    throw new Error('Bundle manifest bytes are not canonical');
  }

  return {
    schema: BUNDLE_EVIDENCE_SCHEMA,
    manifest_sha256: `sha256:${sha256(manifestBytes)}`,
    content_sha256: `sha256:${contentSha256}`,
    manifest,
  };
}

export async function buildHermesIntegrationBundle({ repoRoot, directory, replaceExisting = false }) {
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteDirectory = assertSafeDirectory(absoluteRepoRoot, directory);
  const defaultDirectory = join(absoluteRepoRoot, 'dist', 'hermes-integration');
  if (replaceExisting && absoluteDirectory !== defaultDirectory) {
    throw new Error(`Only the default bundle directory may be replaced: ${absoluteDirectory}`);
  }
  const { manifest, plan } = await loadSourceContract(absoluteRepoRoot);
  const expected = await expectedContent(absoluteRepoRoot, manifest, plan);

  await rejectLinkedAncestors(absoluteDirectory, 'Bundle output path');
  const exists = await rejectLinkedTree(absoluteDirectory);
  if (exists) {
    if (replaceExisting) {
      await rm(absoluteDirectory, { recursive: true, force: true });
    } else if ((await readdir(absoluteDirectory)).length > 0) {
      throw new Error(`Explicit bundle output directory must be new or empty: ${absoluteDirectory}`);
    }
  }

  await mkdir(absoluteDirectory, { recursive: true });
  for (const [target, bytes] of expected) {
    const destination = join(absoluteDirectory, target);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }

  const checksums = {};
  for (const target of plan.targetPaths) checksums[target] = sha256(expected.get(target));
  const contentSha256 = canonicalContentDigest(checksums);
  await writeFile(
    join(absoluteDirectory, 'manifest.json'),
    `${JSON.stringify({
      ...manifest,
      checksums,
      content_digest: {
        algorithm: 'sha256',
        canonicalization: CONTENT_DIGEST_CANONICALIZATION,
        value: contentSha256,
      },
    }, null, 2)}\n`,
    'utf8',
  );

  return verifyHermesIntegrationBundle({ repoRoot: absoluteRepoRoot, directory: absoluteDirectory });
}

export function parseBundleCliArguments(argv, { allowJson = false } = {}) {
  let directory;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (!allowJson) throw new Error('--json is only supported by the verifier');
      if (json) throw new Error('--json may be specified only once');
      json = true;
      continue;
    }
    if (argument === '--directory') {
      if (directory !== undefined) throw new Error('Bundle directory may be specified only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--directory requires a path');
      directory = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--directory=')) {
      if (directory !== undefined) throw new Error('Bundle directory may be specified only once');
      directory = argument.slice('--directory='.length);
      if (!directory) throw new Error('--directory requires a path');
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    if (directory !== undefined) throw new Error('Bundle directory may be specified only once');
    directory = argument;
  }
  return { directory, json };
}
