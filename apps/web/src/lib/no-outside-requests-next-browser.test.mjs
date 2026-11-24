import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The signup page (with and without a setup link), the setup page and the
// other credential pages make no request to a third party: every request
// goes to the app itself or to its own API, and the fonts are served by the
// app, never by Google (SFX1 item 3). Real Next.js server and root layout,
// real Chromium. The API is given its own origin, as in the Compose setup
// (web on :3000, API on :3001), so a request to it is told apart from one to
// the app.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const web = fileURLToPath(new URL('../../', import.meta.url));

const PAGES = [
  { path: '/signup#setup=fixture-setup-token', pathname: '/signup', marker: { text: 'Create your workspace' } },
  { path: '/signup', pathname: '/signup', marker: { text: 'Create your workspace' } },
  { path: '/setup', pathname: '/setup', marker: { text: 'Welcome to Deft' } },
  { path: '/login', pathname: '/login', marker: { text: 'Sign in to your workspace' } },
  { path: '/invite#token=fixture-invite-token', pathname: '/invite', marker: { text: 'Join Fixture Workspace' } },
  { path: '/reset-password#token=fixture-reset-token', pathname: '/reset-password', marker: { css: 'form input[type=password]' } },
];

// Every face and weight the app uses (app/layout.tsx).
const FACES = [['Inter', '400'], ['Inter', '500'], ['Inter', '600'], ['Inter', '700'],
  ['JetBrains Mono', '400'], ['JetBrains Mono', '500']];

/** Distinct free ports: every listener stays open until all are allocated. */
async function freePorts(count) {
  const allocators = [];
  for (let i = 0; i < count; i += 1) {
    const allocator = createServer();
    await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
    allocators.push(allocator);
  }
  const ports = allocators.map(allocator => allocator.address().port);
  await Promise.all(allocators.map(allocator => new Promise(resolve => allocator.close(resolve))));
  return ports;
}

test('signup, setup and credential pages request nothing from a third party, and fonts come from the app', { timeout: 300000 }, async () => {
  const [port, apiPort] = await freePorts(2);
  const origin = `http://127.0.0.1:${port}`;
  // Nothing listens here: every API request is answered by the route below.
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const firstParty = new Set([origin, apiOrigin]);
  const nextEnvPath = join(web, 'next-env.d.ts');
  const originalNextEnv = await readFile(nextEnvPath);
  const agentsPath = join(web, 'AGENTS.md'), originalAgents = await readFile(agentsPath);
  let logs = '', browser;
  const next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: web, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_API_URL: apiOrigin, NEXT_PUBLIC_APP_URL: origin,
      NEXT_PUBLIC_WS_URL: apiOrigin, NODE_OPTIONS: '--max-old-space-size=1024' },
  });
  const exited = new Promise(resolve => next.once('exit', resolve));
  next.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  next.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  try {
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline && next.exitCode === null && next.signalCode === null) {
      try { if ((await fetch(`${origin}/brand/deft-192.png`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } }
      catch { /* Wait for this test's server, never another process. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, `Next test server failed to start: ${logs}`);
    browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
    for (const { path, pathname, marker } of PAGES) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const thirdParty = [], fontResponses = [];
      // Every request of this context: page, frames and workers.
      context.on('request', request => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:')) return;
        if (!firstParty.has(new URL(url).origin)) thirdParty.push(url);
      });
      context.on('response', response => {
        if (response.request().resourceType() === 'font') fontResponses.push({ url: response.url(), status: response.status() });
      });
      // Nothing may leave the machine: a third-party request is recorded
      // above, then refused here, so the test never depends on the network.
      await context.route(url => !firstParty.has(new URL(url).origin), route => route.abort());
      await context.route(url => new URL(url).origin === apiOrigin, async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/auth/has-workspace') await route.fulfill({ json: { hasWorkspace: false } });
        else if (pathname === '/api/invites/preview') {
          await route.fulfill({ json: { org_name: 'Fixture Workspace', email: 'new@example.test', inviter_name: 'Admin', role: 'member', already_accepted: false } });
        } else await route.fulfill({ status: 401, json: { error: 'Unauthorized', code: 'NO_TOKEN' } });
      });
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(120000);
      try {
        await page.goto(`${origin}${path}`, { waitUntil: 'load' });
        // The page asked for is the one that rendered (no redirect to another page).
        if (marker.text) await page.getByText(marker.text, { exact: false }).first().waitFor();
        else await page.locator(marker.css).first().waitFor();
        assert.equal(new URL(page.url()).pathname, pathname, `${path} stayed on its page`);
        // Load every face and weight the app uses and record what each load
        // actually matched (a missing weight would fall back to another).
        const loaded = await page.evaluate(async faces => Promise.all(faces.map(async ([family, weight]) => {
          const matched = await document.fonts.load(`${weight} 16px "${family}"`, 'Aa');
          return matched.map(face => [face.family.replace(/^["']|["']$/g, ''), String(face.weight), face.status]);
        })), FACES);
        await page.waitForLoadState('networkidle');
        assert.deepEqual(thirdParty, [], `${path} made a third-party request`);
        FACES.forEach(([family, weight], index) => {
          assert.ok(loaded[index].some(([f, w, status]) => f === family && w === weight && status === 'loaded'),
            `${path}: ${family} ${weight} loads itself, got ${JSON.stringify(loaded[index])}`);
        });
        const fontUrls = new Set(fontResponses.map(font => font.url));
        assert.ok(fontUrls.size >= FACES.length, `${path}: one file per face at least, got ${[...fontUrls].join(', ')}`);
        for (const font of fontResponses) {
          assert.equal(new URL(font.url).origin, origin, font.url);
          assert.match(new URL(font.url).pathname, /^\/_next\/static\/media\/.+\.woff2$/, font.url);
          assert.ok(font.status >= 200 && font.status < 300, `${font.url} answered ${font.status}`);
        }
      } catch (error) {
        throw new Error(`${error.message}\nURL: ${page.url()}\nPage: ${await page.locator('body').innerText().catch(() => 'unavailable')}\nNext log: ${logs}`, { cause: error });
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    if (next.exitCode === null && next.signalCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(next.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-next.pid, 'SIGTERM');
    }
    await exited;
    // Restore the exact pre-test bytes of Next's generated files so this
    // test does not change the reviewed branch.
    await writeFile(nextEnvPath, originalNextEnv);
    await writeFile(agentsPath, originalAgents);
  }
});
