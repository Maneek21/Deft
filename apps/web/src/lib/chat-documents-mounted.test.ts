import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Documents in chat (plan Task F13), mounted in Chromium.
// - With the app's Tailwind utilities, at a phone width (375 px) and a
//   desktop width (1280 px): a document card, the card a viewer who can't
//   open the document sees, and the posting prompt. Nothing may overflow the
//   viewport, a long title is cut short inside its card, and the prompt's
//   controls stay on screen. Share sends F9's POST /api/documents/:id/shares
//   for the chat at the role chosen; "Don't share" only closes the prompt.
// - Inside the real AuthProvider: when one person signs out and another
//   signs in in the same tab, the second never sees the first's card title,
//   not even before their own cards arrive (rule C4; fix round 1, I1).
// - The thread panel shows the document cards of the thread's parent and of
//   its replies (I3).
// - The composer can't schedule a message while documents are attached
//   (scheduled messages don't carry them yet).
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }); export const useSearchParams = () => new URLSearchParams(window.location.search);',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

const src = (file: string) => JSON.stringify(path.join(web, 'src', file));
const LONG_TITLE = 'Checkout redesign: the complete specification for payments, refunds, retries and every edge case we found in review';

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}
const TOKEN_A = token({ id: 'user-a', org_id: 'org', sid: 'session-a', jti: 'a1' });
const TOKEN_B = token({ id: 'user-b', org_id: 'org', sid: 'session-b', jti: 'b1' });
const me = (id: string) => ({
  user: { id, name: id === 'user-a' ? 'Ana' : 'Ben', email: `${id}@example.test`, timezone: 'UTC', role: 'member' },
  org: { id: 'org', name: 'Org', slug: 'org' },
});

const ENTRIES: Record<string, string> = {
  // The card and the posting prompt, for the layout test. The session scope is set as AuthProvider sets it.
  layout: `import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { setActiveSessionCacheScope } from ${src('lib/session-cache.ts')};
import { DocumentCard } from ${src('components/documents/document-card.tsx')};
import { PostingPrompt } from ${src('components/documents/posting-prompt.tsx')};
setActiveSessionCacheScope('scope-a');
function Harness() {
  const [open, setOpen] = useState(true);
  return createElement(SWRConfig, { value: { dedupingInterval: 0 } },
    createElement('div', { style: { padding: '16px' }, id: 'harness' },
      createElement('div', { 'data-testid': 'message-body' },
        createElement('p', null, 'Spec is ready for a look'),
        createElement(DocumentCard, { card: { id: 'doc-1', title: ${JSON.stringify(LONG_TITLE)}, icon: null, drive_name: 'Engineering', role: 'comment' } }),
        createElement(DocumentCard, { card: null }),
        open ? createElement(PostingPrompt, { sessionScope: 'scope-a', documentId: 'doc-1', spaceId: 'space-1', spaceName: 'design-and-research', isDm: false, onClose: () => setOpen(false) })
          : createElement('p', { 'data-testid': 'prompt-closed' }, 'closed'))));
}
createRoot(document.getElementById('root')).render(createElement(Harness));`,
  // A message's cards inside the real AuthProvider, with a button that signs in as someone else.
  switching: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from ${src('lib/auth-context.tsx')};
import { MessageDocuments } from ${src('components/documents/document-card.tsx')};
function Harness() {
  const { user, sessionCacheScope, login } = useAuth();
  return createElement('div', null,
    createElement('p', { 'data-testid': 'who' }, user ? user.id : 'nobody'),
    createElement('button', { type: 'button', onClick: () => { void login('ben@example.test', 'password').catch(() => {}); } }, 'Sign in as Ben'),
    createElement(MessageDocuments, { metadata: { documents: [{ id: 'doc-1' }] }, sessionScope: sessionCacheScope, spaceId: 'space-1', spaceName: 'design', isDm: false }));
}
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(Harness)));`,
  // The real thread panel, inside the real AuthProvider.
  thread: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from ${src('lib/auth-context.tsx')};
import { ThreadPanel } from ${src('components/thread-panel.tsx')};
const parent = { id: 'parent-1', content: 'The parent message', space_id: 'space-1', user_id: 'user-a', user_name: 'Ana', user_avatar: null,
  is_deleted: false, edited_at: null, created_at: '2026-11-26T10:00:00.000Z', reactions: [], metadata: { documents: [{ id: 'doc-parent' }] } };
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(ThreadPanel, { parentMessage: parent, spaceId: 'space-1', onClose: () => {} })));`,
  // The composer, with documents attached until the test clears them.
  composer: `import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichComposer } from ${src('components/rich-composer.tsx')};
function Harness() {
  const [count, setCount] = useState(1);
  return createElement('div', { style: { padding: '16px' } },
    createElement('button', { type: 'button', 'data-testid': 'clear-documents', onClick: () => setCount(0) }, 'Clear documents'),
    createElement(RichComposer, {
      placeholder: 'Message #design', onSend: async () => {}, onScheduleSend: async () => {}, pendingFiles: [], onRemovePendingFile: () => {},
      onFileSelect: () => {}, onPaste: () => {}, uploading: false, uploadProgress: 0, onAttachDocument: () => {}, pendingDocumentCount: count,
    }));
}
createRoot(document.getElementById('root')).render(createElement(Harness));`,
};

