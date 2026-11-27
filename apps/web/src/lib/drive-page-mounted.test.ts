import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real /drive/[driveId] page inside the real AuthProvider, mounted in
// Chromium with the API mocked (plan Task F11, fix round 2):
// - a refused role change or removal keeps the server's message on screen even
//   when the re-read that follows it fails (the message and the load error
//   are separate);
// - after the caller removes themselves, or lowers themselves to view, the
//   re-reads decide what shows: removal leaves the no-access state with no
//   cached tree, trash or edit controls; a downgrade keeps the tree and drops
//   the edit controls, the trash and the members panel.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useParams = () => ({ driveId: "d1" }); export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
};

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

let bundled: string | null = null;
async function bundle(): Promise<string> {
  if (bundled) return bundled;
  const page = path.join(web, 'src/app/(app)/drive/[driveId]/page.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const result = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import DriveDetailPage from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(DriveDetailPage)));`,
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
        b.onResolve({ filter: /^next\/(navigation|link)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  bundled = result.outputFiles[0].text as string;
  return bundled;
}

type Mode = {
  /** Role the drive detail reports. */
  role: () => 'full' | 'view';
  /** True once the caller has lost access: drive, tree, trash and members answer 404. */
  gone: () => boolean;
  /** True once members must answer 500 (a failing re-read). */
  membersDown: () => boolean;
  onPatch: () => { status: number; body: unknown };
  onDelete: () => { status: number; body: unknown };
};

const MEMBERS = [
  { id: 'm-self', principal_type: 'user', principal_id: 'viewer', role: 'full', is_link: false, name: 'Viewer', added_by: null, created_at: '2026-11-26T00:00:00Z' },
  { id: 'm-pat', principal_type: 'user', principal_id: 'pat', role: 'edit', is_link: false, name: 'Pat', added_by: null, created_at: '2026-11-26T00:00:00Z' },
];

async function open(browser: any, mode: Mode) {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(6000);
  await tab.route('**/*', (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const send = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== 'http://127.0.0.1') return route.abort();
    if (url.pathname === '/drive/d1') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/auth/me') {
      return send(200, { user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC', role: 'member' }, org: { id: 'org', name: 'Org', slug: 'org' } });
    }
    const method = request.method();
    if (url.pathname === '/api/drives' && method === 'GET') {
      return send(200, { drives: [{ id: 'd1', name: 'Plans', icon: null, kind: 'private', system_key: null, role: mode.role(), default_role: null, frozen: false, pinned: false, admin_listed: false, is_member: true, is_mine: false, owner_name: null }] });
    }
    if (/^\/api\/drives\/d1\/members\/[^/]+$/.test(url.pathname)) {
      const r = method === 'PATCH' ? mode.onPatch() : mode.onDelete();
      return send(r.status, r.body);
    }
    if (url.pathname.startsWith('/api/drives/d1') && method === 'GET') {
      if (mode.gone()) return send(404, { error: 'Drive not found', code: 'NOT_FOUND' });
      if (url.pathname === '/api/drives/d1') return send(200, { drive: { id: 'd1', name: 'Plans', icon: null, kind: 'private', role: mode.role() } });
      if (url.pathname === '/api/drives/d1/tree') return send(200, { folders: [], documents: [{ id: 'doc1', title: 'Launch spec', icon: null, folder_id: null, parent_document_id: null, position: 0, updated_at: '2026-11-26T00:00:00Z' }] });
      if (url.pathname === '/api/drives/d1/trash') return send(200, { items: [{ id: 'old1', title: 'Old draft', icon: null, deleted_at: '2026-11-25T00:00:00Z' }] });
      if (url.pathname === '/api/drives/d1/members') {
        if (mode.membersDown()) return send(500, { error: 'Failed to list the drive’s members', code: 'INTERNAL_ERROR' });
        return send(200, { members: MEMBERS, admin_changes: [], admin_path: false });
      }
    }
    return route.abort();
  });
  await tab.goto('http://127.0.0.1/drive/d1');
  await tab.evaluate((access: string) => {
    localStorage.setItem('deft-access-token', access);
    localStorage.setItem('deft-refresh-token', access);
  }, token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }));
  await tab.addScriptTag({ content: await bundle() });
  await tab.getByText('Launch spec').waitFor();
  await tab.getByRole('heading', { name: 'Members' }).waitFor();
  return tab;
}

const launch = () => chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });

