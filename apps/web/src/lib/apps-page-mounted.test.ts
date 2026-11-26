import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The one Apps page, mounted in Chromium: every kind of file goes through the
// one "Upload an app" button and reaches its existing endpoint. The server is
// a small fake that answers the way the module and App routes do.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const fixture = JSON.parse(readFileSync(path.join(web, 'test/fixtures/email-app-connect-journey.json'), 'utf8')) as {
  package: string; answers: Record<string, { status: number; body: any }>;
};
const ORIGIN = 'http://127.0.0.1';

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useSearchParams = () => new URLSearchParams(window.location.search); export const useParams = () => ({}); export const notFound = () => { throw new Error("not found"); }; export const redirect = () => {}; export const useRouter = () => ({ push(u) { window.location.assign(u); }, replace(u) { window.location.replace(u); }, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
};

async function bundle(): Promise<string> {
  const entry = `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from ${JSON.stringify(path.join(web, 'src/lib/auth-context.tsx'))};
import { AppHeaderProvider } from ${JSON.stringify(path.join(web, 'src/components/app-header-context.tsx'))};
import { AppsClient } from ${JSON.stringify(path.join(web, 'src/app/(app)/settings/apps/apps-client.tsx'))};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(AppHeaderProvider, null, createElement(AppsClient, {}))));`;
  const result = await build({
    stdin: { contents: entry, resolveDir: web, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    banner: { js: 'var process = { env: {} };' }, loader: { '.css': 'empty' },
    alias: { '@/lib/socket': path.join(web, 'test/mounted/deft-socket.ts'), '@': path.join(web, 'src') },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(ORIGIN), 'process.env.NEXT_PUBLIC_FEATURE_APPS': '"true"' },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

const hiring = (version: string, extra: Record<string, unknown> = {}) => ({
  schema_version: '1', id: 'workspace.hiring', slug: 'hiring', version, name: 'Hiring pipeline',
  collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] }], ...extra,
});
const vendors = { schema_version: '1', id: 'workspace.vendors', slug: 'vendors', version: '1.0.0', name: 'Vendor tracker', collections: [{ key: 'vendors', name: 'Vendors', fields: [{ key: 'name', label: 'Name', type: 'text' }] }] };
const installation = (manifest: any, digest: string) => ({ id: `inst-${manifest.slug}`, slug: manifest.slug, module_id: manifest.id, source: 'sideloaded', enabled: true, agent_access: 'none', active_version_id: 'v', manifest_digest: digest, owning_app_installation_id: null, manifest });
const file = (name: string, value: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) });

