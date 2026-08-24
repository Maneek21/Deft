#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(repoRoot, 'dist', 'hermes-integration');
const manifestPath = join(repoRoot, 'integrations', 'hermes', 'integration-manifest.json');
const packagePath = join(repoRoot, 'package.json');
const files = [
  ['scripts/hermes-agent-channel-bridge.mjs', 'scripts/hermes-agent-channel-bridge.mjs'],
  ['scripts/hermes-channel-service.ps1', 'scripts/hermes-channel-service.ps1'],
  ['scripts/run-hermes-channel-service.ps1', 'scripts/run-hermes-channel-service.ps1'],
  ['integrations/hermes/deft-mcp-stdio.mjs', 'scripts/deft-mcp-stdio.mjs'],
  ['integrations/hermes/deft-employee', 'plugins/deft-employee'],
  ['integrations/hermes/deft-memory', 'plugins/deft-memory'],
];

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
if (manifest.deft_release !== packageJson.version) {
  throw new Error(`Hermes manifest targets ${manifest.deft_release}, but package.json is ${packageJson.version}`);
}

const relativeOutput = relative(repoRoot, outputRoot);
if (!relativeOutput || relativeOutput.startsWith('..') || relativeOutput.includes(':')) {
  throw new Error(`Refusing to replace unsafe bundle output path: ${outputRoot}`);
}
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const [source, target] of files) {
  const destination = join(outputRoot, target);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(repoRoot, source), destination, { recursive: true, force: true });
}

const readme = `# Deft Hermes integration ${manifest.integration_version}\n\n` +
  `This immutable boundary bundle is for Deft ${manifest.deft_release} and Agent Channel ${manifest.agent_channel_protocols.join(', ')}.\n\n` +
  `It requires Hermes ${manifest.hermes_compatibility}; that runtime floor provides idempotent Responses requests for safe long-run recovery.\n\n` +
  'It contains only Deft MCP, delivery, identity, and memory-sync adapters. Hermes remains responsible for reasoning, external tools, MCP servers, skills, browser/computer use, and model configuration.\n\n' +
  'Install the two bundled plugins in the active Hermes profile, configure the bundled stdio bridge, then run scripts/hermes-agent-channel-bridge.mjs beside the authenticated Hermes gateway. The bridge fails closed if the Deft server is incompatible.\n';
await writeFile(join(outputRoot, 'README.md'), readme, 'utf8');

const checksums = {};
async function bundledFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await bundledFiles(path));
    else paths.push(path);
  }
  return paths;
}
for (const path of await bundledFiles(outputRoot)) {
  const target = relative(outputRoot, path).replaceAll('\\', '/');
  if (target === 'manifest.json') continue;
  const bytes = await readFile(path);
  checksums[target] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(
  join(outputRoot, 'manifest.json'),
  `${JSON.stringify({ ...manifest, checksums }, null, 2)}\n`,
  'utf8',
);

console.log(`Built Deft Hermes integration ${manifest.integration_version} for ${manifest.deft_release} at ${outputRoot}`);
