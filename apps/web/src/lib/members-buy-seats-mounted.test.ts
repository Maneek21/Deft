import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real Members settings page inside the real AuthProvider, mounted in
// Chromium, with the API answered by page.route. The "Buy more seats" link
// shows where the API sends the seats page (the owner of a hosted workspace):
// next to "N of M paid seats in use" and on the invite refused for want of
// seats. An admin, and a self-hosted install, get no address and see no link.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};
const PAGE = 'https://control.test.invalid/seats';

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

type View = { role: 'owner' | 'admin'; hosted: boolean; buySeatsUrl: string | null };

async function linksFor(view: View) {
  const page = path.join(web, 'src/app/(app)/settings/members/page.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import MembersPage from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(MembersPage)));`,
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
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/settings/members') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      if (url.pathname === '/api/auth/me') {
        return json({ user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC', role: view.role }, org: { id: 'org', name: 'Org', slug: 'org' } });
      }
      if (url.pathname === '/api/members/directory') return json({ members: [], invites: [], summary: { active: 10, pending: 0, inactive: 0, agents: 0 } });
      if (url.pathname === '/api/members/seats') {
        return json({ hosted: view.hosted, seats_in_use: 10, seat_limit: view.hosted ? 10 : null, growth_frozen: false, frozen_reason: null, buy_seats_url: view.buySeatsUrl });
      }
      if (url.pathname === '/api/members/invite') {
        return json({
          error: 'All 10 paid seats are in use (10 people). Buy more seats to add someone.', code: 'SEAT_LIMIT_REACHED',
          seat_limit: 10, seats_in_use: 10, frozen_reason: null, ...(view.buySeatsUrl ? { buy_seats_url: view.buySeatsUrl } : {}),
        }, 409);
      }
      return route.abort();
    });
    await tab.goto('http://127.0.0.1/settings/members');
    await tab.evaluate((access: string) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', access);
    }, token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }));
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });

    if (view.hosted) await tab.getByText('10 of 10 paid seats in use', { exact: false }).waitFor();
    else await tab.getByRole('heading', { name: 'People' }).waitFor();
    const linkHrefs = async () => tab.getByRole('link', { name: 'Buy more seats' }).evaluateAll((links: HTMLAnchorElement[]) => links.map((a) => ({ href: a.href, target: a.target, rel: a.rel })));
    const onSeatLine = await linkHrefs();

    await tab.getByRole('button', { name: /Invite/ }).first().click();
    await tab.getByPlaceholder('name@company.com').fill('new@example.test');
    await tab.getByRole('button', { name: 'Generate' }).click();
    await tab.getByText('All 10 paid seats are in use', { exact: false }).last().waitFor();
    const afterRefusal = await linkHrefs();
    return { onSeatLine, afterRefusal };
  } finally {
    await browser.close();
  }
}

test('Members page: the hosted owner gets "Buy more seats" on the seat count and on the refused invite', async () => {
  const seen = await linksFor({ role: 'owner', hosted: true, buySeatsUrl: PAGE });
  const link = { href: PAGE, target: '_blank', rel: 'noopener noreferrer' };
  assert.deepEqual(seen.onSeatLine, [link]);
  assert.deepEqual(seen.afterRefusal, [link, link], 'the seat line and the refusal each have one');
});

test('Members page: an admin and a self-hosted owner see no link', async () => {
  assert.deepEqual(await linksFor({ role: 'admin', hosted: true, buySeatsUrl: null }), { onSeatLine: [], afterRefusal: [] });
  assert.deepEqual(await linksFor({ role: 'owner', hosted: false, buySeatsUrl: null }), { onSeatLine: [], afterRefusal: [] });
});
