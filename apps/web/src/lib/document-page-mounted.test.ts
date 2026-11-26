import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Y from 'yjs';

// The real /d/[documentId] page inside the real AuthProvider, mounted in
// Chromium with the API mocked and the app's Tailwind utilities, at a phone
// width (390 px) and a desktop width (1280 px) (plan Task F12). Where live
// editing is on, the test plays F7's /collab server over Playwright's
// WebSocket routing: it authenticates the provider, sends the document's Yjs
// state, awareness states and later updates, or closes with F7's codes.
// - With live editing off (`live: false`), the page renders content_json
//   read-only, with no editor toolbar and nothing past the viewport.
// - The history panel lists F8's versions (a side panel on a desktop, a
//   bottom sheet on a phone); a restore answered 503 says "Busy, try again".
// - Presence and carets name people by user id through the members list (the
//   people rule): a guest sees "A collaborator" for someone they share no
//   chat with, and never their id.
// - A 403 or 404 on the read-only copy's own request ends the page: nothing
//   cached stays on screen (rule C4).
// - An editor uploads images through POST /api/upload?document_id= (toolbar
//   and paste); a viewer has no upload control.
// - A new image a viewer gets 404 for shows "Image is loading" and appears
//   once the document updates and the file answers; changes every 300 ms
//   never make it fetch more often than its backoff steps allow.
// - While the workspace is paused the title can't be edited; the share
//   dialog says which later pages need a fresh share.
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
  // next/dynamic is React.lazy with Suspense (Next's own description); the stub is that.
  'next/dynamic': "import { createElement, lazy, Suspense } from 'react'; export default function dynamic(load, options = {}) { const Lazy = lazy(() => load().then((m) => ({ default: m && m.default ? m.default : m }))); return function Dynamic(props) { return createElement(Suspense, { fallback: options.loading ? createElement(options.loading) : null }, createElement(Lazy, props)); }; }",
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
        b.onResolve({ filter: /^next\/(navigation|link|dynamic)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
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

// --- Hocuspocus frames (lib0 encoding), for playing the /collab server ---

function varUint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
function concat(...parts: Array<number[] | Uint8Array>): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}
const varBytes = (bytes: Uint8Array) => concat(varUint(bytes.length), bytes);
const varString = (s: string) => varBytes(new TextEncoder().encode(s));
function readVarUint(bytes: Uint8Array, at: { pos: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at.pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return value;
    shift += 7;
  }
}
function readVarString(bytes: Uint8Array, at: { pos: number }): string {
  const length = readVarUint(bytes, at);
  const text = new TextDecoder().decode(bytes.subarray(at.pos, at.pos + length));
  at.pos += length;
  return text;
}
const frames = {
  authenticated: (name: string, scope: 'read-write' | 'readonly') => concat(varString(name), [2], [2], varString(scope)),
  syncStep2: (name: string, update: Uint8Array) => concat(varString(name), [0], [1], varBytes(update)),
  update: (name: string, update: Uint8Array) => concat(varString(name), [0], [2], varBytes(update)),
  awareness: (name: string, states: Array<{ clientId: number; clock: number; state: unknown }>) => concat(varString(name), [1],
    varBytes(concat(varUint(states.length), ...states.flatMap((s) => [Buffer.from(varUint(s.clientId)), Buffer.from(varUint(s.clock)), varString(JSON.stringify(s.state))])))),
};

/** The server's copy of the document: a paragraph per text, then an image when `imageFileId` is set. */
function serverDoc(texts: string | string[], imageFileId?: string) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const yTexts = (Array.isArray(texts) ? texts : [texts]).map((text) => {
    const paragraph = new Y.XmlElement('paragraph');
    const yText = new Y.XmlText();
    yText.insert(0, text);
    paragraph.insert(0, [yText]);
    fragment.insert(fragment.length, [paragraph]);
    return yText;
  });
  if (imageFileId) {
    const image = new Y.XmlElement('image');
    image.setAttribute('fileId', imageFileId);
    image.setAttribute('alt', 'Chart');
    fragment.insert(fragment.length, [image]);
  }
  return { doc, fragment, yTexts };
}

