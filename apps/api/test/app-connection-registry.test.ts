import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppConnectionRegistry } from '../src/lib/app-connection-registry.js';

test('a pinned adapter receives only generic authority ports; obsolete native configuration fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deft-app-registry-'));
  const modulePath = join(directory, 'adapter.mjs'), configPath = join(directory, 'registry.json');
  t.after(async () => { await unlink(modulePath); await unlink(configPath); await rmdir(directory); });
  const source = `export async function createAppConnectionAdapter({ host }) {
    const keys = Object.keys(host).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['assertCurrent', 'resolveContext'])) throw Error('Unexpected host authority');
    return { handle: async () => Response.json({ state: 'connected', account: { account_ref: 'external-project-7' } }) };
  }`;
  await writeFile(modulePath, source, { mode: 0o600 });
  const pins = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), target_key: 'project', resource_key: 'records', resource_binding_id: randomUUID(),
    action_key: null, action_binding_id: null };
  const entry = { pins, module_path: modulePath, module_sha256: createHash('sha256').update(source).digest('hex'), options: {} };
  const config = { schema_version: 'deft.app_connection_adapters.v1', entries: [entry] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const registry = await loadAppConnectionRegistry(configPath);
  assert.equal(registry.select({ org_id: pins.org_id, owner_user_id: pins.owner_user_id,
    installation_id: pins.installation_id, target_key: pins.target_key }).module_sha256, entry.module_sha256);
  await writeFile(configPath, JSON.stringify({ ...config, entries: [{ ...entry, compatible_from: {
    module_sha256: entry.module_sha256, credential_policy_sha256: 'a'.repeat(64), revision: 2 } }] }));
  await assert.rejects(loadAppConnectionRegistry(configPath), /not configured/);
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(modulePath, source + '\n// different bytes');
  await assert.rejects(loadAppConnectionRegistry(configPath), /not configured/);
});
