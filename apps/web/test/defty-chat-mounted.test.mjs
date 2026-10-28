import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Mounted regression coverage for the real chat surfaces. The production
// ChatPage, SpaceChat and ThreadPanel are bundled and rendered in Chromium; the
// network, socket and auth boundaries are replaced so the tests never need a
// live Deft API. Desktop and mobile widths exercise the same components.
const web = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const harness = path.join(web, 'test/mounted/defty-chat-harness.tsx');

// Only the layout rules the panel's occlusion depends on. The rest of the
// application stylesheet is irrelevant to these assertions.
const LAYOUT_CSS = `
html, body, #root { height: 100%; margin: 0; }
.fixed { position: fixed; }
.inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
.z-50 { z-index: 50; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.flex-1 { flex: 1 1 0%; }
.flex-shrink-0 { flex-shrink: 0; }
.h-full { height: 100%; }
.min-w-0 { min-width: 0; }
.overflow-y-auto { overflow-y: auto; }
.hidden { display: none; }
.relative { position: relative; }
.w-\\[400px\\] { width: 400px; }
`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${LAYOUT_CSS}</style></head><body><div id="root"></div></body></html>`;

let bundlePromise;

function bundle() {
  bundlePromise ??= build({
    stdin: { contents: `import ${JSON.stringify(harness)};`, resolveDir: web, loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"test"' },
    banner: { js: 'var process = { env: { NODE_ENV: "test" } };' },
    alias: {
      'next/navigation': path.join(web, 'test/mounted/next-navigation.tsx'),
      '@/lib/api': path.join(web, 'test/mounted/deft-api.ts'),
      '@/lib/socket': path.join(web, 'test/mounted/deft-socket.ts'),
      '@/lib/auth-context': path.join(web, 'test/mounted/deft-auth.tsx'),
      '@': path.join(web, 'src'),
    },
  }).then(result => {
    assert.equal(result.outputFiles.length, 1, 'mounted chat bundle must not emit stylesheets');
    return result.outputFiles[0].text;
  });
  return bundlePromise;
}

const pageErrors = new WeakMap();

async function openChat(browser, { width, url }) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1/')
    ? route.fulfill({ contentType: 'text/html', body: PAGE_HTML })
    : route.abort());
  await page.goto(`http://127.0.0.1${url}`);
  await page.addScriptTag({ content: await bundle() });
  assert.equal(await page.evaluate(() => typeof window.__deftApiCalls), 'object', 'network boundary must be installed');
  return page;
}

async function closeChat(page) {
  assert.deepEqual((pageErrors.get(page) ?? []).map(error => error.message), [], 'chat surfaces must not throw');
  await page.close();
}

