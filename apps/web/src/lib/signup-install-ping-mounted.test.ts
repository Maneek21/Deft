import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The setup screen's telemetry line (telemetry contract, section 3): the real
// signup page in Chromium, with has-workspace answered by page.route. The
// line shows when the server says the install ping is on, and when the
// server's answer cannot be trusted (an error, an odd body, no answer), since
// the server may still send the ping then. It is hidden only when a good
// answer says the ping is off, and on a hosted setup link.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const LINE = "Deft sends an anonymous ping when it's installed and when someone joins";
const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'const params = {}; export const usePathname = () => window.location.pathname; export const useParams = () => params; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

type Answer = { status: number; body: string } | 'abort';

async function lineShown(answer: Answer, hash = ''): Promise<boolean> {
  const page = path.join(web, 'src/app/signup/page.tsx');
  const providers = path.join(web, 'src/app/providers.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import SignupPage from ${JSON.stringify(page)};
import { Providers } from ${JSON.stringify(providers)};
createRoot(document.getElementById('root')).render(createElement(Providers, null, createElement(SignupPage)));`,
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
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1"' },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  try {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(6000);
    await tab.route('**/*', (route: any) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/signup') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      if (url.pathname === '/api/auth/has-workspace') {
        return answer === 'abort' ? route.abort() : route.fulfill({ status: answer.status, contentType: 'application/json', body: answer.body });
      }
      return route.abort();
    });
    await tab.goto(`http://127.0.0.1/signup${hash}`);
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });
    await tab.getByRole('button', { name: 'Create workspace' }).waitFor();
    return (await tab.getByText(LINE, { exact: false }).count()) > 0;
  } finally {
    await browser.close();
  }
}

test('the ping line shows when the ping is on, and whenever the answer cannot be trusted', async () => {
  assert.equal(await lineShown({ status: 200, body: JSON.stringify({ hasWorkspace: false, install_ping: true }) }), true, 'on');
  assert.equal(await lineShown({ status: 503, body: JSON.stringify({ error: 'unavailable' }) }), true, 'an error answer');
  assert.equal(await lineShown({ status: 200, body: JSON.stringify({ something: 'else' }) }), true, 'an odd body');
  assert.equal(await lineShown('abort'), true, 'no answer');
});

test('the ping line is hidden only when a good answer says it is off, and on a hosted setup link', async () => {
  assert.equal(await lineShown({ status: 200, body: JSON.stringify({ hasWorkspace: false }) }), false, 'off');
  assert.equal(await lineShown('abort', '#setup=a-hosted-setup-token-0123456789abcdef'), false, 'hosted setup link');
});