type Collab =
  | { mode: 'close'; code: number; reason: string }
  | { mode: 'sync'; doc: Y.Doc; scope?: 'read-write' | 'readonly'; awareness?: () => Array<{ clientId: number; clock: number; state: unknown }> };

/**
 * Plays /collab for one tab: closes with a code, or authenticates, sends the
 * document on the first sync step, then the awareness states (again a little
 * later, after the editor is up), and every later change to `doc`.
 */
async function playCollab(tab: any, collab: Collab) {
  const sockets: any[] = [];
  await tab.routeWebSocket(/\/collab$/, (ws: any) => {
    sockets.push(ws);
    const name = 'doc:doc1';
    if (collab.mode === 'close') {
      ws.close({ code: collab.code, reason: collab.reason });
      return;
    }
    const onUpdate = (update: Uint8Array, origin: unknown) => { if (origin !== ws) ws.send(frames.update(name, update)); };
    collab.doc.on('update', onUpdate);
    ws.onClose(() => collab.doc.off('update', onUpdate));
    const sendAwareness = () => { const states = collab.awareness?.(); if (states?.length) ws.send(frames.awareness(name, states)); };
    ws.onMessage((message: string | Buffer) => {
      if (typeof message === 'string') return;
      const bytes = new Uint8Array(message);
      const at = { pos: 0 };
      readVarString(bytes, at);
      const type = readVarUint(bytes, at);
      if (type === 2) ws.send(frames.authenticated(name, collab.scope ?? 'read-write'));
      if (type !== 0) return;
      const step = readVarUint(bytes, at);
      if (step === 0) {
        ws.send(frames.syncStep2(name, Y.encodeStateAsUpdate(collab.doc)));
        sendAwareness();
        setTimeout(sendAwareness, 600);
        setTimeout(sendAwareness, 1500);
      } else if (collab.scope !== 'readonly') {
        // The client's own changes (sync step 2 or an update) land on the server's copy.
        const length = readVarUint(bytes, at);
        Y.applyUpdate(collab.doc, bytes.subarray(at.pos, at.pos + length), ws);
      }
    });
  });
  return sockets;
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

const MEMBERS = [{ id: 'u-ana', name: 'Ana Rao', kind: 'human', avatar_url: null }, { id: 'viewer', name: 'Viewer', kind: 'human', avatar_url: null }];

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

type Reply = { status: number; body?: unknown; bytes?: Buffer; contentType?: string };
type Options = {
  document?: Record<string, unknown>;
  members?: unknown[];
  collab?: Collab;
  /** GET /api/documents/doc1?content=1. */
  content?: () => Reply;
  /** POST /api/upload (full URL). */
  upload?: (url: URL) => Reply;
  /** GET /api/files/:id. */
  file?: (id: string) => Reply;
  /** Text to wait for before the test starts. */
  ready?: string;
};

async function open(browser: any, width: number, options: Options = {}) {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  tab.setDefaultTimeout(8000);
  const errors: string[] = [];
  tab.on('pageerror', (error: Error) => errors.push(error.message));
  if (process.env.DEFT_TEST_PAGE_LOG) {
    tab.on('pageerror', (error: Error) => console.log('[pageerror]', error.message));
    tab.on('console', (message: any) => console.log(`[console.${message.type()}]`, message.text()));
    tab.on('request', (request: any) => console.log('[request]', request.method(), request.url()));
  }
  const restores: string[] = [];
  const document = { ...DOCUMENT, ...options.document };
  await tab.route('**/*', async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const reply = (r: Reply) => r.bytes
      ? route.fulfill({ status: r.status, contentType: r.contentType ?? 'image/png', body: r.bytes })
      : route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/d/doc1') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>' });
    if (url.pathname === '/api/auth/me') {
      return send(200, { user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC', role: 'member' }, org: { id: 'org', name: 'Org', slug: 'org' } });
    }
    if (url.pathname === '/api/documents/doc1' && method === 'GET') {
      if (url.searchParams.get('content') === '1' && options.content) return reply(options.content());
      return send(200, { document });
    }
    if (url.pathname === '/api/members' && method === 'GET') return send(200, options.members ?? MEMBERS);
    if (url.pathname === '/api/spaces' && method === 'GET') return send(200, []);
    if (url.pathname === '/api/documents/doc1/shares' && method === 'GET') return send(200, { shares: [] });
    if (url.pathname === '/api/documents/doc1/versions' && method === 'GET') return send(200, { versions: VERSIONS, next_before: null });
    const restore = /^\/api\/documents\/doc1\/versions\/([^/]+)\/restore$/.exec(url.pathname);
    if (restore && method === 'POST') {
      restores.push(restore[1]!);
      return send(503, { error: 'Live editing can’t take this change right now', code: 'BUSY' }, { 'Retry-After': '5' });
    }
    if (url.pathname === '/api/upload' && method === 'POST' && options.upload) return reply(options.upload(url));
    const file = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    if (file && method === 'GET' && options.file) return reply(options.file(decodeURIComponent(file[1]!)));
    return route.abort();
  });
  const sockets = options.collab ? await playCollab(tab, options.collab) : [];
  await tab.goto(`${ORIGIN}/d/doc1`);
  await tab.evaluate((access: string) => {
    localStorage.setItem('deft-access-token', access);
    localStorage.setItem('deft-refresh-token', access);
  }, token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }));
  const { js, css } = await bundle();
  await tab.addStyleTag({ content: css });
  await tab.addScriptTag({ content: js });
  await tab.getByText(options.ready ?? 'Ship the checkout redesign.').waitFor();
  return { tab, errors, restores, sockets };
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