const bundled = new Map<string, string>();
async function bundle(name: keyof typeof ENTRIES): Promise<string> {
  const cached = bundled.get(name);
  if (cached) return cached;
  const result = await build({
    stdin: { contents: ENTRIES[name], resolveDir: web, loader: 'tsx' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    banner: { js: 'var process = { env: {} };' },
    jsx: 'automatic',
    loader: { '.css': 'empty' },
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
  const js = result.outputFiles[0].text as string;
  bundled.set(name, js);
  return js;
}

let compiledCss: string | null = null;
/** The app's Tailwind utilities, generated for the components these tests mount. */
async function css(): Promise<string> {
  if (compiledCss) return compiledCss;
  const sources = ['src/components/documents', 'src/components/rich-composer.tsx', 'src/components/thread-panel.tsx']
    .map((source) => `@source "${path.join(web, source).replace(/\\/g, '/')}";`).join('\n');
  const result = await postcss([tailwind({ base: web })]).process(`@import "tailwindcss" source(none);\n${sources}\n`,
    { from: path.join(web, 'src/app/chat-documents-test.css') });
  compiledCss = result.css as string;
  return compiledCss;
}

const PAGE = '<!doctype html><html><head></head><body style="margin:0"><div id="root"></div></body></html>';

async function launch() {
  return chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
}

/** Opens the page, signs in with `access` when given, and runs the `name` bundle. */
async function mount(tab: any, name: keyof typeof ENTRIES, access: string | null) {
  await tab.goto('http://127.0.0.1/chat');
  if (access) {
    await tab.evaluate(`localStorage.setItem('deft-access-token', ${JSON.stringify(access)}); localStorage.setItem('deft-refresh-token', ${JSON.stringify(access)});`);
  }
  await tab.addStyleTag({ content: await css() });
  await tab.addScriptTag({ content: await bundle(name) });
}

/** Measures the mounted page: the viewport, each element's box, and whether the long title is cut short. */
const MEASURE = `(() => {
  const box = (el) => {
    if (!el) throw new Error('missing element');
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  };
  const card = document.querySelector('[data-testid="document-card"]');
  const title = card ? card.querySelector('span span') : null;
  const prompt = document.querySelector('[data-testid="posting-prompt"]');
  const buttons = prompt ? Array.from(prompt.querySelectorAll('button')) : [];
  const button = (text) => buttons.find((b) => (b.textContent || '').trim() === text) || null;
  return {
    overflow: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    card: box(card),
    title: box(title),
    hidden: box(document.querySelector('[data-testid="document-card-hidden"]')),
    prompt: box(prompt),
    controls: { role: box(prompt ? prompt.querySelector('select') : null), share: box(button('Share')), dontShare: box(button("Don't share")) },
    titleTruncated: !!title && title.scrollWidth > title.clientWidth,
    sentence: prompt ? prompt.textContent || '' : '',
  };
})()`;

type Box = { left: number; right: number; top: number; bottom: number; width: number };
type Seen = {
  overflow: number; viewport: number;
  card: Box; title: Box; hidden: Box; prompt: Box; controls: Record<string, Box>;
  titleTruncated: boolean; sentence: string;
};

async function mountAt(browser: any, width: number): Promise<{ seen: Seen; shares: unknown[]; closed: boolean }> {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  tab.setDefaultTimeout(6000);
  const shares: unknown[] = [];
  await tab.route('**/*', (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== 'http://127.0.0.1') return route.abort();
    if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: PAGE });
    if (url.pathname === '/api/documents/doc-1/audience' && url.searchParams.get('space_id') === 'space-1') {
      return json(200, { cannot_open: 8, guests: 1, can_share: true });
    }
    if (url.pathname === '/api/documents/doc-1/shares' && request.method() === 'POST') {
      shares.push(JSON.parse(request.postData() ?? 'null'));
      return json(201, { share: { id: 'share-1' }, shared_subpages: 0, skipped_subpages: 0 });
    }
    return route.abort();
  });
  await mount(tab, 'layout', null);
  await tab.getByText(/people in #design-and-research can't open this/).waitFor();

  // Plain JavaScript, sent as text: tsx's helpers (`__name`) don't exist in the page.
  const seen: Seen = await tab.evaluate(MEASURE);

  await tab.locator('[data-testid="posting-prompt"] select').selectOption('edit');
  await tab.getByRole('button', { name: 'Share', exact: true }).click();
  await tab.getByText(/Shared with #design-and-research/).waitFor();
  // A second prompt run: "Don't share" closes it and sends nothing.
  await tab.reload();
  await tab.addStyleTag({ content: await css() });
  await tab.addScriptTag({ content: await bundle('layout') });
  await tab.getByRole('button', { name: "Don't share" }).click();
  await tab.getByTestId('prompt-closed').waitFor();
  const closed = await tab.getByTestId('posting-prompt').count() === 0;
  await tab.close();
  return { seen, shares, closed };
}

for (const width of [375, 1280]) {
  test(`documents in chat at ${width} px: cards and the posting prompt fit, and Share sends the chosen role`, async () => {
    const browser = await launch();
    try {
      const { seen, shares, closed } = await mountAt(browser, width);
      assert.ok(seen.overflow <= seen.viewport, `no horizontal scroll: page ${seen.overflow} px wide in a ${seen.viewport} px viewport`);
      for (const [name, box] of Object.entries({ card: seen.card, hidden: seen.hidden, prompt: seen.prompt, ...seen.controls })) {
        assert.ok(box.left >= 0 && box.right <= seen.viewport, `${name} stays on screen: ${JSON.stringify(box)}`);
        assert.ok(box.width > 0, `${name} is drawn`);
      }
      assert.ok(seen.card.width <= 360, `a card is at most 360 px wide: ${seen.card.width}`);
      assert.ok(seen.title.right <= seen.card.right, 'the title stays inside its card');
      assert.equal(seen.titleTruncated, true, 'a long title is cut short');
      for (const name of ['role', 'share', 'dontShare']) {
        const box = seen.controls[name]!;
        assert.ok(box.right <= seen.prompt.right + 0.5 && box.bottom <= seen.prompt.bottom + 0.5, `${name} sits inside the prompt`);
        assert.ok(box.bottom - box.top >= 32, `${name} is big enough to tap: ${box.bottom - box.top} px`);
      }
      assert.match(seen.sentence, /8 people in #design-and-research can't open this, including 1 guest\./);
      assert.deepEqual(shares, [{ principal_type: 'space', principal_id: 'space-1', role: 'edit' }]);
      assert.equal(closed, true, "Don't share closes the prompt");
    } finally {
      await browser.close();
    }
  });
}

test('signing in as someone else in the same tab never shows them the previous person’s card title', async () => {
  const browser = await launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    tab.setDefaultTimeout(6000);
    let heldForB: any = null;
    let releaseB: (() => void) | null = null;
    const bAsked = new Promise<void>((resolve) => { releaseB = resolve; });
    await tab.route('**/*', (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const auth = request.headers()['authorization'] ?? '';
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: PAGE });
      if (url.pathname === '/api/auth/me') return json(me(auth.endsWith(TOKEN_B) ? 'user-b' : 'user-a'));
      if (url.pathname === '/api/auth/login') return json({ accessToken: TOKEN_B, refreshToken: TOKEN_B });
      if (url.pathname === '/api/auth/logout') return json({ success: true });
      if (url.pathname === '/api/documents/cards') {
        if (auth.endsWith(TOKEN_B)) { heldForB = route; releaseB!(); return undefined; }
        return json({ cards: { 'doc-1': { id: 'doc-1', title: 'Only Ana may read this title', icon: null, drive_name: 'Ana’s drive', role: 'edit' } } });
      }
      return route.abort();
    });
    await mount(tab, 'switching', TOKEN_A);
    await tab.getByText('Only Ana may read this title').waitFor();

    await tab.getByRole('button', { name: 'Sign in as Ben' }).click();
    // Watch the page until Ben's own cards request arrives, and a little after while it is held.
    const sightings: string[] = [];
    const watchUntil = Date.now() + 4000;
    const watch = { askedAt: null as number | null };
    void bAsked.then(() => { watch.askedAt = Date.now(); });
    while (Date.now() < watchUntil && (watch.askedAt === null || Date.now() - watch.askedAt < 400)) {
      const text = await tab.evaluate('document.body.innerText') as string;
      if (text.includes('Only Ana may read this title')) sightings.push(text.replace(/\s+/g, ' ').slice(0, 120));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(sightings, [], 'Ben never saw Ana’s title');
    assert.ok(heldForB, 'Ben’s own cards were asked for');
    assert.equal(await tab.getByTestId('who').textContent(), 'user-b');

    await heldForB.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cards: { 'doc-1': null } }) });
    await tab.getByText("You can't open this document.").waitFor();
    assert.equal(await tab.getByText('Only Ana may read this title').count(), 0);
  } finally {
    await browser.close();
  }
});

