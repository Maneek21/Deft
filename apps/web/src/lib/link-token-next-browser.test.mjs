import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const web = fileURLToPath(new URL('../../', import.meta.url));

test('real AppRouter keeps legacy invite and recovery credentials out of session history', { timeout: 180000 }, async () => {
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
    for (const kind of ['invite', 'reset-password']) {
      const token = `legacy-${kind}-fixture-secret`, context = await browser.newContext();
      const page = await context.newPage();
      const observations = [];
      await page.addInitScript(() => { window.initialCredentialUrl = location.href; });
      page.on('response', response => { if (response.request().isNavigationRequest()) observations.push([response.status(), response.url(), response.headers()['location']]); });
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(90000);
      const submitted = [];
      await page.route('https://fonts.googleapis.com/**', route => route.abort());
      await page.route('https://fonts.gstatic.com/**', route => route.abort());
      await page.route('**/api/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const body = request.postDataJSON();
        if (path === '/api/invites/preview') {
          await route.fulfill({ json: { org_name: 'Real Router Workspace', email: 'new@example.test', inviter_name: 'Admin', role: 'member', already_accepted: false } });
        } else if (path === '/api/invites/accept' || path === '/api/auth/reset-password') {
          submitted.push(body.token);
          await route.fulfill({ status: 400, json: { error: 'expired', code: 'INVITE_EXPIRED' } });
        } else await route.fulfill({ status: 401, json: { code: 'UNAUTHENTICATED' } });
      });
      try {
        const legacy = kind === 'invite' ? `/invite/${token}` : `/reset-password?token=${token}`;
        await page.goto(`${origin}${legacy}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(clean => history.state?.__NA && !location.hash && !location.search && location.pathname === clean, `/${kind}`);
        const captured = await page.evaluate(() => ({ url: location.href, history: JSON.stringify(history.state),
          local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }));
        for (const [where, value] of Object.entries(captured)) assert.ok(!value.includes(token), `legacy ${kind} credential retained in ${where}`);
        assert.ok(await page.evaluate(() => history.state?.__NA), 'must exercise the real AppRouter history');
        await page.locator('form input[type=password]').first().waitFor();
        for (const input of await page.locator('form input[type=password]').all()) await input.fill('legacy-router-password-2026');
        const endpoint = kind === 'invite' ? '/api/invites/accept' : '/api/auth/reset-password';
        await Promise.all([page.waitForResponse(response => response.url().endsWith(endpoint)), page.locator('form button[type=submit]').click()]);
        assert.deepEqual(submitted, [token], 'legacy credential still reaches acceptance/reset body');
        assert.ok(!(await page.evaluate(() => JSON.stringify(history.state))).includes(token));
        const fresh = `fresh-${kind}-fixture-secret`;
        await page.goto(`${origin}/${kind}#token=${fresh}`);
        await page.waitForFunction(() => !location.hash);
        await page.locator('form input[type=password]').first().waitFor();
        assert.equal(await page.locator('form input[type=password]').first().inputValue(), '', 'replacement clears the stale form');
        for (const input of await page.locator('form input[type=password]').all()) await input.fill('replacement-password-2026');
        await Promise.all([page.waitForResponse(response => response.url().endsWith(endpoint)), page.locator('form button[type=submit]').click()]);
        assert.deepEqual(submitted, [token, fresh]);
        assert.ok(!(await page.evaluate(() => JSON.stringify(history.state))).includes(fresh));
      } catch (error) {
        throw new Error(`${error.message}\nNavigation: ${JSON.stringify(observations)}\nInitial: ${await page.evaluate(() => window.initialCredentialUrl)}\nPage: ${await page.locator('body').innerText().catch(() => 'unavailable')}\nNext log: ${logs}`, { cause: error });
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
