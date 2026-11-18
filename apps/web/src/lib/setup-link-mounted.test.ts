import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real signup page inside the real AuthProvider, mounted in Chromium. Only
// the Next.js runtime pieces (router, Link, Image) are stubbed, and the API is
// answered by page.route, so the request body is exactly what the browser sends.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

async function mountSignup(hash: string) {
  const page = path.join(web, 'src/app/signup/page.tsx');
  const auth = path.join(web, 'src/app/providers.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import SignupPage from ${JSON.stringify(page)};
import { Providers as AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(SignupPage)));`,
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
  const signupBodies: unknown[] = [];
  await tab.route('**/*', (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1') return route.abort();
    if (url.pathname === '/signup') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/auth/has-workspace') return route.fulfill({ contentType: 'application/json', body: '{"hasWorkspace":false}' });
    if (url.pathname === '/api/auth/signup') {
      signupBodies.push(JSON.parse(request.postData() ?? 'null'));
      return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"stopped by the test","code":"TEST_STOP"}' });
    }
    return route.abort();
  });
  await tab.goto(`http://127.0.0.1/signup${hash}`);
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  return { tab, signupBodies, close: () => browser.close() };
}

async function submit(tab: any) {
  await tab.getByRole('button', { name: 'Create workspace' }).waitFor();
  await tab.getByPlaceholder('Full name').fill('Ada');
  await tab.getByPlaceholder('name@company.com').fill('ada@example.test');
  await tab.getByPlaceholder('••••••••').fill('a-long-password');
  await tab.getByPlaceholder('Your team or company').fill('Analytical');
  await tab.getByRole('button', { name: 'Create workspace' }).click();
  await tab.getByText('stopped by the test').waitFor();
}

test('the mounted signup page sends the token from the setup link in the signup body and clears it from the address', async () => {
  const f = await mountSignup('#setup=a+b%2Fc_-9');
  try {
    await submit(f.tab);
    assert.deepEqual(f.signupBodies, [{
      name: 'Ada', email: 'ada@example.test', password: 'a-long-password', org_name: 'Analytical', setup_token: 'a+b/c_-9',
    }]);
    assert.equal(await f.tab.evaluate(() => window.location.href), 'http://127.0.0.1/signup');
  } finally {
    await f.close();
  }
});

test('the mounted signup page without a setup link sends the body a self-hosted signup always sent', async () => {
  const f = await mountSignup('');
  try {
    await submit(f.tab);
    assert.deepEqual(f.signupBodies, [{
      name: 'Ada', email: 'ada@example.test', password: 'a-long-password', org_name: 'Analytical',
    }]);
  } finally {
    await f.close();
  }
});

test('a setup link opened into an already open signup page is read too', async () => {
  const f = await mountSignup('');
  try {
    await f.tab.getByRole('button', { name: 'Create workspace' }).waitFor();
    // Same path, new fragment: the browser does not reload, the page stays mounted.
    await f.tab.evaluate(() => { window.location.hash = '#setup=pasted-later'; });
    await f.tab.waitForFunction(() => window.location.href === 'http://127.0.0.1/signup');
    await submit(f.tab);
    assert.equal((f.signupBodies[0] as { setup_token?: string }).setup_token, 'pasted-later');
  } finally {
    await f.close();
  }
});

test('a failed signup retains its setup token for retry through production providers', async () => {
  const f = await mountSignup('#setup=retry-secret');
  try {
    await submit(f.tab);
    await submit(f.tab);
    assert.equal(f.signupBodies.length, 2);
    for (const body of f.signupBodies) assert.equal((body as { setup_token?: string }).setup_token, 'retry-secret');
    assert.equal(await f.tab.evaluate(() => window.location.hash), '');
  } finally { await f.close(); }
});