async function messageVisibility(page, messageId) {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-message-id="${id}"]`);
    if (!element) return { present: false };
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + Math.min(rect.width, 40) / 2);
    const y = Math.round(rect.top + Math.min(rect.height, 20) / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      present: true,
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
      hit: Boolean(hit && (element === hit || element.contains(hit))),
      hitText: hit?.textContent?.slice(0, 40) ?? null,
    };
  }, messageId);
}

async function emitWorking(page, overrides = {}) {
  await page.evaluate((payload) => window.__deftDeliver('agent:working', {
    space_id: 's1',
    thread_id: null,
    agent_user_id: 'defty',
    agent_name: 'Defty',
    state: 'started',
    label: 'Reading the conversation…',
    ...payload,
  }), overrides);
}

const indicator = page => page.getByText('Defty is reading the conversation…');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}),
  });
});
test.after(async () => { await browser?.close(); });

test('mobile: a same-channel source link closes the full-screen thread and reveals the destination message', async () => {
  const page = await openChat(browser, { width: 390, url: '/chat?space=s1&thread=t1' });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    const source = page.getByRole('link', { name: 'the source message' });
    await source.waitFor();

    const covered = await messageVisibility(page, 'm2');
    assert.equal(covered.present, true, 'destination message must already be in the channel');
    assert.equal(covered.inViewport, true, 'destination message must be on screen');
    assert.equal(covered.hit, false, 'fixture must reproduce the overlay covering the destination');

    await source.click();
    await page.waitForURL(/\/chat\?space=s1&message=m2$/);
    await page.getByRole('heading', { name: 'Thread' }).waitFor({ state: 'detached' });

    const revealed = await messageVisibility(page, 'm2');
    assert.equal(revealed.present, true);
    assert.equal(revealed.inViewport, true, 'destination message must be in the viewport');
    assert.equal(revealed.hit, true, `destination message must be visible, not covered (hit ${revealed.hitText})`);
  } finally {
    await closeChat(page);
  }
});

test('mobile: empty or whitespace thread params behave like a missing thread', async () => {
  for (const [thread, expected] of [['', ''], ['%20%20', '  ']]) {
    const page = await openChat(browser, { width: 390, url: '/chat?space=s1&thread=t1' });
    try {
      await page.getByRole('heading', { name: 'Thread' }).waitFor();
      await page.evaluate((value) => window.__deftRouter.push(`/chat?space=s1&thread=${value}`), thread);
      await page.getByRole('heading', { name: 'Thread' }).waitFor({ state: 'detached' });

      const destination = new URL(page.url());
      assert.equal(destination.searchParams.get('thread'), expected, 'navigation must keep the exact destination URL');
      const revealed = await messageVisibility(page, 'm2');
      assert.equal(revealed.hit, true, 'channel must not stay behind a closed thread');
    } finally {
      await closeChat(page);
    }
  }
});

test('desktop: a channel link closes the thread without rewriting the destination URL', async () => {
  const page = await openChat(browser, { width: 1280, url: '/chat?space=s1&thread=t1' });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    // A pointer press focuses the message row, which re-renders the sanitized
    // message HTML and replaces the anchor node. Give the press and release the
    // spacing of a human click so both land on the same anchor.
    await page.locator('[data-message-id="t1"]').getByRole('link', { name: 'the deploy plan' }).click({ delay: 100 });
    await page.waitForURL(/\/chat\?space=s1&message=m2$/);
    await page.getByRole('heading', { name: 'Thread' }).waitFor({ state: 'detached' });
    assert.equal((await messageVisibility(page, 'm2')).hit, true);
  } finally {
    await closeChat(page);
  }
});

test('desktop: the working indicator starts, finishes, clears on arrival, and clears when the socket drops', async () => {
  const page = await openChat(browser, { width: 1280, url: '/chat?space=s1' });
  try {
    await page.getByText('Launch is Friday.', { exact: false }).waitFor();

    await emitWorking(page);
    await indicator(page).waitFor();

    await emitWorking(page, { state: 'finished' });
    await indicator(page).waitFor({ state: 'detached' });

    await emitWorking(page);
    await indicator(page).waitFor();
    await page.evaluate(() => window.__deftDeliver('message:new', {
      id: 'defty-1', space_id: 's1', parent_id: null, user_id: 'defty', user_name: 'Defty',
      content: 'Here is the summary.', is_deleted: false, created_at: new Date().toISOString(),
      edited_at: null, reactions: [], reply_count: 0, latest_reply_at: null, file_ids: [],
    }));
    await indicator(page).waitFor({ state: 'detached' });

    // A failed turn ends with the server's finally-block `finished`, and an
    // interrupted connection must not leave a stale "reading…" row behind.
    await emitWorking(page);
    await indicator(page).waitFor();
    await page.evaluate(() => window.__deftDeliver('disconnect', 'transport error'));
    await indicator(page).waitFor({ state: 'detached' });
  } finally {
    await closeChat(page);
  }
});

test('mobile: thread-scoped work shows inside the open panel and clears on finish', async () => {
  const page = await openChat(browser, { width: 390, url: '/chat?space=s1&thread=t1' });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    const panel = page.locator('.fixed.inset-0');
    await emitWorking(page, { thread_id: 't1' });
    await panel.getByText('Defty is reading the conversation…').waitFor();
    await emitWorking(page, { thread_id: 't1', state: 'finished' });
    await panel.getByText('Defty is reading the conversation…').waitFor({ state: 'detached' });
  } finally {
    await closeChat(page);
  }
});
