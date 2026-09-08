import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.env.SH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : 'sh');

function toShellPath(value) {
  if (process.platform !== 'win32') return value;
  return value.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');
}

function waitForExit(child, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`entrypoint did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function createFixture({ api, web }) {
  const root = await mkdtemp(path.join(tmpdir(), 'deft-entrypoint-'));
  const bin = path.join(root, 'bin');
  const appScripts = path.join(root, 'scripts');
  const apiDir = path.join(root, 'apps', 'api');
  const webDir = path.join(root, 'apps', 'web');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(appScripts, { recursive: true }), mkdir(apiDir, { recursive: true }), mkdir(webDir, { recursive: true })]);

  await writeFile(path.join(appScripts, 'inject-public-env.mjs'), '');
  await writeFile(path.join(root, 'api-fixture.sh'), api, { mode: 0o755 });
  await writeFile(path.join(root, 'web-fixture.sh'), web, { mode: 0o755 });
  await writeFile(
    path.join(bin, 'node'),
    `#!/bin/sh\ncase "$*" in\n  *inject-public-env.mjs*) exit 0 ;;\n  *src/server.ts*) exec "$FAKE_API" ;;\n  *'next start -p 3000'*) exec "$FAKE_WEB" ;;\n  *) echo "unexpected node invocation: $*" >&2; exit 99 ;;\nesac\n`,
    { mode: 0o755 },
  );

  const entrypoint = (await readFile(path.join(repoRoot, 'scripts', 'docker-entrypoint.sh'), 'utf8'))
    .replaceAll('/app/', `${toShellPath(root)}/`);
  const entrypointPath = path.join(root, 'docker-entrypoint.sh');
  await writeFile(entrypointPath, entrypoint, { mode: 0o755 });

  return {
    root,
    start() {
      return spawn(shell, [toShellPath(entrypointPath)], {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          FAKE_API: toShellPath(path.join(root, 'api-fixture.sh')),
          FAKE_WEB: toShellPath(path.join(root, 'web-fixture.sh')),
          TERMINATION_MARKER: toShellPath(path.join(root, 'terminated')),
          API_TERMINATION_MARKER: toShellPath(path.join(root, 'api-terminated')),
          WEB_TERMINATION_MARKER: toShellPath(path.join(root, 'web-terminated')),
        },
        stdio: 'ignore',
      });
    },
  };
}

test('exits with the API failure when the web server remains alive', async (t) => {
  const fixture = await createFixture({
    api: '#!/bin/sh\nexit 7\n',
    web: '#!/bin/sh\ntrap \'exit 0\' TERM\nwhile :; do sleep 0.1; done\n',
  });
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));

  const entrypoint = fixture.start();
  t.after(() => entrypoint.kill());
  assert.deepEqual(await waitForExit(entrypoint), { code: 7, signal: null });
});

test('exits with the web failure when the API remains alive', async (t) => {
  const fixture = await createFixture({
    api: '#!/bin/sh\ntrap \'echo terminated > "$TERMINATION_MARKER"; exit 0\' TERM\nwhile :; do sleep 0.1; done\n',
    web: '#!/bin/sh\nexit 9\n',
  });
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));

  const entrypoint = fixture.start();
  assert.deepEqual(await waitForExit(entrypoint), { code: 9, signal: null });
  assert.equal(await readFile(path.join(fixture.root, 'terminated'), 'utf8'), 'terminated\n');
});

test('forwards SIGTERM to both children before exiting', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createFixture({
    api: '#!/bin/sh\ntrap \'echo terminated > "$API_TERMINATION_MARKER"; exit 0\' TERM\nwhile :; do sleep 0.1; done\n',
    web: '#!/bin/sh\ntrap \'echo terminated > "$WEB_TERMINATION_MARKER"; exit 0\' TERM\nwhile :; do sleep 0.1; done\n',
  });
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));

  const entrypoint = fixture.start();
  setTimeout(() => entrypoint.kill('SIGTERM'), 150);
  assert.deepEqual(await waitForExit(entrypoint), { code: 0, signal: null });
  assert.equal(await readFile(path.join(fixture.root, 'api-terminated'), 'utf8'), 'terminated\n');
  assert.equal(await readFile(path.join(fixture.root, 'web-terminated'), 'utf8'), 'terminated\n');
});
