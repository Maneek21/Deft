import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { build } = require('esbuild');
const web = fileURLToPath(new URL('../../', import.meta.url));
let server, browser, origin, bundle;
const requests = [];
const oneTimeTokens = [];

before(async () => {
  const compiled = await build({
    stdin: { resolveDir: web, loader: 'tsx', contents: `
      import React, { StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { AuthProvider, useAuth } from './src/lib/auth-context';
      import InvitePage from './src/app/invite/page';
      import ResetPage from './src/app/reset-password/page';
      import { LinkTokenBoundary } from './src/lib/use-link-token';
      window.fixtureBoot = crypto.randomUUID();
      window.storageWrites = [];
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        window.storageWrites.push([key, value]); return setItem.call(this, key, value);
      };
      function SessionState() {
        const { loading, user } = useAuth();
        return <span id="session-state">{loading ? 'loading' : user ? 'authenticated' : 'unconfirmed'}</span>;
      }
      const Page = location.pathname === '/invite' ? InvitePage : ResetPage;
      const content = location.pathname === '/protected'
        ? <div id="protected-content">Protected workspace</div> : <Page/>;
      createRoot(document.getElementById('root')).render(
        <StrictMode><LinkTokenBoundary><AuthProvider><SessionState/>{content}</AuthProvider></LinkTokenBoundary></StrictMode>
      );
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    alias: { '@': `${web}/src` },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_API_URL': 'window.location.origin', 'process.env': '{}' },
    plugins: [{ name: 'framework-shell', setup(plugin) {
      plugin.onResolve({ filter: /^(next\/navigation|next\/link|@\/components\/brand\/logo)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      plugin.onResolve({ filter: /^\.\/socket$/ }, args => args.importer.endsWith('auth-context.tsx') ? { path: 'socket', namespace: 'fixture' } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', resolveDir: web, contents:
        args.path === 'next/navigation' ? `const router={push:()=>{},replace:()=>{}}; export const useRouter=()=>router; export const usePathname=()=>window.location.pathname;` :
        args.path === 'next/link' ? `import React from 'react'; export default function Link({children, ...props}) {return React.createElement('a',props,children);}` :
        args.path === 'socket' ? `export const disconnectSocket=()=>{};` : `export const Logo=()=>null;`
      }));
    } }],
  });
  bundle = compiled.outputFiles[0].text;
  server = createServer(async (req, res) => {
    const observation = { target: req.url, referer: req.headers.referer ?? '' };
    requests.push(observation);
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle); return; }
    if (req.url.startsWith('/api/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = body ? JSON.parse(body) : {};
      observation.token = input.token;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/invites/preview' && !input.token?.includes('expired')) {
        res.end(JSON.stringify({ org_name: 'Fixture Workspace', email: 'new@example.test', inviter_name: 'Admin', role: 'member', already_accepted: false }));
      } else if (req.url === '/api/auth/reset-password' && !input.token?.includes('expired')) {
        res.end('{}');
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'expired', code: 'INVITE_EXPIRED' }));
      }
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
});

async function open(path, token, withSession = false) {
  const context = await browser.newContext();
  if (withSession) await context.addInitScript(() => localStorage.setItem('deft-access-token', 'fixture-session-credential'));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  let release;
  const identityGate = new Promise(resolve => { release = resolve; });
  let identityStatus = 503;
  await page.route('**/api/auth/me', async route => {
    await identityGate;
    await route.fulfill({ status: identityStatus, contentType: 'application/json', body: JSON.stringify({ user: { id: 'fixture-user', timezone: 'UTC' }, org: { id: 'fixture-org' } }) });
  });
  if (token) oneTimeTokens.push(token);
  await page.goto(`${origin}${path}${token ? `#token=${token}` : ''}`);
  await page.waitForFunction(() => window.fixtureBoot && !location.hash);
  return { context, page, releaseFailure: () => release(), async reconnect() {
    identityStatus = 200;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelector('#session-state')?.textContent === 'authenticated');
  } };
}

async function assertPrivate(page) {
  const state = await page.evaluate(() => ({ url: location.href, history: JSON.stringify(history.state),
    local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), writes: JSON.stringify(window.storageWrites) }));
  for (const token of oneTimeTokens) {
    for (const value of Object.values(state)) assert.ok(!value.includes(token), 'one-time token escaped memory');
    for (const req of requests) assert.ok(!req.target.includes(token) && !req.referer.includes(token), 'one-time token reached a request target/referrer');
  }
}

async function fillAndSubmit(page, path, password = 'fixture-password-2026') {
  for (const input of await page.locator('input[type=password]').all()) await input.fill(password);
  const endpoint = path === '/invite' ? '/api/invites/accept' : '/api/auth/reset-password';
  await Promise.all([page.waitForResponse(response => response.url().endsWith(endpoint)), page.locator('form button[type=submit]').click()]);
  return requests.filter(req => req.target === endpoint).at(-1)?.token;
}

for (const path of ['/invite', '/reset-password']) {
  test(`${path}: captured token and form survive identity failure and successful reconnect`, { timeout: 30000 }, async () => {
    const token = `memory-${path.slice(1)}-reconnect`;
    const flow = await open(path, token, true);
    try {
      const input = flow.page.locator('input[type=password]').first();
      await input.fill('retained-password-2026');
      flow.releaseFailure();
      await flow.page.waitForFunction(() => document.body.textContent.includes('Reconnecting to Deft') || document.querySelector('#session-state')?.textContent === 'unconfirmed');
      await flow.reconnect();
      assert.equal(await input.count(), 1);
      assert.equal(await input.inputValue(), 'retained-password-2026');
      assert.equal(await fillAndSubmit(flow.page, path), token);
      await assertPrivate(flow.page);
    } finally { await flow.context.close(); }
  });

  test(`${path}: expired link replaced in the same mounted tab uses the fresh token`, { timeout: 30000 }, async () => {
    const oldToken = `expired-${path.slice(1)}-replace`, fresh = `fresh-${path.slice(1)}-replace`;
    const flow = await open(path, oldToken);
    try {
      const boot = await flow.page.evaluate(() => window.fixtureBoot);
      if (path === '/reset-password') await fillAndSubmit(flow.page, path);
      await flow.page.getByText(path === '/invite' ? 'Invite expired' : 'expired', { exact: path === '/invite' }).waitFor();
      oneTimeTokens.push(fresh);
      await flow.page.goto(`${origin}${path}#token=${fresh}`);
      await flow.page.waitForFunction(() => !location.hash);
      assert.equal(await flow.page.evaluate(() => window.fixtureBoot), boot, 'test must use same-document navigation');
      await flow.page.locator('input[type=password]').first().waitFor();
      assert.equal(await flow.page.locator('input[type=password]').first().inputValue(), '');
      assert.equal(await fillAndSubmit(flow.page, path), fresh);
      await assertPrivate(flow.page);
    } finally { await flow.context.close(); }
  });

  test(`${path}: missing link replaced in the same mounted tab captures a valid token`, { timeout: 30000 }, async () => {
    const flow = await open(path);
    try {
      await flow.page.getByText(path === '/invite' ? 'Open invitation link' : 'Reopen the original password recovery link to continue.', { exact: true }).waitFor();
      const boot = await flow.page.evaluate(() => window.fixtureBoot), token = `valid-${path.slice(1)}-replacement`;
      oneTimeTokens.push(token);
      await flow.page.goto(`${origin}${path}#token=${token}`);
      await flow.page.waitForFunction(() => !location.hash);
      assert.equal(await flow.page.evaluate(() => window.fixtureBoot), boot);
      await flow.page.locator('input[type=password]').first().waitFor();
      assert.equal(await fillAndSubmit(flow.page, path), token);
      await assertPrivate(flow.page);
    } finally { await flow.context.close(); }
  });
}

test('identity failure still hides protected workspace content until reconnect', { timeout: 30000 }, async () => {
  const flow = await open('/protected', null, true);
  try {
    await flow.page.locator('#protected-content').waitFor();
    flow.releaseFailure();
    await flow.page.getByText('Reconnecting to Deft', { exact: true }).waitFor();
    assert.equal(await flow.page.locator('#protected-content').count(), 0);
    await flow.reconnect();
    await flow.page.locator('#protected-content').waitFor();
  } finally { await flow.context.close(); }
});
