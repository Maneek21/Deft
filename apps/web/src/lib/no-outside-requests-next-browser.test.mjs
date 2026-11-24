import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// The signup page (with and without a setup link), the setup page and the
// other credential pages make no request outside the app's origin: fonts are
// served by the app itself, never by Google (SFX1 item 3). Real Next.js
// server and root layout, real Chromium.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const web = fileURLToPath(new URL('../../', import.meta.url));

const PAGES = [
  '/signup#setup=fixture-setup-token',
  '/signup',
  '/setup',
  '/login',
  '/invite#token=fixture-invite-token',
  '/reset-password#token=fixture-reset-token',
];

test('signup, setup and credential pages request nothing outside the app origin, fonts included', { timeout: 300000 }, async () => {
  const allocator = createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const nextEnvPath = join(web, 'next-env.d.ts');
  const originalNextEnv = await readFile(nextEnvPath);
  const agentsPath = join(web, 'AGENTS.md'), originalAgents = await readFile(agentsPath);
  let logs = '', browser;
  const next = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: web, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_API_URL: origin, NEXT_PUBLIC_APP_URL: origin,
      NEXT_PUBLIC_WS_URL: origin, NODE_OPTIONS: '--max-old-space-size=1024' },
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
    for (const path of PAGES) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const outside = [], fonts = [];
      // Every request the page makes, on any frame or worker of this context.
      context.on('request', request => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:')) return;
        if (new URL(url).origin !== origin) outside.push(url);
        else if (request.resourceType() === 'font') fonts.push(url);
      });
      // Nothing may leave the machine: an outside request is recorded above,
      // then refused here, so the test never depends on the network.
      await context.route(url => new URL(url).origin !== origin, route => route.abort());
      await context.route(`${origin}/api/**`, async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/auth/has-workspace') await route.fulfill({ json: { has_workspace: false } });
        else await route.fulfill({ status: 401, json: { error: 'Unauthorized', code: 'NO_TOKEN' } });
      });
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(120000);
      try {
        await page.goto(`${origin}${path}`, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState('networkidle');
        assert.deepEqual(outside, [], `${path} requested outside the app origin`);
        assert.ok(await page.evaluate(() => document.fonts.check('16px Inter')), `${path}: Inter is available`);
        assert.ok(fonts.length > 0, `${path}: fonts load from the app`);
        for (const font of fonts) assert.match(new URL(font).pathname, /^\/_next\/static\/media\/.+\.woff2$/, font);
      } catch (error) {
        throw new Error(`${error.message}\nPage: ${await page.locator('body').innerText().catch(() => 'unavailable')}\nNext log: ${logs}`, { cause: error });
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
