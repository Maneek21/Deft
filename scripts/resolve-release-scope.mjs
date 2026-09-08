#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'deft.release.scope.v1';
const SCOPES = new Set(['core', 'hermes-certified']);

function fail(message) {
  throw new Error(`[release-scope] ${message}`);
}

export async function readReleaseScope(path = 'release/release-scope.json') {
  const absolutePath = resolve(path);
  let document;
  try {
    document = JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    fail(`could not read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!document || Array.isArray(document) || typeof document !== 'object') {
    fail('decision must be a JSON object');
  }
  const keys = Object.keys(document).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['schema', 'scope'])) {
    fail('decision must contain exactly schema and scope');
  }
  if (document.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  if (!SCOPES.has(document.scope)) fail(`scope must be one of: ${[...SCOPES].join(', ')}`);
  return Object.freeze({ schema: document.schema, scope: document.scope });
}

async function main() {
  const path = process.env.RELEASE_SCOPE_PATH?.trim() || 'release/release-scope.json';
  const decision = await readReleaseScope(path);
  if (process.argv.includes('--github-output')) {
    const output = process.env.GITHUB_OUTPUT?.trim();
    if (!output) fail('GITHUB_OUTPUT is required with --github-output');
    await appendFile(output, `scope=${decision.scope}\n`, 'utf8');
  }
  console.log(JSON.stringify(decision));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
