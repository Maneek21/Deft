/**
 * Hosted mode: the marker that records a setup token's use
 * (apps/api/src/lib/setup-token-use.ts). The signup route's use of it is in
 * signup-first-workspace-db.test.ts.
 *
 * Run: pnpm --filter @deft/api test test/setup-token-use.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  isSetupTokenUsed,
  markSetupTokenUsed,
  SetupTokenUseError,
  setupTokenUseStore,
} from '../src/lib/setup-token-use.js';
import { localFileStore } from '../src/lib/file-store.js';

const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const HASH = hashOf('token-one');
const OTHER = hashOf('token-two');

async function withDir(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deft-setup-use-'));
  const saved = setupTokenUseStore.dir;
  setupTokenUseStore.dir = join(root, 'uploads', '.setup-token-used');
  try { await run(root); } finally {
    setupTokenUseStore.dir = saved;
    await rm(root, { recursive: true, force: true });
  }
}

async function rejectsWith(promise: Promise<unknown>, reason: 'used' | 'storage') {
  await assert.rejects(promise, (error: unknown) => error instanceof SetupTokenUseError && error.reason === reason);
}

test('by default the markers live on the uploads volume', () => {
  assert.equal(setupTokenUseStore.dir, join(localFileStore.rootDir, '.setup-token-used'));
});

test('a token is unused until marked, then used; other tokens are unaffected', async () => {
  await withDir(async () => {
    assert.equal(await isSetupTokenUsed(HASH), false, 'no directory yet means unused');
    await markSetupTokenUsed(HASH, new Date('2026-11-18T12:00:00.000Z'));
    assert.equal(await isSetupTokenUsed(HASH), true);
    assert.equal(await isSetupTokenUsed(OTHER), false);
    assert.deepEqual(await readdir(setupTokenUseStore.dir), [HASH], 'one file, named by the hash');
    assert.equal(await readFile(join(setupTokenUseStore.dir, HASH), 'utf8'), '2026-11-18T12:00:00.000Z\n',
      'the marker holds only the time, never the token');
  });
});

test('marking a token twice is refused as used', async () => {
  await withDir(async () => {
    await markSetupTokenUsed(HASH);
    await rejectsWith(markSetupTokenUsed(HASH), 'used');
    assert.equal(await isSetupTokenUsed(HASH), true);
  });
});

test('two marks at once: exactly one succeeds', async () => {
  await withDir(async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => markSetupTokenUsed(HASH)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of results.filter((entry) => entry.status === 'rejected')) {
      assert.ok((result as PromiseRejectedResult).reason instanceof SetupTokenUseError);
      assert.equal(((result as PromiseRejectedResult).reason as SetupTokenUseError).reason, 'used');
    }
  });
});

test('a marker that cannot be written fails as storage and leaves no marker', async () => {
  await withDir(async () => {
    // A regular file where the marker directory should be: mkdir fails.
    await mkdir(dirname(setupTokenUseStore.dir), { recursive: true });
    await writeFile(setupTokenUseStore.dir, 'not a directory');
    await rejectsWith(markSetupTokenUsed(HASH), 'storage');
    // And the check cannot answer either (ENOTDIR on Linux, where cells run),
    // so it fails closed too. Windows reports ENOENT here instead.
    if (process.platform !== 'win32') await rejectsWith(isSetupTokenUsed(HASH), 'storage');
  });
});

test('anything other than a SHA-256 hex hash is never used as a path', async () => {
  await withDir(async () => {
    for (const bad of ['', '../escape', HASH.toUpperCase(), `${HASH}0`, `${HASH.slice(0, 63)}/`]) {
      await rejectsWith(markSetupTokenUsed(bad), 'storage');
      await rejectsWith(isSetupTokenUsed(bad), 'storage');
    }
  });
});
