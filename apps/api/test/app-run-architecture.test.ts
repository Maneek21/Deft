import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

test('only the App Run secret boundary handles ciphertext and signing material', async () => {
  const allowed = new Set([
    'lib/app-run-keyrings.ts',
    'lib/app-run-secrets.ts',
    'lib/app-run-secret-repository.ts',
  ]);
  const forbidden = /\b(?:ciphertext_b64|nonce_b64|auth_tag_b64|receipt_signing)\b/g;
  const violations: string[] = [];

  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (allowed.has(sourcePath)) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(forbidden)) {
      violations.push(`${sourcePath}:${match.index ?? 0}:${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('the dormant foundation has no production execution consumer', async () => {
  const consumers: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath.startsWith('lib/app-run-') || sourcePath === 'lib/env.ts') continue;
    const source = await readFile(path, 'utf8');
    if (/\b(?:AppRunSecretService|DEFT_APP_RUNS_ENABLED|APP_RUNS_ENABLED)\b/.test(source)) {
      consumers.push(sourcePath);
    }
  }
  assert.deepEqual(consumers, []);
});

test('the governed engine stays unwired from production entrances', async () => {
  const protectedEntrances = [
    'lib/capability-service.ts',
    'lib/capability-providers/mcp.ts',
    'workers/index.ts',
  ];
  for (const sourcePath of protectedEntrances) {
    const source = await readFile(join(sourceRoot, sourcePath), 'utf8');
    assert.doesNotMatch(source, /\b(?:AppRunService|AppRunAttemptRunner|createAppRunAttemptJobHandler)\b/);
  }
});
