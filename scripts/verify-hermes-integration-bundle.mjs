#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBundleCliArguments,
  verifyHermesIntegrationBundle,
} from './lib/hermes-integration-bundle.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const parsed = parseBundleCliArguments(process.argv.slice(2), { allowJson: true });
  const directory = parsed.directory
    ? resolve(process.cwd(), parsed.directory)
    : join(repoRoot, 'dist', 'hermes-integration');
  const evidence = await verifyHermesIntegrationBundle({ repoRoot, directory });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return;
  }
  console.log(
    `Verified Deft Hermes integration ${evidence.manifest.integration_version} ` +
    `for ${evidence.manifest.deft_release}: ` +
    `manifest ${evidence.manifest_sha256}, content ${evidence.content_sha256}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