test('mounted: a guest sees "A collaborator" in carets and avatars for someone they share no chat with, and the real name for someone they do', async () => {
  const browser = await launch();
  try {
    // Carets sit in the second paragraph, so their labels never split the first (the text the test waits for).
    const { doc, yTexts } = serverDoc(['Shared spec for the launch', 'Where the carets are: one, two, three, four, five']);
    const at = (index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(yTexts[1]!, index));
    // Each send is a newer state with the carets one step on, as when people type.
    let clock = 0;
    const { tab, errors } = await open(browser, 1280, {
      document: { live: true, role: 'view', content_json: undefined },
      // The guest's members list holds only people they share a chat with.
      members: [{ id: 'viewer', name: 'Viewer', kind: 'human' }, { id: 'u-shared', name: 'Sam Lee', kind: 'human' }],
      collab: {
        mode: 'sync', doc, scope: 'readonly',
        awareness: () => {
          clock += 1;
          return [
            { clientId: 501, clock, state: { user: { id: 'u-shared', color: '#2563eb' }, cursor: { anchor: at(2 + clock), head: at(2 + clock) } } },
            { clientId: 502, clock, state: { user: { id: 'u-hidden', color: '#db2777' }, cursor: { anchor: at(8 + clock), head: at(8 + clock) } } },
          ];
        },
      },
      ready: 'Shared spec for the launch',
    });
    const avatars = tab.locator('[aria-label="People here now"] [title]');
    await tab.locator('[aria-label="People here now"] [title="A collaborator"]').waitFor();
    assert.deepEqual((await avatars.evaluateAll((els: Element[]) => els.map((el) => el.getAttribute('title')))).sort(), ['A collaborator', 'Sam Lee']);
    const carets = tab.locator('[data-document-caret]');
    await tab.locator('[data-document-caret]', { hasText: 'A collaborator' }).waitFor();
    assert.deepEqual((await carets.allTextContents()).sort(), ['A collaborator', 'Sam Lee']);
    assert.doesNotMatch(await tab.content(), /u-hidden/, 'a hidden person\'s id never reaches the page');
    // A viewer has no upload control (and no toolbar at all).
    assert.equal(await tab.locator('[data-testid="document-toolbar"]').count(), 0);
    assert.equal(await tab.getByRole('button', { name: 'Image' }).count(), 0);
    assert.deepEqual(errors, []);
    await tab.close();
  } finally {
    await browser.close();
  }
});

