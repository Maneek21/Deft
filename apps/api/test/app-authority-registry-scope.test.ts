import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// The scope module is the only consumer of the registry loader in this test, so
// stubbing the loader lets us count constructions independently of file I/O and
// of the real registry's digest work.
let loads = 0;
let identity = { path: '/abs/reviewed-http.json', dev: 1, ino: 2, size: 100, mtimeMs: 1000 };
mock.module(new URL('../src/lib/app-connection-session-registry.js', import.meta.url).href, {
  namedExports: {
    loadAppConnectionSessionRegistry: async () => { loads++; return { constructed: loads }; },
    statAppConnectionSessionRegistryFile: async () => ({ ...identity }),
  },
});
const { withAuthorityRegistryScope, getScopedAppConnectionSessionRegistry } = await import('../src/lib/app-authority-registry-scope.js');
process.env.DEFT_APP_CONNECTION_HTTP_CONFIG = '/abs/reviewed-http.json';

test('inside a scope, N lookups construct one registry while lstat still runs each time', async () => {
  loads = 0; identity = { path: '/abs/reviewed-http.json', dev: 1, ino: 2, size: 100, mtimeMs: 1000 };
  await withAuthorityRegistryScope(async () => {
    const a = await getScopedAppConnectionSessionRegistry();
    const b = await getScopedAppConnectionSessionRegistry();
    const c = await getScopedAppConnectionSessionRegistry();
    assert.strictEqual(a, b); assert.strictEqual(b, c);
  });
  assert.equal(loads, 1, 'the parsed registry object is constructed once per scope');
});

test('outside a scope there is no global cache: one load per call', async () => {
  loads = 0; identity = { path: '/abs/reviewed-http.json', dev: 1, ino: 2, size: 100, mtimeMs: 1000 };
  const first = await getScopedAppConnectionSessionRegistry();
  const second = await getScopedAppConnectionSessionRegistry();
  assert.notStrictEqual(first, second, 'no accidental cross-request cache');
  assert.equal(loads, 2);
});

test('a stat identity change mid-scope drops the memo and reloads', async () => {
  loads = 0; identity = { path: '/abs/reviewed-http.json', dev: 1, ino: 2, size: 100, mtimeMs: 1000 };
  await withAuthorityRegistryScope(async () => {
    await getScopedAppConnectionSessionRegistry();
    identity = { ...identity, mtimeMs: 2000, size: 200 };
    await getScopedAppConnectionSessionRegistry();
  });
  assert.equal(loads, 2, 'a replaced file is observed on the very next lookup (revocation parity)');
});
