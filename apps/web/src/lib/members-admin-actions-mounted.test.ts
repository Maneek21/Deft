import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real Members settings page inside the real AuthProvider, mounted in
// Chromium, viewed by an admin who is not the owner. Only the owner manages a
// PERSON who is an owner or admin; agents are outside that rule, so an admin
// still sees Recovery link, the role control and Remove for an admin agent,
// as before. For an admin person they are hidden; the owner sees them.
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

const stats = { spaces: 0, assigned_tasks_open: 0, assigned_tasks_total: 0, led_projects: 0, wiki_pages: 0, active_mcp_tokens: 0, active_api_keys: 0, active_oauth_grants: 0 };
function member(id: string, name: string, kind: 'human' | 'agent', role: string) {
  return {
    id, name, email: kind === 'human' ? `${id}@example.test` : null, kind, avatar_url: null, title: null, profile_summary: null,
    expertise_tags: [], timezone: 'UTC', status_emoji: null, status_text: null, last_seen_at: null, email_verified: true,
    role, is_active: true, joined_at: null, lifecycle_status: 'active', pending_invite_id: null, pending_invite_expires_at: null,
    stats,
    agent: kind === 'agent' ? { id: `emp-${id}`, name, role: 'project_manager', trust_level: 'standard', runtime_kind: 'custom', certification_status: null, is_active: true, unhealthy: false, last_mcp_call_at: null, last_heartbeat_at: null } : null,
  };
}
const MEMBERS = [member('admin-agent', 'Admin Agent', 'agent', 'admin'), member('admin-person', 'Admin Person', 'human', 'admin')];

async function controlsFor(viewerRole: 'admin' | 'owner') {
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
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/settings/members') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      if (url.pathname === '/api/auth/me') {
        return json({ user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC', role: viewerRole }, org: { id: 'org', name: 'Org', slug: 'org' } });
      }
      if (url.pathname === '/api/members/directory') return json({ members: MEMBERS, invites: [], summary: { active: 2, pending: 0, inactive: 0, agents: 1 } });
      if (url.pathname === '/api/members/seats') return json({ hosted: false });
      const detail = /^\/api\/members\/([^/]+)\/detail$/.exec(url.pathname);
      if (detail) {
        return json({ member: MEMBERS.find((m) => m.id === detail[1]), spaces: [], open_tasks: [], led_projects: [], pending_invites: [], mcp_tokens: [], oauth_grants: [] });
      }
      return route.abort();
    });
    await tab.goto('http://127.0.0.1/settings/members');
    await tab.evaluate((access: string) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', access);
    }, token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }));
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });

    const seen: Record<string, { recovery: boolean; role: boolean; remove: boolean }> = {};
    for (const m of MEMBERS) {
      await tab.getByRole('button', { name: new RegExp(m.name) }).first().click();
      await tab.getByText(`Admin actions`).waitFor();
      await tab.waitForFunction((name: string) => Array.from(document.querySelectorAll('p,h2,h3')).some((el) => el.textContent?.trim() === name), m.name);
      const panel = tab.locator('div.rounded-md', { hasText: 'Admin actions' }).last();
      seen[m.id] = {
        recovery: await panel.getByRole('button', { name: 'Recovery link' }).count() > 0,
        role: await panel.getByRole('button', { name: 'Admin' }).count() > 0,
        remove: await panel.getByRole('button', { name: 'Remove' }).count() > 0,
      };
    }
    return seen;
  } finally {
    await browser.close();
  }
}

test('Members page: an admin manages an admin agent as before, but not an admin person', async () => {
  const all = { recovery: true, role: true, remove: true };
  const none = { recovery: false, role: false, remove: false };
  assert.deepEqual(await controlsFor('admin'), { 'admin-agent': all, 'admin-person': none });
  assert.deepEqual(await controlsFor('owner'), { 'admin-agent': all, 'admin-person': all });
});
