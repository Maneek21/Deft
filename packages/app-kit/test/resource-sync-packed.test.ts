import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
function runPnpm(args: string[]) {
  assert.ok(process.env.npm_execpath, 'Run packed App Kit test through pnpm');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: repositoryRoot, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result;
}

test('packed experimental sync subpath resolves from an offline external consumer',
  { timeout: 180_000 }, async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'deft-sync-packed-'));
    assert.equal(temporaryRoot.startsWith(tmpdir()), true);
    try {
      const artifacts = resolve(temporaryRoot, 'artifacts');
      const consumer = resolve(temporaryRoot, 'consumer');
      await mkdir(artifacts, { recursive: true });
      await mkdir(consumer, { recursive: true });
      runPnpm(['--dir', packageRoot, 'pack', '--pack-destination', artifacts, '--json']);
      const archives = (await readdir(artifacts)).filter((entry) => entry.endsWith('.tgz'));
      assert.equal(archives.length, 1);
      await writeFile(resolve(consumer, 'package.json'), JSON.stringify({
        name: 'deft-sync-external-consumer', version: '1.0.0', private: true,
        type: 'module', dependencies: {
          '@deft/app-kit': `file:${resolve(artifacts, archives[0]!).replace(/\\/gu, '/')}`,
        },
      }), 'utf8');
      runPnpm(['--dir', consumer, 'install', '--ignore-workspace', '--offline']);
      const installed = await realpath(resolve(consumer, 'node_modules', '@deft', 'app-kit'));
      assert.equal(installed.startsWith(await realpath(consumer)), true);
      const metadata = JSON.parse(await readFile(resolve(installed, 'package.json'), 'utf8')) as {
        exports?: Record<string, unknown>;
      };
      assert.ok(metadata.exports?.['./experimental/resource-sync']);
      const script = resolve(consumer, 'smoke.mjs');
      await writeFile(script, `
import { parseSyncDescriptor, parseSyncPage, createResourceSyncClient,
  APP_RESOURCE_SYNC_CHANNEL_VERSION } from '@deft/app-kit/experimental/resource-sync';
import { parseDeftAppManifest } from '@deft/app-kit';
const descriptor = { schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
  runtime_requirement_key: 'mail', resource_type: 'email_message',
  requested_visibility: 'user_private', record_schema: { type: 'object',
    properties: { subject: { type: 'string', maxLength: 200 } },
    required: ['subject'], additionalProperties: false }, label_field: 'subject' };
const request = { schema_version: 'deft.app_sync_request.v1', cursor: null, max_items: 1 };
const page = { schema_version: 'deft.app_sync_page.v1', upserts: [
  { id: 'item-1', revision: 'r1', data: { subject: 'Hello' } }],
  tombstones: [], next_cursor: 'next', has_more: true };
if (parseSyncDescriptor(descriptor).key !== 'inbox'
  || parseSyncPage(descriptor, request, page).upserts.length !== 1
  || typeof createResourceSyncClient !== 'function'
  || typeof parseDeftAppManifest !== 'function'
  || APP_RESOURCE_SYNC_CHANNEL_VERSION !== 'deft.app_runtime_channel.v2') {
  throw new Error('Packed sync contract missing');
}
console.log('PACKED_SYNC_OK');
`, 'utf8');
      const run = spawnSync(process.execPath, [script], {
        cwd: consumer, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(run.status, 0,
        [run.error?.message, run.stdout, run.stderr].filter(Boolean).join('\n'));
      assert.match(run.stdout, /PACKED_SYNC_OK/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
