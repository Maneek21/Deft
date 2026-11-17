import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real invite acceptance screen inside the real AuthProvider, mounted in
// Chromium. Someone else (B) is signed in in this browser. Accepting an admin
// invite on a hosted cell answers with an enrol-only token: B must be signed
// out before setup, so the invitee does not finish setup and land as B.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push(href) { window.__pushed = href; }, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}
const B = { access: token({ id: 'user-b', org_id: 'org', sid: 'session-b', jti: 'b1' }), refresh: token({ id: 'user-b', org_id: 'org', sid: 'session-b', jti: 'b2' }) };

test('accepting an admin invite that needs two-step setup signs out whoever was signed in', async () => {
  const accept = path.join(web, 'src/app/invite/invite-accept.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { InviteAccept } from ${JSON.stringify(accept)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(InviteAccept, { token: 'invite-token' })));`,
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
  try {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(6000);
    await tab.route('**/*', (route: any) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/invite') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      if (url.pathname === '/api/auth/me') {
        return json({ user: { id: 'user-b', name: 'B', email: 'b@example.test', timezone: 'UTC' }, org: { id: 'org', name: 'Org', slug: 'org' } });
      }
      if (url.pathname === '/api/invites/preview') {
        return json({ org_name: 'Org', org_slug: 'org', inviter_name: 'Owner', email: 'a@example.test', role: 'admin', already_accepted: false, expires_at: null });
      }
      if (url.pathname === '/api/invites/accept') {
        return json({ user: { id: 'user-a', name: 'A', email: 'a@example.test' }, org_id: 'org', two_step: { status: 'enrolment_required', token: 'tsc_enrol_only', expires_at: '' } });
      }
      return route.abort();
    });
    await tab.goto('http://127.0.0.1/invite');
    await tab.evaluate(({ access, refresh }: { access: string; refresh: string }) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', refresh);
    }, B);
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });
    await tab.getByPlaceholder('At least 8 characters').fill('a-long-password');
    await tab.getByRole('button', { name: 'Join Org' }).click();
    await tab.waitForFunction(() => (window as any).__pushed === '/two-step-setup');
    const after = await tab.evaluate(() => ({
      access: localStorage.getItem('deft-access-token'),
      refresh: localStorage.getItem('deft-refresh-token'),
      enrol: sessionStorage.getItem('deft-two-step-enrol-token'),
    }));
    assert.deepEqual(after, { access: null, refresh: null, enrol: 'tsc_enrol_only' });
  } finally {
    await browser.close();
  }
});