test('Drive page: a refused role change or removal keeps the server message even when the re-read fails', async () => {
  const browser = await launch();
  try {
    let mutated = false;
    const tab = await open(browser, {
      role: () => 'full', gone: () => false, membersDown: () => mutated,
      onPatch: () => { mutated = true; return { status: 403, body: { error: 'You need full access to this drive', code: 'FORBIDDEN_ROLE' } }; },
      onDelete: () => { mutated = true; return { status: 409, body: { error: 'The owner of a personal drive keeps full access to it', code: 'PERSONAL_DRIVE_OWNER' } }; },
    });
    await tab.getByLabel('Role for Pat').selectOption('view');
    await tab.getByText('You need full access to this drive').waitFor();
    await tab.getByText('Could not load the members').waitFor();
    assert.equal(await tab.getByText('You need full access to this drive').isVisible(), true, 'the refusal stays beside the load error');
    await tab.getByRole('button', { name: 'Remove' }).first().click();
    await tab.getByText('The owner of a personal drive keeps full access to it').waitFor();
    await tab.getByText('Could not load the members').waitFor();
    await tab.close();
  } finally {
    await browser.close();
  }
});

test('Drive page: after removing themselves the caller sees no access and no cached tree, trash or edit controls', async () => {
  const browser = await launch();
  try {
    let removed = false;
    const tab = await open(browser, {
      role: () => 'full', gone: () => removed, membersDown: () => false,
      onPatch: () => ({ status: 200, body: {} }),
      onDelete: () => { removed = true; return { status: 200, body: { success: true } }; },
    });
    assert.equal(await tab.getByRole('button', { name: 'New document' }).count(), 1, 'editor controls before');
    assert.equal(await tab.getByText('Old draft').count(), 1, 'trash before');
    await tab.getByRole('button', { name: 'Remove' }).first().click();
    await tab.getByText(/You no longer have access to this drive/).waitFor();
    assert.equal(await tab.getByText('Launch spec').count(), 0, 'the cached tree is gone');
    assert.equal(await tab.getByText('Old draft').count(), 0, 'the cached trash is gone');
    assert.equal(await tab.getByRole('button', { name: 'New document' }).count(), 0, 'the edit controls are gone');
    assert.equal(await tab.getByRole('heading', { name: 'Members' }).count(), 0, 'and the members panel');
    await tab.close();
  } finally {
    await browser.close();
  }
});

test('Drive page: after lowering themselves to view the caller keeps the tree and loses the edit controls, trash and members', async () => {
  const browser = await launch();
  try {
    let lowered = false;
    const tab = await open(browser, {
      role: () => (lowered ? 'view' : 'full'), gone: () => false, membersDown: () => false,
      onPatch: () => { lowered = true; return { status: 200, body: {} }; },
      onDelete: () => ({ status: 200, body: {} }),
    });
    await tab.getByLabel('Role for Viewer').selectOption('view');
    await tab.getByRole('heading', { name: 'Members' }).waitFor({ state: 'detached' });
    assert.equal(await tab.getByText('Launch spec').count(), 1, 'a viewer still reads the tree');
    assert.equal(await tab.getByRole('button', { name: 'New document' }).count(), 0, 'no edit controls');
    assert.equal(await tab.getByText('Old draft').count(), 0, 'no trash');
    await tab.close();
  } finally {
    await browser.close();
  }
});
