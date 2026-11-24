import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  // Other directives: images stay open (avatars, link previews), so this
  // policy does not stop every way a page script could leak data.
  assert.match(policy, /img-src 'self' data: blob: https:/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'self'/);
  assert.match(policy, /base-uri 'self'/);
});

test('a ws or wss live-connection address is accepted and both forms are listed', () => {
  assert.equal(connectSrc(pagePolicy({ NEXT_PUBLIC_API_URL: 'https://api.acme.deft.example', NEXT_PUBLIC_WS_URL: 'wss://live.acme.deft.example/socket' })),
    "connect-src 'self' https://api.acme.deft.example wss://api.acme.deft.example https://live.acme.deft.example wss://live.acme.deft.example");
  assert.equal(connectSrc(pagePolicy({ NEXT_PUBLIC_API_URL: 'http://localhost:3001', NEXT_PUBLIC_WS_URL: 'ws://localhost:3001' })),
    "connect-src 'self' http://localhost:3001 ws://localhost:3001");
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
  const { injectPublicEnv } = await import('../../../../scripts/inject-public-env.mjs');
  const root = await mkdtemp(join(tmpdir(), 'deft-csp-'));
  try {
    await mkdir(join(root, 'server'), { recursive: true });
    const manifest = join(root, 'routes-manifest.json');
    await writeFile(manifest, JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: policy }] }] }));
    await injectPublicEnv(root, {
      NODE_ENV: 'test',
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

/** All header rows from next.config.ts, in a fresh process. */
function headerRows(): Array<{ source: string; has?: Array<{ type: string; key: string; value?: string }>; headers: Array<{ key: string; value: string }> }> {
  const script = `import(${JSON.stringify(pathToFileURL(join(webRoot, 'next.config.ts')).href)})
    .then(async (m) => { const config = m.default.default ?? m.default; process.stdout.write(JSON.stringify(await config.headers())); })`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: webRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Next applies every matching row in order; a later row overrides a key. */
function headersFor(rows: ReturnType<typeof headerRows>, target: string): Record<string, string> {
  const { pathname, searchParams } = new URL(target, 'https://deft.example');
  const out: Record<string, string> = {};
  for (const row of rows) {
    const prefix = row.source.endsWith('/:path*') ? row.source.slice(0, -'/:path*'.length) + '/' : null;
    const hasMatches = (row.has ?? []).every((condition) => condition.type === 'query'
      // Next reads the last value of a repeated query key.
      && searchParams.has(condition.key) && (condition.value === undefined || searchParams.getAll(condition.key).at(-1) === condition.value));
    if (hasMatches && (row.source === '/(.*)' || row.source === pathname || (prefix && pathname.startsWith(prefix)))) {
      for (const header of row.headers) out[header.key] = header.value;
    }
  }
  return out;
}

test('every page sends the four isolation headers the API sends; two named exceptions', () => {
  const rows = headerRows();
  const four = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'off',
  };
  for (const path of ['/', '/login', '/chat', '/dashboard', '/invite', '/invite/abc', '/reset-password', '/app-experience-bootstrap', '/_next/static/chunks/main.js', '/icon.png']) {
    const headers = headersFor(rows, path);
    for (const [key, value] of Object.entries(four)) assert.equal(headers[key], value, `${key} on ${path}`);
  }
  // The MCP authorization page may be an outside client's pop-up: no COOP,
  // so its callback page keeps window.opener. The other three still apply.
  const authorize = headersFor(rows, '/oauth/authorize');
  assert.equal(authorize['Cross-Origin-Opener-Policy'], 'unsafe-none');
  assert.equal(authorize['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(authorize['Origin-Agent-Cluster'], '?1');
  // The sign-in page authorization sends a signed-out person to, so a reload
  // in the pop-up keeps the opener; ordinary sign-in keeps COOP.
  for (const path of ['/login?from=oauth', '/login?expired=1&from=oauth', '/login?from=other&from=oauth', '/two-step-setup?from=oauth']) {
    assert.equal(headersFor(rows, path)['Cross-Origin-Opener-Policy'], 'unsafe-none', path);
    assert.equal(headersFor(rows, path)['Cross-Origin-Resource-Policy'], 'same-origin', path);
  }
  for (const path of ['/login', '/login?expired=1', '/login?from=other', '/login?from=oauth&from=other', '/two-step-setup']) {
    assert.equal(headersFor(rows, path)['Cross-Origin-Opener-Policy'], 'same-origin', path);
  }
  // The opaque sandboxed bootstrap frame must be able to load its script.
  const bootstrapScript = headersFor(rows, '/app-experience-bootstrap.js');
  assert.equal(bootstrapScript['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.equal(bootstrapScript['Cross-Origin-Opener-Policy'], 'same-origin');
});
