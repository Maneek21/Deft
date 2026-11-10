import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Mounted coverage for chat resilience: the production composer, SpaceChat and
// ThreadPanel are bundled and rendered in Chromium with the network, socket and
// auth boundaries replaced (see test/mounted). No live Deft API is needed.
const web = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const LAYOUT_CSS = `
html, body, #root { height: 100%; margin: 0; }
.fixed { position: fixed; } .inset-0 { top: 0; right: 0; bottom: 0; left: 0; } .z-50 { z-index: 50; }
.flex { display: flex; } .flex-col { flex-direction: column; } .flex-1 { flex: 1 1 0%; }
.flex-shrink-0 { flex-shrink: 0; } .h-full { height: 100%; } .min-w-0 { min-width: 0; }
.overflow-y-auto { overflow-y: auto; } .hidden { display: none; } .relative { position: relative; }
.w-\\[400px\\] { width: 400px; }
`;
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${LAYOUT_CSS}</style></head><body><div id="root"></div></body></html>`;

const bundles = new Map();
function bundle(harnessFile) {
  if (!bundles.has(harnessFile)) {
    const harness = path.join(web, 'test/mounted', harnessFile);
    bundles.set(harnessFile, build({
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
    }).then(result => result.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? result.outputFiles[0].text));
  }
  return bundles.get(harnessFile);
}

const pageErrors = new WeakMap();

/** `override` runs in the page before the app mounts: (method, path) => route | 'network-error' | undefined. */
async function open(browser, { harness, url, width = 1280, override }) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1/')
    ? route.fulfill({ contentType: 'text/html', body: PAGE_HTML })
    : route.abort());
  await page.goto(`http://127.0.0.1${url}`);
  if (override) await page.evaluate(`window.__deftApiOverride = ${override}`);
  await page.addScriptTag({ content: await bundle(harness) });
  return page;
}

async function close(page) {
  assert.deepEqual((pageErrors.get(page) ?? []).map(error => error.message), [], 'surfaces must not throw');
  await page.close();
}

let browser;
test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}),
  });
});
test.after(async () => { await browser?.close(); });

// ── E11: composer keys after an autocomplete popup ─────────────────────────

async function openComposer() {
  const page = await open(browser, { harness: 'composer-harness.tsx', url: '/chat?space=s1' });
  const editor = page.locator('.deft-editor');
  await editor.waitFor();
  await editor.click();
  return { page, editor };
}
const sent = page => page.evaluate(() => window.__deftSent.slice());

test('E11: after Escape closes the @ popup, Enter sends the message', async () => {
  const { page } = await openComposer();
  try {
    await page.keyboard.type('Hi @Rah');
    await page.getByRole('button', { name: 'Rahul Mehta' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Rahul Mehta' }).waitFor({ state: 'detached' });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__deftSent.length === 1, null, { timeout: 2000 });
    assert.match((await sent(page))[0], /Hi @Rah/);
  } finally {
    await close(page);
  }
});

test('E11: an @ query with no matches does not trap Enter', async () => {
  const { page } = await openComposer();
  try {
    await page.keyboard.type('Ping @zzq');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__deftSent.length === 1, null, { timeout: 2000 });
  } finally {
    await close(page);
  }
});

test('E11: an @ query with no matches does not trap Tab', async () => {
  const { page } = await openComposer();
  try {
    await page.keyboard.type('Ping @zzq');
    await page.waitForTimeout(200);
    // A window listener runs after the popup's document listener, so it sees
    // whether anything cancelled the key.
    await page.evaluate(() => {
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') window.__tabPrevented = event.defaultPrevented;
      });
    });
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => window.__tabPrevented !== undefined, null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => window.__tabPrevented), false, 'Tab must keep its default (move focus)');
  } finally {
    await close(page);
  }
});

test('E11: a # query with no task results does not trap Enter', async () => {
  const { page } = await openComposer();
  try {
    await page.keyboard.type('See #nothing');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__deftSent.length === 1, null, { timeout: 2000 });
  } finally {
    await close(page);
  }
});

test('E11: with matches open, Enter still picks the highlighted mention instead of sending', async () => {
  const { page, editor } = await openComposer();
  try {
    await page.keyboard.type('Hi @Rah');
    await page.getByRole('button', { name: 'Rahul Mehta' }).waitFor();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Rahul Mehta' }).waitFor({ state: 'detached' });
    assert.deepEqual(await sent(page), []);
    assert.match(await editor.innerText(), /Rahul Mehta/);
  } finally {
    await close(page);
  }
});

// ── E13: a failed history or approval read is not an empty conversation ────

const START_TEXT = /This is the start of/;

test('E13: a failed channel history read shows an error with Retry, not the empty state', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx',
    url: '/chat?space=s1',
    override: `(() => { let fail = true; window.__deftHistoryFail = (v) => { fail = v; };
      return (method, path) => (fail && method === 'GET' && path === '/api/messages/s1') ? { status: 500, body: { error: 'boom', code: 'X' } } : undefined; })()`,
  });
  try {
    await page.getByText('Could not load messages.').waitFor();
    assert.equal(await page.getByText(START_TEXT).count(), 0, 'must not claim the conversation is empty');
    await page.evaluate(() => window.__deftHistoryFail(false));
    await page.getByRole('button', { name: 'Retry' }).first().click();
    await page.getByText('Launch is Friday.', { exact: false }).first().waitFor();
    assert.equal(await page.getByText('Could not load messages.').count(), 0);
  } finally {
    await close(page);
  }
});