test('Apps page: one upload button routes every file kind to its existing endpoint', { timeout: 180_000 }, async () => {
  const script = await bundle();
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  const state = { modules: [installation(hiring('1.0.0'), 'sha256:active')] as any[], pairing: false, upgradeAnswer: 200 };
  const calls: Array<{ method: string; path: string; body: string | null; ifMatch?: string }> = [];
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    tab.setDefaultTimeout(15_000);
    await tab.route('**/*', async (route: any) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
      const reply = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== ORIGIN) return route.abort();
      if (p === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (!p.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
      if (method !== 'GET') calls.push({ method, path: p, body: request.postData(), ifMatch: request.headers()['if-match'] });
      if (p === '/api/auth/me') return reply(200, fixture.answers.auth_me.body);
      if (p === '/api/modules' && method === 'GET') return reply(200, { modules: state.modules });
      if (p === '/api/modules/bundled') return reply(200, { modules: [{ slug: 'contacts', module_id: 'com.deft.contacts', name: 'Contacts', description: 'People and companies.', version: '1.0.0', icon: 'users', installed: false }] });
      if (p === '/api/apps' && method === 'GET') return reply(200, { apps: [], developer_pairing: { available: state.pairing } });
      if (p === '/api/modules/sideload') { const manifest = JSON.parse(request.postData()); state.modules.push(installation(manifest, 'sha256:vendors')); return reply(201, { module: state.modules.at(-1) }); }
      if (p === '/api/modules/hiring/upgrade') {
        if (state.upgradeAnswer === 409) return reply(409, { error: 'The active module schema changed before the update started.', code: 'MODULE_CONFLICT' });
        state.modules[0] = installation(JSON.parse(request.postData()), 'sha256:next'); return reply(200, { module: state.modules[0] });
      }
      if (p === '/api/modules/bundled/contacts/install') return reply(201, { module: {} });
      if (p === '/api/apps/inspect') return reply(fixture.answers.inspect.status, { ...fixture.answers.inspect.body, inspection: { ...fixture.answers.inspect.body.inspection, package: JSON.parse(fixture.package) } });
      return reply(404, { error: 'Not found', code: 'NOT_FOUND' });
    });
    await tab.goto(`${ORIGIN}/settings/apps`);
    const owner = fixture.answers.auth_me.body as { user: { id: string }; org: { id: string } };
    const access = `header.${Buffer.from(JSON.stringify({ id: owner.user.id, org_id: owner.org.id, sid: 's', jti: 'j' })).toString('base64url')}.signature`;
    await tab.evaluate((token: string) => { localStorage.setItem('deft-access-token', token); localStorage.setItem('deft-refresh-token', token); }, access);
    await tab.reload();

    // Both lists on one page; pairing off means no Pair Codex.
    const installedList = tab.getByLabel('Installed apps');
    await installedList.getByRole('heading', { name: 'Hiring pipeline' }).waitFor();
    await tab.getByRole('button', { name: 'Install Contacts' }).waitFor();
    assert.equal(await tab.getByRole('button', { name: 'Pair Codex' }).count(), 0);
    const input = tab.getByLabel('Choose an app file');

    // A new app file, under any name, installs through sideload.
    await input.setInputFiles(file('my-vendors.json', vendors));
    await tab.getByRole('button', { name: 'Install Vendor tracker' }).click();
    await tab.getByText('Vendor tracker is installed.').waitFor();
    assert.equal(calls.at(-1)?.path, '/api/modules/sideload');
    assert.equal(JSON.parse(calls.at(-1)!.body!).id, 'workspace.vendors');

    // A stale upgrade shows the server's words and how to recover.
    state.upgradeAnswer = 409;
    await input.setInputFiles(file('hiring.json', hiring('1.1.0')));
    await tab.getByRole('button', { name: 'Update to v1.1.0' }).click();
    await tab.getByText(/schema changed before the update started\. Refresh and try again\./).waitFor();

    // The same button upgrades an installed app, with its active digest.
    state.upgradeAnswer = 200;
    await input.setInputFiles(file('hiring.json', hiring('1.1.0')));
    await tab.getByRole('button', { name: 'Update to v1.1.0' }).click();
    await tab.getByText('Hiring pipeline is updated to v1.1.0. Every record was kept.').waitFor();
    assert.deepEqual({ path: calls.at(-1)?.path, ifMatch: calls.at(-1)?.ifMatch }, { path: '/api/modules/hiring/upgrade', ifMatch: 'sha256:active' });

    // An App Kit package goes to inspect.
    await input.setInputFiles(file('app.deftapp.json', fixture.package));
    await tab.getByRole('button', { name: /Stage/ }).waitFor().catch(async (error: Error) => { throw new Error(`${error.message}; on screen: ${(await tab.locator('[role=alert],[role=status]').allInnerTexts()).join(' | ')}`); });
    assert.equal(calls.at(-1)?.path, '/api/apps/inspect');
    await tab.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Wrong kinds never reach the server.
    const before = calls.length;
    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await tab.getByText('Choose a .json file.', { exact: false }).waitFor();
    await input.setInputFiles(file('broken.json', '{\n  "slug": "x",\n}'));
    await tab.getByText(/isn't valid JSON \(line 3/).waitFor();
    await input.setInputFiles(file('other.json', { hello: 'world' }));
    await tab.getByText("Deft can't tell what this file is.", { exact: false }).waitFor();
    assert.equal(calls.length, before);

    // Bundled apps install in one click.
    await tab.getByRole('button', { name: 'Install Contacts' }).click();
    await tab.getByText('Contacts is installed.').waitFor();
    assert.equal(calls.at(-1)?.path, '/api/modules/bundled/contacts/install');

    // Pairing reported as available shows Pair Codex.
    state.pairing = true;
    await tab.reload();
    await tab.getByRole('button', { name: 'Pair Codex' }).waitFor();
  } finally {
    await browser.close();
  }
});
