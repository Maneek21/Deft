import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(webRoot, '..', '..');

/** Builds the page policy exactly as Next would, in a fresh process with the given public URLs. */
function pagePolicy(env: Record<string, string>): string {
  const script = `import(${JSON.stringify(pathToFileURL(join(webRoot, 'next.config.ts')).href)})
    .then(async (m) => { const config = m.default.default ?? m.default; const rows = await config.headers();
      const row = rows.find((r) => r.source === '/(.*)');
      process.stdout.write(row.headers.find((h) => h.key === 'Content-Security-Policy').value); })`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: webRoot, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const connectSrc = (policy: string) => policy.split('; ').find((part) => part.startsWith('connect-src '));

test('page may connect only to itself and the configured API and live-connection origins', () => {
  const policy = pagePolicy({
    NEXT_PUBLIC_APP_URL: 'https://acme.deft.example',
    NEXT_PUBLIC_API_URL: 'https://api.acme.deft.example/base/',
    NEXT_PUBLIC_WS_URL: 'https://live.acme.deft.example',
  });
  assert.equal(connectSrc(policy),
    "connect-src 'self' https://api.acme.deft.example wss://api.acme.deft.example https://live.acme.deft.example wss://live.acme.deft.example");
  // No scheme-wide sources left that would let a page script send anywhere.
  assert.doesNotMatch(connectSrc(policy)!, /(^| )(https:|http:|ws:|wss:|\*)( |$)/);
  // Other directives are unchanged.
  assert.match(policy, /img-src 'self' data: blob: https:/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test('one address for API and live connection is listed once; local defaults stay usable', () => {
  assert.equal(connectSrc(pagePolicy({ NEXT_PUBLIC_API_URL: 'http://localhost:3001', NEXT_PUBLIC_WS_URL: 'http://localhost:3001' })),
    "connect-src 'self' http://localhost:3001 ws://localhost:3001");
});

test('prebuilt image: placeholders in the policy become the real origins at start', async () => {
  const policy = pagePolicy({ NEXT_PUBLIC_API_URL: '__DEFT_API_URL__', NEXT_PUBLIC_WS_URL: '__DEFT_WS_URL__', NEXT_PUBLIC_APP_URL: '__DEFT_APP_URL__' });
  assert.equal(connectSrc(policy),
    "connect-src 'self' __DEFT_API_ORIGIN__ __DEFT_API_WS_ORIGIN__ __DEFT_WS_ORIGIN__ __DEFT_WS_WS_ORIGIN__");
  // Run the image's start-time injection over a routes manifest carrying the policy.
  const { injectPublicEnv } = await import(pathToFileURL(join(repoRoot, 'scripts', 'inject-public-env.mjs')).href);
  const root = await mkdtemp(join(tmpdir(), 'deft-csp-'));
  try {
    await mkdir(join(root, 'server'), { recursive: true });
    const manifest = join(root, 'routes-manifest.json');
    await writeFile(manifest, JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: policy }] }] }));
    await injectPublicEnv(root, {
      NEXT_PUBLIC_APP_URL: 'https://acme.deft.example',
      NEXT_PUBLIC_API_URL: 'https://api.acme.deft.example/',
      NEXT_PUBLIC_WS_URL: 'https://api.acme.deft.example',
    });
    const injected = JSON.parse(await readFile(manifest, 'utf8')).headers[0].headers[0].value as string;
    assert.equal(connectSrc(injected),
      "connect-src 'self' https://api.acme.deft.example wss://api.acme.deft.example https://api.acme.deft.example wss://api.acme.deft.example");
    assert.doesNotMatch(injected, /__DEFT_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
