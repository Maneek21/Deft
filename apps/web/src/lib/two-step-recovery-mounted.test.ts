import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Check 15.1 in the browser: the real sign-in page and the real setup page,
// each inside the real AuthProvider, mounted in Chromium with the API
// answered by page.route. A recovery code at sign-in gives no session: the
// person is sent to set up a new authenticator, and that screen starts setup
// with the token the recovery code earned and nothing else.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  // Records where the app sends the person.
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push(to) { (window.__pushed ||= []).push(to); }, replace(to) { (window.__pushed ||= []).push(to); }, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};
const RESET_TOKEN = `tsr_${'r'.repeat(43)}`;

async function mount(pagePath: string, url: string, seen: Array<{ path: string; authorization: string | null; body: unknown }>, setup?: (tab: any) => Promise<void>) {
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import Page from ${JSON.stringify(pagePath)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(Page)));`,
      resolveDir: web,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    banner: { js: 'var process = { env: {} };' },
    jsx: 'automatic',
    alias: { '@': path.join(web, 'src') },
    define: {
      'process.env.NODE_ENV': '"test"',
      'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1"',
    },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  const tab = await browser.newPage();
  tab.setDefaultTimeout(6000);
  await tab.route('**/*', (route: any) => {
    const request = route.request();
    const target = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (target.origin !== 'http://127.0.0.1') return route.abort();
    if (target.pathname === new URL(url).pathname) return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    seen.push({ path: target.pathname, authorization: request.headers().authorization ?? null, body: request.postData() ? JSON.parse(request.postData()) : null });
    if (target.pathname === '/api/auth/me') return json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
    if (target.pathname === '/api/auth/login') {
      return json({ two_step: { status: 'code_required', token: 'tsc_login_challenge', expires_at: '2026-11-23T12:00:00.000Z' } });
    }
    if (target.pathname === '/api/auth/two-step/verify') {
      return json({ two_step: { status: 'enrolment_required', token: RESET_TOKEN, expires_at: '2026-11-23T12:30:00.000Z', reason: 'recovery_code' } });
    }
    if (target.pathname === '/api/auth/two-step/enrol/start') return json({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/Deft:a@example.test' });
    return route.abort();
  });
  await tab.goto(url);
  if (setup) await setup(tab);
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  return { tab, close: () => browser.close() };
}

test('15.1: a recovery code at sign-in installs no session and sends the person to set up a new authenticator', async () => {
  const seen: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const f = await mount(path.join(web, 'src/app/login/page.tsx'), 'http://127.0.0.1/login', seen);
  try {
    await f.tab.getByLabel(/email/i).fill('owner@example.test');
    await f.tab.getByPlaceholder('••••••••').fill('a-password');
    await f.tab.getByRole('button', { name: 'Sign in' }).click();
    await f.tab.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await f.tab.getByText(/set up a new authenticator before you can continue/).waitFor();
    await f.tab.getByLabel('Recovery code').fill('AAAA-BBBB-CCCC-DDDD');
    await f.tab.getByRole('button', { name: 'Continue' }).click();
    await f.tab.waitForFunction(() => ((window as any).__pushed ?? []).includes('/two-step-setup'));

    const verify = seen.find((call) => call.path === '/api/auth/two-step/verify');
    assert.deepEqual(verify?.body, { challenge_token: 'tsc_login_challenge', recovery_code: 'AAAA-BBBB-CCCC-DDDD' });
    const stored = await f.tab.evaluate(() => ({
      access: localStorage.getItem('deft-access-token'),
      refresh: localStorage.getItem('deft-refresh-token'),
      enrolToken: sessionStorage.getItem('deft-two-step-enrol-token'),
      reason: sessionStorage.getItem('deft-two-step-enrol-reason'),
      pushed: (window as any).__pushed as string[],
    }));
    assert.deepEqual(stored, { access: null, refresh: null, enrolToken: RESET_TOKEN, reason: 'recovery_code', pushed: ['/two-step-setup'] });
  } finally {
    await f.close();
  }
});

test('15.1: the setup screen says why, and starts setup with only the recovery-reset token', async () => {
  const seen: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const f = await mount(path.join(web, 'src/app/two-step-setup/page.tsx'), 'http://127.0.0.1/two-step-setup', seen, async (tab) => {
    await tab.evaluate((token: string) => {
      sessionStorage.setItem('deft-two-step-enrol-token', token);
      sessionStorage.setItem('deft-two-step-enrol-reason', 'recovery_code');
    }, RESET_TOKEN);
  });
  try {
    await f.tab.getByRole('heading', { name: 'Set up a new authenticator' }).waitFor();
    await f.tab.getByText(/You signed in with a recovery code/).waitFor();
    await f.tab.getByRole('button', { name: 'Set up two-step verification' }).click();
    await f.tab.getByLabel('Code from the app').waitFor();
    const start = seen.find((call) => call.path === '/api/auth/two-step/enrol/start');
    assert.equal(start?.authorization, `Bearer ${RESET_TOKEN}`);
    assert.deepEqual(start?.body, {}, 'no code or password is asked for again');
  } finally {
    await f.close();
  }
});