test('the thread panel shows the document cards of the parent message and of its replies', async () => {
  const browser = await launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    tab.setDefaultTimeout(6000);
    const asked: string[] = [];
    await tab.route('**/*', (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: PAGE });
      if (url.pathname === '/api/auth/me') return json(me('user-a'));
      if (url.pathname === '/api/messages/parent-1/thread') {
        return json({
          parent: { id: 'parent-1', content: 'The parent message', space_id: 'space-1', user_id: 'user-a', user_name: 'Ana', user_avatar: null,
            is_deleted: false, edited_at: null, created_at: '2026-11-26T10:00:00.000Z', reactions: [], metadata: { documents: [{ id: 'doc-parent' }] } },
          replies: [{ id: 'reply-1', content: 'A reply with a document', space_id: 'space-1', parent_id: 'parent-1', user_id: 'user-b', user_name: 'Ben',
            user_avatar: null, is_deleted: false, edited_at: null, created_at: '2026-11-26T10:01:00.000Z', reactions: [], metadata: { documents: [{ id: 'doc-reply' }] } }],
        });
      }
      if (url.pathname === '/api/messages/parent-1/thread-read') return json({ success: true });
      if (url.pathname === '/api/agent/actions/pending-by-space') return json([]);
      if (url.pathname === '/api/documents/cards') {
        const ids = (JSON.parse(request.postData() ?? '{}').ids ?? []) as string[];
        asked.push(...ids);
        const cards: Record<string, unknown> = {};
        for (const id of ids) {
          cards[id] = id === 'doc-parent' ? { id, title: 'The parent’s document', icon: null, drive_name: 'Design', role: 'edit' } : null;
        }
        return json({ cards });
      }
      return route.abort();
    });
    await mount(tab, 'thread', TOKEN_A);
    await tab.getByText('A reply with a document').waitFor();
    await tab.getByText('The parent’s document').waitFor();
    await tab.getByText("You can't open this document.").waitFor();
    assert.deepEqual([...new Set(asked)].sort(), ['doc-parent', 'doc-reply']);
  } finally {
    await browser.close();
  }
});

test('the composer can’t schedule a message while documents are attached', async () => {
  const browser = await launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    tab.setDefaultTimeout(6000);
    await tab.route('**/*', (route: any) => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1' && url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: PAGE });
      return route.abort();
    });
    await mount(tab, 'composer', null);
    const schedule = tab.locator('button:has(svg.lucide-clock)');
    await schedule.waitFor();
    assert.equal(await schedule.isDisabled(), true, 'scheduling is off while a document is attached');
    assert.equal(await schedule.getAttribute('title'), 'Scheduling doesn’t support attached documents yet');

    // With text and no documents, scheduling is back.
    await tab.locator('.ProseMirror').click();
    await tab.keyboard.type('See you tomorrow');
    await tab.getByTestId('clear-documents').click();
    assert.equal(await schedule.isDisabled(), false);
    assert.equal(await schedule.getAttribute('title'), 'Schedule send');
  } finally {
    await browser.close();
  }
});
