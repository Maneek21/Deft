import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real two-step setup screen inside the real AuthProvider, mounted in
// Chromium. Next.js runtime pieces are stubbed and the API is answered by
// page.route. Setup runs with an enrol-only token, so confirming hands back a
// new session; it must not be installed over someone else's sign-in.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}
const A = { access: token({ id: 'user-a', org_id: 'org', sid: 'session-a', jti: 'a1' }), refresh: token({ id: 'user-a', org_id: 'org', sid: 'session-a', jti: 'a2' }) };
const B = { access: token({ id: 'user-b', org_id: 'org', sid: 'session-b', jti: 'b1' }), refresh: token({ id: 'user-b', org_id: 'org', sid: 'session-b', jti: 'b2' }) };
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-${String(i).padStart(4, '0')}`);

async function mountSetup(signedInBefore?: { access: string; refresh: string }) {
  const enrolment = path.join(web, 'src/components/two-step-enrolment.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { TwoStepEnrolment } from ${JSON.stringify(enrolment)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(TwoStepEnrolment, { enrolToken: 'tsc_enrol_only', onFinished() {} })));`,
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
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== 'http://127.0.0.1') return route.abort();
    if (url.pathname === '/two-step-setup') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/auth/me') {
      return json({ user: { id: 'user-b', name: 'B', email: 'b@example.test', timezone: 'UTC' }, org: { id: 'org', name: 'Org', slug: 'org' } });
    }
    if (url.pathname === '/api/auth/two-step/enrol/start') return json({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/Deft:a@example.test' });
    if (url.pathname === '/api/auth/two-step/enrol/confirm') {
      return json({ recovery_codes: CODES, user: { id: 'user-a' }, org_id: 'org', accessToken: A.access, refreshToken: A.refresh });
    }
    return route.abort();
  });
  await tab.goto('http://127.0.0.1/two-step-setup');
  if (signedInBefore) {
    await tab.evaluate(({ access, refresh }: { access: string; refresh: string }) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', refresh);
    }, signedInBefore);
  }
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  await tab.getByRole('button', { name: 'Set up two-step verification' }).click();
  await tab.getByLabel('Code from the app').waitFor();
  return { tab, close: () => browser.close() };
}

async function confirm(tab: any) {
  await tab.getByLabel('Code from the app').fill('123456');
  await tab.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await tab.getByTestId('two-step-recovery-codes').waitFor();
  assert.equal(await tab.getByTestId('two-step-recovery-codes').innerText(), CODES.join('\n'), 'the recovery codes are shown either way');
  return tab.evaluate(() => localStorage.getItem('deft-refresh-token'));
}

test('finishing setup installs the session it hands back when nobody else signed in', async () => {
  const f = await mountSetup();
  try {
    assert.equal(await confirm(f.tab), A.refresh);
  } finally {
    await f.close();
  }
});

test('setup opened while someone is signed in (a reload after another sign-in) keeps their session', async () => {
  const f = await mountSetup(B);
  try {
    assert.equal(await confirm(f.tab), B.refresh, "B's sign-in is kept");
  } finally {
    await f.close();
  }
});

test('a sign-in as someone else in another tab after setup began is not replaced by the setup session', async () => {
  const f = await mountSetup();
  try {
    // Another tab signs in as B: shared storage changes before this tab hears of it.
    await f.tab.evaluate(({ access, refresh }: { access: string; refresh: string }) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', refresh);
    }, B);
    assert.equal(await confirm(f.tab), B.refresh, "B's sign-in is kept");
  } finally {
    await f.close();
  }
});
