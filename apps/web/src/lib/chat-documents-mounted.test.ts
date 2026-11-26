import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Documents in chat (plan Task F13), mounted in Chromium with the app's
// Tailwind utilities, at a phone width (375 px) and a desktop width
// (1280 px): a document card, the card a viewer who can't open the document
// sees, and the posting prompt. Nothing may overflow the viewport, a long
// title is cut short inside its card, and the prompt's controls stay on
// screen. Share sends F9's POST /api/documents/:id/shares for the chat at the
// role chosen; "Don't share" only closes the prompt.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
};

const LONG_TITLE = 'Checkout redesign: the complete specification for payments, refunds, retries and every edge case we found in review';

let bundled: { js: string; css: string } | null = null;
async function bundle(): Promise<{ js: string; css: string }> {
  if (bundled) return bundled;
  const card = path.join(web, 'src/components/documents/document-card.tsx');
  const prompt = path.join(web, 'src/components/documents/posting-prompt.tsx');
  const result = await build({
    stdin: {
      contents: `import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { DocumentCard } from ${JSON.stringify(card)};
import { PostingPrompt } from ${JSON.stringify(prompt)};
function Harness() {
  const [open, setOpen] = useState(true);
  return createElement(SWRConfig, { value: { dedupingInterval: 0 } },
    createElement('div', { style: { padding: '16px' }, id: 'harness' },
      createElement('div', { 'data-testid': 'message-body' },
        createElement('p', null, 'Spec is ready for a look'),
        createElement(DocumentCard, { card: { id: 'doc-1', title: ${JSON.stringify(LONG_TITLE)}, icon: null, drive_name: 'Engineering', role: 'comment' } }),
        createElement(DocumentCard, { card: null }),
        open ? createElement(PostingPrompt, { documentId: 'doc-1', spaceId: 'space-1', spaceName: 'design-and-research', isDm: false, onClose: () => setOpen(false) })
          : createElement('p', { 'data-testid': 'prompt-closed' }, 'closed'))));
}
createRoot(document.getElementById('root')).render(createElement(Harness));`,
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
        b.onResolve({ filter: /^next\/(navigation|link)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  // The app's Tailwind utilities, generated for the documents components only.
  const sources = path.join(web, 'src/components/documents').replace(/\\/g, '/');
  const css = await postcss([tailwind({ base: web })]).process(`@import "tailwindcss" source(none);\n@source "${sources}";\n`,
    { from: path.join(web, 'src/app/chat-documents-test.css') });
  bundled = { js: result.outputFiles[0].text as string, css: css.css as string };
  return bundled;
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
    if (url.pathname === '/chat') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body style="margin:0"><div id="root"></div></body></html>' });
    if (url.pathname === '/api/documents/doc-1/audience' && url.searchParams.get('space_id') === 'space-1') {
      return json(200, { cannot_open: 8, guests: 1, can_share: true });
    }
    if (url.pathname === '/api/documents/doc-1/shares' && request.method() === 'POST') {
      shares.push(JSON.parse(request.postData() ?? 'null'));
      return json(201, { share: { id: 'share-1' }, shared_subpages: 0, skipped_subpages: 0 });
    }
    return route.abort();
  });
  await tab.goto('http://127.0.0.1/chat');
  const { js, css } = await bundle();
  await tab.addStyleTag({ content: css });
  await tab.addScriptTag({ content: js });
  await tab.getByText(/people in #design-and-research can't open this/).waitFor();

  // Plain JavaScript, sent as text: tsx's helpers (`__name`) don't exist in the page.
  const seen: Seen = await tab.evaluate(MEASURE);

  await tab.locator('[data-testid="posting-prompt"] select').selectOption('edit');
  await tab.getByRole('button', { name: 'Share', exact: true }).click();
  await tab.getByText(/Shared with #design-and-research/).waitFor();
  // A second prompt run: "Don't share" closes it and sends nothing.
  await tab.reload();
  await tab.addStyleTag({ content: css });
  await tab.addScriptTag({ content: js });
  await tab.getByRole('button', { name: "Don't share" }).click();
  await tab.getByTestId('prompt-closed').waitFor();
  const closed = await tab.getByTestId('posting-prompt').count() === 0;
  await tab.close();
  return { seen, shares, closed };
}

for (const width of [375, 1280]) {
  test(`documents in chat at ${width} px: cards and the posting prompt fit, and Share sends the chosen role`, async () => {
    const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
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
