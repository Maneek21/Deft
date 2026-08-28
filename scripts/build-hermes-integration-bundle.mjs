#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHermesIntegrationBundle,
  parseBundleCliArguments,
} from './lib/hermes-integration-bundle.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const parsed = parseBundleCliArguments(process.argv.slice(2));
  const directory = parsed.directory
    ? resolve(process.cwd(), parsed.directory)
    : join(repoRoot, 'dist', 'hermes-integration');
  const evidence = await buildHermesIntegrationBundle({
    repoRoot,
    directory,
    replaceExisting: parsed.directory === undefined,
  });
  console.log(
    `Built Deft Hermes integration ${evidence.manifest.integration_version} ` +
    `for ${evidence.manifest.deft_release} with content ${evidence.content_sha256} at ${directory}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
