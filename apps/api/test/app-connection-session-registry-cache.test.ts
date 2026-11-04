import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAuthorityRegistryScope, getScopedAppConnectionSessionRegistry } from '../src/lib/app-authority-registry-scope.js';
import { loadAppConnectionSessionRegistry, connectionProfileDigest } from '../src/lib/app-connection-session-registry.js';
import { AppError } from '../src/lib/app-errors.js';

// The cache path is a no-DB unit test: trusted successors are stubbed so the
// registry loader never opens a transaction, and the counter proves whether the
// upgrade-trust query path is reached at all.
let trustCalls = 0;
mock.module(new URL('../src/lib/app-upgrade-trust-registry.js', import.meta.url).href, {
  namedExports: { trustedUpgradeRegistryEntries: async () => { trustCalls++; return []; } },
});

function makeProfile() {
  return { schema_version: 'deft.app_connection_profile.v1' as const, key: 'mail', provider_id: 'google_mail',
    operator_user_id: randomUUID(), runtime_requirement_key: 'mail', resource_key: 'messages', action_keys: ['send_message'],
    authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime' as const, executable: false as const };
}
function makeEntry(token = 'a'.repeat(43)) {
  const profile = makeProfile();
  return { org_id: randomUUID(), installation_id: randomUUID(), runtime_registration_id: randomUUID(), runtime_epoch: 1, profile,
    endpoint: 'https://runtime.example.test/v1/connections', runtime_auth_token: 'b'.repeat(43),
    authority_token_sha256: 'sha256:' + createHash('sha256').update(token).digest('hex') };
}
function scopeFor(entry: ReturnType<typeof makeEntry>) {
  return { org_id: entry.org_id, owner_user_id: entry.profile.operator_user_id, installation_id: entry.installation_id,
    app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + '1'.repeat(64),
    grant_snapshot_digest: 'sha256:' + '2'.repeat(64), lifecycle_epoch: 1, grant_epoch: 1, target_key: 'personal',
    resource_key: 'messages', resource_binding_id: randomUUID(), runtime_registration_id: entry.runtime_registration_id,
    operator_user_id: entry.profile.operator_user_id, runtime_epoch: entry.runtime_epoch,
    profile_digest: connectionProfileDigest(entry.profile), consent_expires_at: new Date(Date.now() + 600000).toISOString() };
}
async function withConfigFile(entries: unknown[], work: (path: string, write: (entries: unknown[]) => Promise<void>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'deft-registry-cache-'));
  const path = join(dir, 'reviewed-http.json');
  // The registry refuses group/other-readable files on POSIX, so keep it 0600.
  const write = async (list: unknown[]) => {
    await writeFile(path, JSON.stringify({ schema_version: 'deft.app_connection_http_registrations.v1', entries: list }), { mode: 0o600 });
    await chmod(path, 0o600);
  };
  await write(entries);
  const previous = process.env.DEFT_APP_CONNECTION_HTTP_CONFIG;
  process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = path;
  try { await work(path, write); }
  finally {
    if (previous === undefined) delete process.env.DEFT_APP_CONNECTION_HTTP_CONFIG; else process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('one parsed registry per scope while the file identity is unchanged', async () => {
  const token = 'a'.repeat(43), entry = makeEntry(token);
  await withConfigFile([entry], async () => {
    await withAuthorityRegistryScope(async () => {
      const first = await getScopedAppConnectionSessionRegistry();
      const second = await getScopedAppConnectionSessionRegistry();
      assert.strictEqual(first, second, 'the second lookup reuses the parsed registry object instead of rereading the file');
      first.authenticate(scopeFor(entry), 'Bearer ' + token);
      second.authenticate(scopeFor(entry), 'Bearer ' + token);
    });
  });
});

test('a replaced registry file revokes the previously parsed entries on the next scoped lookup', async () => {
  const token = 'a'.repeat(43), entry = makeEntry(token);
  const newToken = 'c'.repeat(43);
  const replaced = { ...entry, authority_token_sha256: 'sha256:' + createHash('sha256').update(newToken).digest('hex') };
  await withConfigFile([entry], async (_path, write) => {
    await withAuthorityRegistryScope(async () => {
      const first = await getScopedAppConnectionSessionRegistry();
      first.authenticate(scopeFor(entry), 'Bearer ' + token);
      // A different entry count and a different token change both size and mtime,
      // so the stat identity must change and the memo must be dropped.
      await write([replaced, makeEntry('d'.repeat(43))]);
      const second = await getScopedAppConnectionSessionRegistry();
      assert.notStrictEqual(first, second, 'the replaced file is re-parsed');
      assert.throws(() => second.authenticate(scopeFor(entry), 'Bearer ' + token), 'the old token no longer authenticates');
      second.authenticate(scopeFor(entry), 'Bearer ' + newToken);
    });
  });
});

test('invalid registry file shapes still throw APP_CONNECTION_PROFILE_UNAVAILABLE', async () => {
  await assert.rejects(() => loadAppConnectionSessionRegistry('relative/not-absolute.json'), (error: unknown) => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'APP_CONNECTION_PROFILE_UNAVAILABLE'); return true;
  });
  await withConfigFile([makeEntry()], async (path) => {
    await writeFile(path, 'x'.repeat(131073));
    await assert.rejects(() => loadAppConnectionSessionRegistry(path), (error: unknown) => {
      assert.ok(error instanceof AppError); assert.equal(error.code, 'APP_CONNECTION_PROFILE_UNAVAILABLE'); return true;
    });
  });
});

test('a trustedSuccessors:false load never runs the upgrade-trust query', async () => {
  trustCalls = 0;
  await withConfigFile([makeEntry()], async (path) => {
    await loadAppConnectionSessionRegistry(path, undefined, { trustedSuccessors: false });
    assert.equal(trustCalls, 0, 'the static preauthentication path skips the upgrade-trust query');
    await loadAppConnectionSessionRegistry(path);
    assert.equal(trustCalls, 1, 'the full reviewed path reads trusted successors exactly once');
  });
});
