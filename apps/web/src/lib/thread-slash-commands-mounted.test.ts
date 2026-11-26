import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A thread's composer (plan Task F16, fix round 3), the real ThreadPanel
// mounted in Chromium with the API stubbed. In a thread only `/note` is a
// command: it creates a document in My drive and sends no reply. Every other
// slash command (`/task x`) is posted as the reply it always was, and no
// document is created.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push(to) { (window.__pushed = window.__pushed || []).push(to); }, replace() {}, refresh() {}, back() {}, prefetch() {} }); export const useSearchParams = () => new URLSearchParams(window.location.search);',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

const src = (file: string) => JSON.stringify(path.join(web, 'src', file));
const ENTRY = `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from ${src('lib/auth-context.tsx')};
import { ThreadPanel } from ${src('components/thread-panel.tsx')};
const parent = { id: 'parent-1', content: 'The parent message', space_id: 'space-1', user_id: 'user-a', user_name: 'Ana', user_avatar: null,
  is_deleted: false, edited_at: null, created_at: '2026-11-26T10:00:00.000Z', reactions: [], metadata: {} };
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(ThreadPanel, { parentMessage: parent, spaceId: 'space-1', onClose: () => {} })));`;

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}
const TOKEN_A = token({ id: 'user-a', org_id: 'org', sid: 'session-a', jti: 'a1' });
const ME = {
  user: { id: 'user-a', name: 'Ana', email: 'user-a@example.test', timezone: 'UTC', role: 'member' },
  org: { id: 'org', name: 'Org', slug: 'org' },
};

let bundled: string | null = null;
async function bundle(): Promise<string> {
  if (bundled) return bundled;
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: web, loader: 'tsx' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    banner: { js: 'var process = { env: {} };' },
    jsx: 'automatic',
    loader: { '.css': 'empty' },
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
  bundled = result.outputFiles[0].text as string;
  return bundled;
}

let compiledCss: string | null = null;
async function css(): Promise<string> {
  if (compiledCss) return compiledCss;
  const sources = ['src/components/rich-composer.tsx', 'src/components/thread-panel.tsx']
    .map((source) => `@source "${path.join(web, source).replace(/\\/g, '/')}";`).join('\n');
  const result = await postcss([tailwind({ base: web })]).process(`@import "tailwindcss" source(none);\n${sources}\n`,
    { from: path.join(web, 'src/app/thread-slash-commands-test.css') });
  compiledCss = result.css as string;
  return compiledCss;
}

const PAGE = '<!doctype html><html><head></head><body style="margin:0"><div id="root"></div></body></html>';

type Calls = { replies: Array<{ content?: string }>; mine: number; documents: unknown[]; pushed: string[] };

/** Types `text` into the thread's composer, presses Send, and reports what the page asked the API for. */
async function submit(text: string, expectation: 'reply' | 'document'): Promise<Calls> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}),
  });
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    tab.setDefaultTimeout(6000);
    const calls: Calls = { replies: [], mine: 0, documents: [], pushed: [] };
    await tab.route('**/*', (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: PAGE });
      if (url.pathname === '/api/auth/me') return json(200, ME);
      if (url.pathname === '/api/messages/parent-1/thread') {
        return json(200, {
          parent: { id: 'parent-1', content: 'The parent message', space_id: 'space-1', user_id: 'user-a', user_name: 'Ana', user_avatar: null,
            is_deleted: false, edited_at: null, created_at: '2026-11-26T10:00:00.000Z', reactions: [], metadata: {} },
          replies: [],
        });
      }
      if (url.pathname === '/api/messages/parent-1/thread-read') return json(200, { success: true });
      if (url.pathname === '/api/agent/actions/pending-by-space') return json(200, []);
      if (url.pathname === '/api/messages/space-1' && request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}') as { content?: string };
        calls.replies.push(body);
        return json(201, { id: 'reply-1', content: body.content ?? '', space_id: 'space-1', parent_id: 'parent-1', user_id: 'user-a', user_name: 'Ana',
          user_avatar: null, is_deleted: false, edited_at: null, created_at: '2026-11-26T10:02:00.000Z', reactions: [], metadata: {} });
      }
      if (url.pathname === '/api/drives/mine' && request.method() === 'POST') { calls.mine += 1; return json(200, { drive: { id: 'drive-1' } }); }
      if (url.pathname === '/api/documents' && request.method() === 'POST') {
        calls.documents.push(JSON.parse(request.postData() ?? 'null'));
        return json(201, { document: { id: 'doc-new' } });
      }
      return route.abort();
    });
    await tab.goto('http://127.0.0.1/chat');
    await tab.evaluate(`localStorage.setItem('deft-access-token', ${JSON.stringify(TOKEN_A)}); localStorage.setItem('deft-refresh-token', ${JSON.stringify(TOKEN_A)});`);
    await tab.addStyleTag({ content: await css() });
    await tab.addScriptTag({ content: await bundle() });

    const editor = tab.locator('.ProseMirror');
    await editor.waitFor();
    await editor.click();
    await tab.keyboard.type(text);
    await tab.getByRole('button', { name: 'Send message from composer toolbar', exact: true }).dispatchEvent('click');
    if (expectation === 'reply') await tab.getByText(text).last().waitFor();
    else await tab.waitForFunction('(window.__pushed || []).length > 0');
    // Let any request that should not happen arrive before looking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    calls.pushed = await tab.evaluate('window.__pushed || []') as string[];
    return calls;
  } finally {
    await browser.close();
  }
}

test('/task x in a thread is posted as the reply it always was and creates no document', async () => {
  const calls = await submit('/task x', 'reply');
  assert.equal(calls.replies.length, 1, 'onSend posted one reply');
  assert.match(calls.replies[0]!.content ?? '', /\/task x/);
  assert.equal(calls.mine, 0);
  assert.deepEqual(calls.documents, []);
  assert.deepEqual(calls.pushed, []);
});

test('/note Title in a thread creates a document in My drive, opens it, and posts no reply', async () => {
  const calls = await submit('/note Title', 'document');
  assert.deepEqual(calls.documents, [{ drive_id: 'drive-1', title: 'Title' }]);
  assert.deepEqual(calls.pushed, ['/d/doc-new']);
  assert.deepEqual(calls.replies, []);
});