test('mounted: a 403 or 404 on the read-only copy ends the page: nothing cached stays and the live session closes', async () => {
  const browser = await launch();
  try {
    for (const status of [403, 404]) {
      let lost = false;
      const { tab, sockets } = await open(browser, 390, {
        document: { live: true, content_json: undefined },
        collab: { mode: 'close', code: 4503, reason: 'paused' },
        content: () => (lost ? { status, body: { error: 'Document not found', code: 'NOT_FOUND' } } : { status: 200, body: { document: { ...DOCUMENT, live: true } } }),
      });
      await tab.getByText('This workspace is paused.').waitFor();
      lost = true;
      // SWR 2.5 re-reads on focus only 5 s after a key mounts (focusThrottleInterval).
      await tab.waitForTimeout(5500);
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      await tab.getByText('You no longer have access to this document.').waitFor();
      assert.equal(await tab.getByText('Ship the checkout redesign.').count(), 0, `${status}: the cached copy is gone`);
      assert.equal(await tab.locator('.ProseMirror').count(), 0, `${status}: no document body`);
      assert.equal(await tab.getByRole('button', { name: 'History' }).count(), 0, `${status}: no header actions`);
      assert.equal(sockets.length, 1, `${status}: no further live connection`);
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('mounted: an editor uploads images with POST /api/upload?document_id= from the toolbar and by pasting', async () => {
  const browser = await launch();
  try {
    const { doc } = serverDoc('Spec with pictures');
    const uploads: string[] = [];
    const { tab, errors } = await open(browser, 1280, {
      document: { live: true, content_json: undefined },
      collab: { mode: 'sync', doc },
      upload: (url) => {
        uploads.push(url.search);
        const id = `f-up-${uploads.length}`;
        return { status: 201, body: { id, name: 'chart.png', type: 'image/png', size: PNG.length, url: `/api/files/${id}` } };
      },
      file: () => ({ status: 200, bytes: PNG }),
      ready: 'Spec with pictures',
    });
    await tab.getByText('Spec with pictures').click();
    const chooser = tab.waitForEvent('filechooser');
    await tab.getByRole('button', { name: 'Image' }).click();
    await (await chooser).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
    await tab.locator('[data-document-image] img').first().waitFor();
    await tab.evaluate((bytes: number[]) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
      document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...PNG]);
    await tab.waitForFunction(() => document.querySelectorAll('[data-document-image] img').length === 2);
    assert.deepEqual(uploads, ['?document_id=doc1', '?document_id=doc1'], 'each upload names the document');
    // The images went into the shared document, by file id.
    const imageIds = () => (doc.getXmlFragment('default').toArray() as Y.XmlElement[])
      .filter((node) => node.nodeName === 'image').map((node) => node.getAttribute('fileId')).sort();
    for (let waited = 0; waited < 3000 && imageIds().length < 2; waited += 50) await tab.waitForTimeout(50);
    assert.deepEqual(imageIds(), ['f-up-1', 'f-up-2']);
    assert.deepEqual(errors, []);
    await tab.close();
  } finally {
    await browser.close();
  }
});

test('mounted: a new image that answers 404 shows "Image is loading", then appears when the document updates and the file answers', async () => {
  const browser = await launch();
  try {
    const { doc, fragment } = serverDoc('Spec with a fresh chart', 'f-new');
    let ready = false;
    const fetches: number[] = [];
    const { tab, errors } = await open(browser, 1280, {
      document: { live: true, role: 'view', content_json: undefined },
      collab: { mode: 'sync', doc, scope: 'readonly' },
      file: () => { fetches.push(ready ? 200 : 404); return ready ? { status: 200, bytes: PNG } : { status: 404, body: { error: 'File not found', code: 'NOT_FOUND' } }; },
      ready: 'Spec with a fresh chart',
    });
    await tab.getByText('Image is loading').waitFor();
    assert.equal(await tab.getByText('Image not available').count(), 0, 'a 404 is not taken as broken at once');
    // The store confirms the image; the next change to the document brings the retry.
    ready = true;
    const later = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'A later edit');
    later.insert(0, [text]);
    fragment.insert(fragment.length, [later]);
    await tab.getByText('A later edit').waitFor();
    await tab.locator('[data-document-image] img').waitFor({ timeout: 2500 });
    assert.equal(await tab.getByText('Image is loading').count(), 0);
    assert.ok(fetches[0] === 404 && fetches[fetches.length - 1] === 200, `fetches: ${fetches.join(', ')}`);
    assert.deepEqual(errors, []);
    await tab.close();
  } finally {
    await browser.close();
  }
});

test('mounted: document changes every 300 ms while a new image keeps answering 404 stay within the retry backoff', async () => {
  const browser = await launch();
  try {
    const { doc, yTexts } = serverDoc('Spec with a chart nobody can load yet', 'f-gone');
    const requests: number[] = [];
    const { tab, errors } = await open(browser, 1280, {
      document: { live: true, role: 'view', content_json: undefined },
      collab: { mode: 'sync', doc, scope: 'readonly' },
      file: () => { requests.push(Date.now()); return { status: 404, body: { error: 'File not found', code: 'NOT_FOUND' } }; },
      ready: 'Spec with a chart nobody can load yet',
    });
    await tab.getByText('Image is loading').waitFor();
    // Someone types: a change every 300 ms for about 6.6 s, each one reaching the viewer.
    for (let i = 0; i < 22; i += 1) {
      yTexts[0]!.insert(yTexts[0]!.length, '.');
      await tab.waitForTimeout(300);
    }
    const first = requests[0]!;
    const at = requests.map((t) => t - first);
    const gaps = requests.slice(1).map((t, i) => t - requests[i]!);
    // The steps are 1.5 s, 3 s, 6 s (the least time between two requests): over ~6.6 s that is
    // requests at about 0, 1.5 and 4.5 s. Without the shared backoff it was one every ~300 ms.
    assert.ok(requests.length >= 2 && requests.length <= 4, `requests at ${at.join(', ')} ms`);
    assert.ok(gaps.every((gap) => gap >= 1_400), `no two requests closer than the first step: gaps ${gaps.join(', ')} ms`);
    // A change brings a retry forward once its step has passed: the second came at the first step, before the 3 s timer.
    assert.ok(gaps[0]! < 2_800, `the second request came after ${gaps[0]} ms`);
    assert.equal(await tab.getByText('Image not available').count(), 0, 'still waiting within the 90 s');
    await tab.getByText('Image is loading').waitFor();
    assert.deepEqual(errors, []);
    await tab.close();
  } finally {
    await browser.close();
  }
});

test('mounted: while the workspace is paused the title can\'t be edited, and the share dialog says which later pages need a fresh share', async () => {
  const browser = await launch();
  try {
    const { tab, errors } = await open(browser, 1280, {
      document: { live: true, content_json: undefined },
      collab: { mode: 'close', code: 4503, reason: 'paused' },
      content: () => ({ status: 200, body: { document: { ...DOCUMENT, live: true } } }),
    });
    await tab.getByText('This workspace is paused.').waitFor();
    assert.equal(await tab.getByLabel('Document title').count(), 0, 'no title field while paused');
    await tab.getByRole('heading', { name: 'Launch spec' }).waitFor();
    await tab.getByRole('button', { name: 'Share' }).click();
    // Created sub-pages copy the page's shares (F5/F9, tested in document-shares-http-db); pages moved in later don't.
    await tab.getByRole('dialog').getByText(/A page moved under this one later doesn’t get them/).waitFor();
    assert.deepEqual(errors, []);
    await tab.close();
  } finally {
    await browser.close();
  }
});