test('E13: a network failure on channel history also shows the error', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx',
    url: '/chat?space=s1',
    override: `(method, path) => (method === 'GET' && path === '/api/messages/s1') ? 'network-error' : undefined`,
  });
  try {
    await page.getByText('Could not load messages.').waitFor();
    assert.equal(await page.getByText(START_TEXT).count(), 0);
  } finally {
    await close(page);
  }
});

test('E13: a failed thread read shows an error with Retry in the thread panel', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx',
    url: '/chat?space=s1&thread=t1',
    // The page's deep-link read (first) succeeds so the panel opens; the
    // panel's own replies read (second) fails.
    override: `(() => { let fail = true; let reads = 0; window.__deftThreadFail = (v) => { fail = v; };
      return (method, path) => {
        if (method !== 'GET' || path !== '/api/messages/t1/thread') return undefined;
        reads += 1;
        return (fail && reads >= 2) ? { status: 503, body: { error: 'down', code: 'X' } } : undefined;
      }; })()`,
  });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('Could not load replies.').waitFor();
    await page.evaluate(() => window.__deftThreadFail(false));
    await panel.getByRole('button', { name: 'Retry' }).click();
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    assert.equal(await panel.getByText('Could not load replies.').count(), 0);
  } finally {
    await close(page);
  }
});

test('E13: a failed approval read is shown in the channel and in the thread panel', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx',
    url: '/chat?space=s1&thread=t1',
    override: `(method, path) => (method === 'GET' && path === '/api/agent/actions/pending-by-space') ? { status: 500, body: { error: 'x', code: 'X' } } : undefined`,
  });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('Could not load approvals.').waitFor();
    assert.ok(await page.getByText('Could not load approvals.').count() >= 2, 'channel and thread both say so');
  } finally {
    await close(page);
  }
});

// ── E15: replies that finished during a disconnect are fetched on reconnect ─

const BASE = { space_id: 's1', user_avatar: null, is_deleted: false, edited_at: null, reactions: [], reply_count: 0, latest_reply_at: null, file_ids: [] };
const ROOT = { ...BASE, id: 't1', parent_id: null, user_id: 'u-priya', user_name: 'Priya Shah', content: 'Launch is Friday. Earlier note: [the deploy plan](/chat?space=s1&message=m2)', created_at: '2026-10-22T10:00:00.000Z', reply_count: 2, latest_reply_at: '2026-10-22T10:21:00.000Z' };
const DEST = { ...BASE, id: 'm2', parent_id: null, user_id: 'u-priya', user_name: 'Priya Shah', content: 'Destination message from Priya', created_at: '2026-10-22T10:10:00.000Z' };
const REPLY = { ...BASE, id: 'r1', parent_id: 't1', user_id: 'u-rahul', user_name: 'Rahul Mehta', content: 'See [the source message](/chat?space=s1&message=m2) for the detail.', created_at: '2026-10-22T10:05:00.000Z' };
const MISSED_CHANNEL = { ...BASE, id: 'm-missed', parent_id: null, user_id: 'defty', user_name: 'Defty', content: 'Summary that finished while you were offline.', created_at: '2026-10-22T10:20:00.000Z', metadata: { is_agent_reply: true } };
const MISSED_REPLY = { ...MISSED_CHANNEL, id: 'r-missed', parent_id: 't1', content: 'Thread answer from while you were offline.', created_at: '2026-10-22T10:21:00.000Z' };

test('E15: after a reconnect the channel and the open thread fetch what they missed, once, in order, keeping the draft', async () => {
  const serverAfter = {
    channel: { messages: [ROOT, DEST, MISSED_CHANNEL] },
    thread: { replies: [REPLY, MISSED_REPLY] },
  };
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx',
    url: '/chat?space=s1&thread=t1',
    override: `(() => { let after = false; window.__deftServerMoved = () => { after = true; };
      const data = ${JSON.stringify(serverAfter)};
      return (method, path) => {
        if (!after || method !== 'GET') return undefined;
        if (path === '/api/messages/s1') return { body: data.channel };
        if (path === '/api/messages/t1/thread') return { body: data.thread };
        return undefined;
      };
    })()`,
  });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    // An unsent draft in the thread composer.
    await panel.locator('.deft-editor').click();
    await page.keyboard.type('draft in progress');

    await page.evaluate(() => window.__deftDeliver('disconnect', 'transport close'));
    await page.evaluate(() => window.__deftServerMoved());
    await page.evaluate(() => window.__deftDeliver('connect'));

    await page.getByText('Summary that finished while you were offline.').waitFor({ timeout: 3000 });
    await panel.getByText('Thread answer from while you were offline.').waitFor({ timeout: 3000 });

    const channelOrder = await page.evaluate(() => [...document.querySelectorAll('[data-message-id]')]
      .map((el) => el.getAttribute('data-message-id'))
      .filter((id) => ['t1', 'm2', 'm-missed'].includes(id)));
    assert.deepEqual([...new Set(channelOrder)], ['t1', 'm2', 'm-missed']);
    assert.equal(channelOrder.filter((id) => id === 'm-missed').length, 1, 'no duplicate');
    assert.equal(await panel.getByText('Thread answer from while you were offline.').count(), 1);
    assert.match(await panel.locator('.deft-editor').innerText(), /draft in progress/);

    // A second reconnect with the same server state adds nothing.
    await page.evaluate(() => window.__deftDeliver('disconnect', 'transport close'));
    await page.evaluate(() => window.__deftDeliver('connect'));
    await page.waitForTimeout(300);
    assert.equal(await page.getByText('Summary that finished while you were offline.').count(), 1);
    assert.equal(await panel.getByText('Thread answer from while you were offline.').count(), 1);
  } finally {
    await close(page);
  }
});
