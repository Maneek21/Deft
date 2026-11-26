import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real /d/[documentId] page inside the real AuthProvider, mounted in
// Chromium with the API mocked and the app's Tailwind utilities, at a phone
// width (390 px) and a desktop width (1280 px) (plan Task F12):
// - with live editing off (`live: false`), the page renders the document's
//   content_json read-only, with no editor toolbar and nothing past the
//   viewport;
// - the history panel lists F8's versions (a side panel on a desktop, a
//   bottom sheet on a phone), and a restore the writer can't take now
//   (503 BUSY) says "Busy, try again".
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

const ORIGIN = 'http://127.0.0.1';

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useParams = () => ({ documentId: "doc1" }); export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }); export const useSearchParams = () => new URLSearchParams(window.location.search);',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
};

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

let bundled: { js: string; css: string } | null = null;
async function bundle(): Promise<{ js: string; css: string }> {
  if (bundled) return bundled;
  const page = path.join(web, 'src/app/(app)/d/[documentId]/page.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const result = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import DocumentRoute from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(DocumentRoute)));`,
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
      'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(ORIGIN),
      'process.env.NEXT_PUBLIC_WS_URL': JSON.stringify(ORIGIN),
    },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  // The app's Tailwind utilities, generated for the document page's own files.
  const sources = ['src/components/documents', 'src/app/(app)/d', 'src/lib/editor', 'src/components/overlay-primitives.tsx']
    .map((source) => `@source "${path.join(web, source).replace(/\\/g, '/')}";`).join('\n');
  const css = await postcss([tailwind({ base: web })]).process(`@import "tailwindcss" source(none);\n${sources}\n`,
    { from: path.join(web, 'src/app/document-page-test.css') });
  bundled = { js: result.outputFiles[0].text as string, css: css.css as string };
  return bundled;
}

const CONTENT = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'b1', level: 2 }, content: [{ type: 'text', text: 'Goals' }] },
    { type: 'paragraph', attrs: { id: 'b2' }, content: [{ type: 'text', text: 'Ship the checkout redesign.' }] },
  ],
};

const DOCUMENT = {
  id: 'doc1',
  title: 'Launch spec',
  icon: null,
  drive: { id: 'd1', name: 'Engineering', kind: 'open' },
  folder_id: null,
  parent_document_id: null,
  breadcrumb: [{ type: 'drive', id: 'd1', title: 'Engineering' }, { type: 'document', id: 'doc1', title: 'Launch spec' }],
  role: 'edit',
  last_edited_by: 'u-ana',
  last_edited_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  is_template: false,
  live: false,
  content_json: CONTENT,
};

const VERSIONS = [
  { id: 'v-named', kind: 'named', name: 'Sent to client, v2', title: 'Launch spec', created_by: 'u-ana', agent_user_id: null, created_at: new Date(Date.now() - 60 * 60_000).toISOString(), size_bytes: 812 },
  { id: 'v-auto', kind: 'auto', name: null, title: 'Launch spec', created_by: 'u-ana', agent_user_id: null, created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), size_bytes: 640 },
];

async function open(browser: any, width: number) {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  tab.setDefaultTimeout(8000);
  const errors: string[] = [];
  tab.on('pageerror', (error: Error) => errors.push(error.message));
  const restores: string[] = [];
  await tab.route('**/*', (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/d/doc1') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>' });
    if (url.pathname === '/api/auth/me') {
      return send(200, { user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC', role: 'member' }, org: { id: 'org', name: 'Org', slug: 'org' } });
    }
    if (url.pathname === '/api/documents/doc1' && method === 'GET') return send(200, { document: DOCUMENT });
    if (url.pathname === '/api/members' && method === 'GET') {
      return send(200, [{ id: 'u-ana', name: 'Ana Rao', kind: 'human', avatar_url: null }, { id: 'viewer', name: 'Viewer', kind: 'human', avatar_url: null }]);
    }
    if (url.pathname === '/api/documents/doc1/versions' && method === 'GET') return send(200, { versions: VERSIONS, next_before: null });
    const restore = /^\/api\/documents\/doc1\/versions\/([^/]+)\/restore$/.exec(url.pathname);
    if (restore && method === 'POST') {
      restores.push(restore[1]!);
      return send(503, { error: 'Live editing can’t take this change right now', code: 'BUSY' }, { 'Retry-After': '5' });
    }
    return route.abort();
  });
  await tab.goto(`${ORIGIN}/d/doc1`);
  await tab.evaluate((access: string) => {
    localStorage.setItem('deft-access-token', access);
    localStorage.setItem('deft-refresh-token', access);
  }, token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }));
  const { js, css } = await bundle();
  await tab.addStyleTag({ content: css });
  await tab.addScriptTag({ content: js });
  await tab.getByText('Ship the checkout redesign.').waitFor();
  return { tab, errors, restores };
}

const launch = () => chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });

/** Whether an element sits inside the viewport's width. */
async function inside(tab: any, locator: any): Promise<boolean> {
  const box = await locator.boundingBox();
  const viewport = await tab.evaluate(() => window.innerWidth);
  return !!box && box.x >= 0 && box.x + box.width <= viewport + 0.5;
}

test('mounted: with live false, the page renders content_json read-only with no editor toolbar (390 px and 1280 px)', async () => {
  const browser = await launch();
  try {
    for (const width of [390, 1280]) {
      const { tab, errors } = await open(browser, width);
      await tab.getByText('Goals').waitFor();
      const editor = tab.locator('.ProseMirror');
      assert.equal(await editor.count(), 1, `${width}: one document body`);
      assert.equal(await editor.getAttribute('contenteditable'), 'false', `${width}: read-only`);
      assert.equal(await tab.locator('[data-testid="document-toolbar"]').count(), 0, `${width}: no editor toolbar`);
      await tab.getByText('Live editing is off. This is a read-only copy.').waitFor();
      await tab.getByText(/Edited 5m ago by Ana Rao/).waitFor();
      assert.equal(await tab.getByLabel('Document title').inputValue(), 'Launch spec', `${width}: the title`);
      for (const name of ['History', 'Share', 'More actions']) {
        const button = tab.getByRole('button', { name });
        assert.equal(await inside(tab, button), true, `${width}: ${name} is on screen`);
      }
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width}: nothing past the viewport (overflow ${overflow}px)`);
      assert.deepEqual(errors, [], `${width}: no page errors`);
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('mounted: History lists the versions (side panel on a desktop, bottom sheet on a phone) and a busy restore says "Busy, try again"', async () => {
  const browser = await launch();
  try {
    for (const width of [1280, 390]) {
      const { tab, errors, restores } = await open(browser, width);
      await tab.getByRole('button', { name: 'History' }).click();
      const panel = width < 768 ? tab.getByRole('dialog') : tab.getByRole('complementary', { name: 'Document panel' });
      await panel.getByText('Sent to client, v2').waitFor();
      await panel.getByText('Automatic save').waitFor();
      assert.equal(await panel.getByText(/by Ana Rao/).count(), 2, `${width}: each version names who made it`);
      assert.equal(await inside(tab, panel), true, `${width}: the panel is on screen`);
      await panel.getByRole('button', { name: 'Restore Automatic save' }).click();
      await panel.getByRole('button', { name: 'Yes, restore' }).click();
      await panel.getByText('Busy, try again').waitFor();
      assert.deepEqual(restores, ['v-auto'], `${width}: one restore of the version chosen`);
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width}: nothing past the viewport (overflow ${overflow}px)`);
      assert.deepEqual(errors, [], `${width}: no page errors`);
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});
