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
/** `setup` (with `setupArg`) runs in the page after `override` is installed, to configure the fake server. */
async function open(browser, { harness, url, width = 1280, override, setup, setupArg, pageData }) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1/')
    ? route.fulfill({ contentType: 'text/html', body: PAGE_HTML })
    : route.abort());
  await page.goto(`http://127.0.0.1${url}`);
  // Test data reaches the page as an argument, never spliced into code.
  await page.evaluate((data) => { window.__deftTestData = data; }, { root: ROOT, ...(pageData ?? {}) });
  if (override) await page.evaluate(`window.__deftApiOverride = ${override}`);
  if (setup) await page.evaluate(setup, setupArg);
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
// The @ popup has read the member and group lists (so "no matches" is real).
const membersRead = page => page.waitForFunction(() => ['/api/members', '/api/groups']
  .every((p) => window.__deftApiCalls.some((c) => c.path === p)), null, { timeout: 2000 });

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
    await membersRead(page);
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
    await membersRead(page);
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
    await page.waitForFunction(() => window.__deftApiCalls.some((c) => c.path.startsWith('/api/tasks/search')), null, { timeout: 2000 });
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
    pageData: { serverAfter },
    override: `(() => { let after = false; window.__deftServerMoved = () => { after = true; };
      const data = window.__deftTestData.serverAfter;
      window.__deftServerMovedAgain = (channel, reply) => { data.channel.messages.push(channel); data.thread.replies.push(reply); };
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

    // A second reconnect re-reads the same messages plus one marker each; once
    // the markers show, the reads are done, and nothing was doubled.
    await page.evaluate(() => window.__deftDeliver('disconnect', 'transport close'));
    await page.evaluate(([channel, reply]) => window.__deftServerMovedAgain(channel, reply), [
      { ...MISSED_CHANNEL, id: 'm-second', content: 'Second catch-up marker', created_at: '2026-10-22T10:30:00.000Z' },
      { ...MISSED_REPLY, id: 'r-second', content: 'Second thread marker', created_at: '2026-10-22T10:30:00.000Z' },
    ]);
    await page.evaluate(() => window.__deftDeliver('connect'));
    await page.getByText('Second catch-up marker').waitFor();
    await panel.getByText('Second thread marker').waitFor();
    assert.equal(await page.getByText('Summary that finished while you were offline.').count(), 1);
    assert.equal(await panel.getByText('Thread answer from while you were offline.').count(), 1);
  } finally {
    await close(page);
  }
});

// ── Round 2: reconnect and retry hardening ─────────────────────────────────
//
// A small fake server runs in the page. `window.__srv.channel` / `.thread`
// replace the channel history / thread replies when set; `.fail.*` makes those
// reads fail; with `.hold` set, each read's response is computed when the
// request arrives (so it can be stale) and released later by the test.
// Channel reads honour `limit` and `cursor` like the API.

const FAKE_SERVER = `(() => {
  const S = window.__srv = { channel: null, thread: null, fail: { channel: false, thread: false }, netFail: { channel: false, thread: false }, netFailWhen: null, hold: false, holdWhen: null, held: [], channelReads: 0, threadReads: 0, failThreadFromRead: Infinity };
  const page = (all, full) => {
    const q = new URL(full, 'http://x').searchParams;
    const limit = Math.min(Number(q.get('limit') || 50), 100);
    const cursor = q.get('cursor');
    // Like the API: '<created_at>|<id>' pages before that row in (created_at, id) order.
    const [time, id] = (cursor || '').split('|');
    const list = cursor ? all.filter((m) => m.created_at < time || (m.created_at === time && id !== undefined && m.id < id)) : all;
    return list.slice(-limit);
  };
  const failure = { status: 500, body: { error: 'boom', code: 'X' } };
  return (method, path, full) => {
    if (method !== 'GET') return undefined;
    let res;
    if (path === '/api/messages/s1') {
      S.channelReads += 1;
      if (S.netFail.channel || (S.netFailWhen && S.netFailWhen(path))) res = 'network-error';
      else if (S.fail.channel) res = failure;
      else if (S.channel) res = { body: { messages: page(S.channel, full), next_cursor: null } };
    } else if (path === '/api/messages/t1/thread') {
      S.threadReads += 1;
      if (S.netFail.thread || (S.netFailWhen && S.netFailWhen(path))) res = 'network-error';
      else if (S.fail.thread || S.threadReads >= S.failThreadFromRead) res = failure;
      else if (S.thread) res = { body: { parent: window.__deftTestData.root, replies: S.thread } };
    }
    if (!res) return undefined;
    // holdWhen(path, fullPath) holds chosen reads only.
    if (!S.hold && !(S.holdWhen && S.holdWhen(path, full))) return res;
    const snapshot = JSON.parse(JSON.stringify(res));
    return new Promise((resolve) => S.held.push({ path, release: () => resolve(snapshot) }));
  };
})()`;

const srv = (page, fn, arg) => page.evaluate(fn, arg);
async function waitHeld(page, n) {
  await page.waitForFunction((count) => window.__srv.held.length >= count, n, { timeout: 4000 });
}
const release = (page, index) => page.evaluate((i) => window.__srv.held[i].release(), index);
const drop = (page) => page.evaluate(() => window.__deftDeliver('disconnect', 'transport close'));
const reconnect = (page) => page.evaluate(() => window.__deftDeliver('connect'));
const marker = (id, minute, text, extra = {}) => ({ ...BASE, id, parent_id: null, user_id: 'u-rahul', user_name: 'Rahul Mehta', content: text, created_at: `2026-10-22T10:${String(minute).padStart(2, '0')}:00.000Z`, ...extra });

test('R2-1: a reconnect read that started before a live edit and delete does not undo them', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; window.__srv.hold = true; }, [ROOT, DEST, marker('mk-1', 30, 'Catch-up marker one')]);
    await reconnect(page);
    await waitHeld(page, 1);
    // Live changes arrive while the (now stale) read is in flight.
    await page.evaluate(() => {
      window.__deftDeliver('message:deleted', { id: 'm2' });
      window.__deftDeliver('message:edited', { id: 't1', content: 'Launch moved to Monday.', edited_at: '2026-10-22T10:31:00.000Z' });
    });
    await page.getByText('Launch moved to Monday.').waitFor();
    await release(page, 0);
    await page.getByText('Catch-up marker one').waitFor();
    assert.equal(await page.getByText('Destination message from Priya').count(), 0, 'deleted message must not come back');
    assert.equal(await page.locator('[data-message-id="m2"]').getByText('This message was deleted').count(), 1);
    assert.equal(await page.getByText('Launch moved to Monday.').count(), 1, 'live edit must survive');
  } finally {
    await close(page);
  }
});

test('R2-1: an older reconnect read that resolves last is ignored, in the channel and the thread', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1', override: FAKE_SERVER });
  try {
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    await drop(page);
    await srv(page, ([channel, thread]) => { window.__srv.channel = channel; window.__srv.thread = thread; window.__srv.hold = true; },
      [[ROOT, DEST, marker('a-chan', 30, 'Stale read A channel')], [REPLY, { ...marker('a-rep', 30, 'Stale read A reply'), parent_id: 't1' }]]);
    await reconnect(page);
    await waitHeld(page, 2); // read A: channel + thread
    await drop(page);
    await srv(page, ([channel, thread]) => { window.__srv.channel = channel; window.__srv.thread = thread; },
      [[ROOT, DEST, marker('b-chan', 31, 'Fresh read B channel')], [REPLY, { ...marker('b-rep', 31, 'Fresh read B reply'), parent_id: 't1' }]]);
    await reconnect(page);
    await waitHeld(page, 4); // read B
    await release(page, 2); await release(page, 3);
    await page.getByText('Fresh read B channel').waitFor();
    await panel.getByText('Fresh read B reply').waitFor();
    await release(page, 0); await release(page, 1);
    // A later read proves read A has been processed before we look.
    await srv(page, () => { window.__srv.hold = false; });
    await drop(page);
    await srv(page, ([channel, thread]) => { window.__srv.channel = channel; window.__srv.thread = thread; },
      [[ROOT, DEST, marker('b-chan', 31, 'Fresh read B channel'), marker('c-chan', 32, 'Read C channel')],
        [REPLY, { ...marker('b-rep', 31, 'Fresh read B reply'), parent_id: 't1' }, { ...marker('c-rep', 32, 'Read C reply'), parent_id: 't1' }]]);
    await reconnect(page);
    await page.getByText('Read C channel').waitFor();
    await panel.getByText('Read C reply').waitFor();
    assert.equal(await page.getByText('Stale read A channel').count(), 0);
    assert.equal(await panel.getByText('Stale read A reply').count(), 0);
  } finally {
    await close(page);
  }
});

const many = (count, prefix = 'x', base = '2026-10-22T11:00:00.000Z') => Array.from({ length: count }, (_, i) => ({
  ...BASE, id: `${prefix}-${String(i + 1).padStart(3, '0')}`, parent_id: null, user_id: 'u-rahul', user_name: 'Rahul Mehta',
  content: `Missed ${prefix} ${String(i + 1).padStart(3, '0')}`,
  created_at: new Date(Date.parse(base) + i * 1000).toISOString(),
}));

test('R2-2: a reconnect follows pages back to what was shown, so 150 missed messages leave no gap and older ones refresh', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; },
      [ROOT, { ...DEST, content: 'Destination edited while offline', edited_at: '2026-10-22T10:40:00.000Z' }, ...many(150)]);
    await reconnect(page);
    await page.getByText('Missed x 150', { exact: true }).waitFor();
    await page.getByText('Missed x 001', { exact: true }).waitFor();
    const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id')))]);
    assert.equal(ids.filter((id) => id.startsWith('x-')).length, 150);
    assert.deepEqual(ids.slice(0, 3), ['t1', 'm2', 'x-001']);
    assert.equal(await page.getByText('Destination edited while offline').count(), 1, 'a message outside the latest page is refreshed');
    assert.equal(await page.getByRole('button', { name: 'Load earlier messages' }).count(), 0);
  } finally {
    await close(page);
  }
});

test('R2-2: past the page bound the view is replaced by the latest pages with a Load earlier control, never a silent hole', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; }, [ROOT, DEST, ...many(600)]);
    await reconnect(page);
    await page.getByText('Missed x 600', { exact: true }).waitFor();
    const earlier = page.getByRole('button', { name: 'Load earlier messages' });
    await earlier.waitFor();
    await page.getByText('Missed x 101', { exact: true }).waitFor();
    assert.equal(await page.getByText('Missed x 100', { exact: true }).count(), 0, 'nothing older than the fetched window is shown');
    assert.equal(await page.getByText('Destination message from Priya').count(), 0, 'no gap: older messages are not kept beside it');
    await earlier.click();
    await page.getByText('Missed x 001', { exact: true }).waitFor();
  } finally {
    await close(page);
  }
});

test('R2-3: a thread opened while offline catches up on the next connect', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await page.evaluate(() => window.__deftRouter.push('/chat?space=s1&thread=t1'));
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    await srv(page, (data) => { window.__srv.thread = data; }, [REPLY, MISSED_REPLY]);
    await reconnect(page);
    await panel.getByText('Thread answer from while you were offline.').waitFor({ timeout: 4000 });
  } finally {
    await close(page);
  }
});

test('R2-4: a failed catch-up read keeps the messages, says so, and Retry recovers (channel and thread)', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1', override: FAKE_SERVER });
  try {
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    await drop(page);
    await srv(page, ([channel, thread]) => { Object.assign(window.__srv, { channel, thread }); window.__srv.fail = { channel: true, thread: true }; },
      [[ROOT, DEST, MISSED_CHANNEL], [REPLY, MISSED_REPLY]]);
    await reconnect(page);
    await page.getByText('Could not load new messages.').waitFor();
    await panel.getByText('Could not load new replies.').waitFor();
    assert.equal(await page.getByText('Destination message from Priya').count(), 1, 'shown messages stay');
    assert.equal(await panel.getByText('for the detail.', { exact: false }).count(), 1, 'shown replies stay');
    await srv(page, () => { window.__srv.fail = { channel: false, thread: false }; });
    await page.getByRole('alert').filter({ hasText: 'Could not load new messages.' }).getByRole('button', { name: 'Retry' }).click();
    await page.getByText('Summary that finished while you were offline.').waitFor();
    await panel.getByRole('alert').filter({ hasText: 'Could not load new replies.' }).getByRole('button', { name: 'Retry' }).click();
    await panel.getByText('Thread answer from while you were offline.').waitFor();
    assert.equal(await page.getByText('Could not load new messages.').count(), 0);
    assert.equal(await panel.getByText('Could not load new replies.').count(), 0);
  } finally {
    await close(page);
  }
});

test('R2-5: Retry keeps what is shown and the draft, and merges the result (channel and thread)', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1',
    // Channel history fails from the start; the panel's own thread read (the second) fails.
    override: FAKE_SERVER,
    setup: () => { window.__srv.fail.channel = true; window.__srv.failThreadFromRead = 2; },
  });
  try {
    const panel = page.locator('.w-\\[400px\\]');
    await page.getByText('Could not load messages.').waitFor();
    await panel.getByText('Could not load replies.').waitFor();
    await page.evaluate(() => {
      const base = { space_id: 's1', user_id: 'u-rahul', user_name: 'Rahul Mehta', user_avatar: null, is_deleted: false, edited_at: null, reactions: [], reply_count: 0, latest_reply_at: null, file_ids: [] };
      window.__deftDeliver('message:new', { ...base, id: 'live-1', parent_id: null, content: 'Live message during the outage', created_at: '2026-10-22T10:30:00.000Z' });
      window.__deftDeliver('message:new', { ...base, id: 'live-r', parent_id: 't1', content: 'Live reply during the outage', created_at: '2026-10-22T10:30:00.000Z' });
    });
    await page.getByText('Live message during the outage').waitFor();
    await panel.getByText('Live reply during the outage').waitFor();
    await panel.locator('.deft-editor').click();
    await page.keyboard.type('draft kept');

    // A retry that fails again must not clear anything.
    await srv(page, () => { window.__srv.hold = true; });
    const channelRetry = page.getByRole('alert').filter({ hasText: 'Could not load messages.' }).getByRole('button');
    const threadRetry = panel.getByRole('alert').filter({ hasText: 'Could not load replies.' }).getByRole('button');
    await channelRetry.click();
    await threadRetry.click();
    await waitHeld(page, 2);
    assert.equal(await page.getByText('Live message during the outage').count(), 1, 'retry in flight keeps messages');
    assert.equal(await panel.getByText('Live reply during the outage').count(), 1, 'retry in flight keeps replies');
    await release(page, 0); await release(page, 1);
    await channelRetry.filter({ hasText: /^Retry$/ }).waitFor();
    await threadRetry.filter({ hasText: /^Retry$/ }).waitFor();
    assert.equal(await page.getByText('Live message during the outage').count(), 1);
    assert.equal(await panel.getByText('Live reply during the outage').count(), 1);

    // A retry that succeeds merges.
    await srv(page, () => { window.__srv.hold = false; window.__srv.fail.channel = false; window.__srv.failThreadFromRead = Infinity; });
    await channelRetry.click();
    await threadRetry.click();
    await page.getByText('Destination message from Priya').waitFor();
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    assert.equal(await page.getByText('Live message during the outage').count(), 1);
    assert.equal(await panel.getByText('Live reply during the outage').count(), 1);
    assert.match(await panel.locator('.deft-editor').innerText(), /draft kept/);
  } finally {
    await close(page);
  }
});

// ── Round 3 ────────────────────────────────────────────────────────────────

test('R3-1: a Load earlier read superseded by a catch-up does not bring back an older segment', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; }, [ROOT, DEST, ...many(600)]);
    await reconnect(page);
    const earlier = page.getByRole('button', { name: 'Load earlier messages' });
    await earlier.waitFor();
    // Load earlier is held (it would add x-001…x-100).
    await srv(page, () => { window.__srv.hold = true; });
    await earlier.click();
    await waitHeld(page, 1);
    await srv(page, () => { window.__srv.hold = false; });
    // Another long outage: the catch-up replaces the view with y-101…y-600.
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = [...window.__srv.channel, ...data]; }, many(600, 'y', '2026-10-22T13:00:00.000Z'));
    await reconnect(page);
    await page.getByText('Missed y 600', { exact: true }).waitFor();
    await page.getByText('Missed y 101', { exact: true }).waitFor();
    await release(page, 0);
    // A fresh Load earlier proves the stale page has been processed first.
    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await page.getByText('Missed y 001', { exact: true }).waitFor();
    assert.equal(await page.getByText('Missed x 001', { exact: true }).count(), 0, 'stale older page must not apply');
    assert.equal(await page.getByText('Missed x 100', { exact: true }).count(), 0);
  } finally {
    await close(page);
  }
});

test('W2-3: Load earlier messages is disabled while a catch-up read is in flight and usable again once it settles, on success and on failure', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; }, [ROOT, DEST, ...many(600)]);
    await reconnect(page);
    const earlier = page.getByRole('button', { name: 'Load earlier messages' });
    await earlier.waitFor();
    assert.equal(await earlier.isDisabled(), false);
    for (const outcome of ['success', 'failure']) {
      await drop(page);
      await srv(page, (failing) => {
        window.__srv.hold = true;
        window.__srv.netFail.channel = failing;
        window.__srv.held = [];
      }, outcome === 'failure');
      await reconnect(page);
      await waitHeld(page, 1);
      assert.equal(await earlier.isDisabled(), true, `disabled while the ${outcome} catch-up is held`);
      await srv(page, () => { window.__srv.hold = false; });
      await release(page, 0);
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Load earlier messages'));
        return !!button && !button.disabled;
      });
      await srv(page, () => { window.__srv.netFail.channel = false; });
    }
  } finally {
    await close(page);
  }
});

test('R3-2: a live reaction during a catch-up does not discard the edit the catch-up fetched', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; window.__srv.hold = true; },
      [ROOT, { ...DEST, content: 'Destination edited while offline', edited_at: '2026-10-22T10:40:00.000Z' }, marker('mk-r3', 30, 'Catch-up marker three')]);
    await reconnect(page);
    await waitHeld(page, 1);
    await page.evaluate(() => window.__deftDeliver('reaction:added', { message_id: 'm2', emoji: '🎉', user_id: 'u-rahul' }));
    await page.locator('[data-message-id="m2"]').getByText('🎉').waitFor();
    await release(page, 0);
    await page.getByText('Catch-up marker three').waitFor();
    assert.equal(await page.getByText('Destination edited while offline').count(), 1, 'fetched edit applies');
    assert.equal(await page.locator('[data-message-id="m2"]').getByText('🎉').count(), 1, 'live reaction stays');
  } finally {
    await close(page);
  }
});

test('R3-3: an initial read that fails after a successful catch-up does not bring back the error (channel and thread)', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1',
    // Hold the channel's first read and the panel's own thread read (the
    // second); both fail with a network error when released.
    override: FAKE_SERVER,
    setup: () => {
      const first = (path) => (path === '/api/messages/s1' && window.__srv.channelReads === 1)
        || (path === '/api/messages/t1/thread' && window.__srv.threadReads === 2);
      window.__srv.netFailWhen = first;
      window.__srv.holdWhen = first;
    },
  });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    await waitHeld(page, 2);
    await srv(page, ([channel, thread]) => { window.__srv.channel = channel; window.__srv.thread = thread; },
      [[ROOT, DEST, MISSED_CHANNEL], [REPLY, MISSED_REPLY]]);
    await drop(page);
    await reconnect(page);
    const panel = page.locator('.w-\\[400px\\]');
    await page.getByText('Summary that finished while you were offline.').waitFor();
    await panel.getByText('Thread answer from while you were offline.').waitFor();
    await release(page, 0);
    await release(page, 1);
    // A later catch-up proves the released reads were processed first.
    await drop(page);
    await srv(page, ([channel, thread]) => { window.__srv.channel = channel; window.__srv.thread = thread; },
      [[ROOT, DEST, MISSED_CHANNEL, marker('r3-c', 40, 'Round three channel marker')],
        [REPLY, MISSED_REPLY, { ...marker('r3-r', 40, 'Round three reply marker'), parent_id: 't1' }]]);
    await reconnect(page);
    await page.getByText('Round three channel marker').waitFor();
    await panel.getByText('Round three reply marker').waitFor();
    assert.equal(await page.getByText('Could not load messages.').count(), 0);
    assert.equal(await panel.getByText('Could not load replies.').count(), 0);
  } finally {
    await close(page);
  }
});

// ── Round 4: buffered live events replayed onto the latest read ────────────

const reactionCount = async (scope, emoji) => {
  const pill = scope.locator('button', { hasText: emoji }).first();
  if (await pill.count() === 0) return 0;
  return Number((await pill.innerText()).replace(emoji, '').trim());
};

test('R4-1: a failed catch-up that superseded the initial read ends the loading state and offers Retry (thread and channel)', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1',
    // Hold the initial reads (channel #1, panel's thread read #2); fail the
    // catch-up reads that follow (channel #2, thread #3).
    override: FAKE_SERVER,
    setupArg: { channel: [ROOT, DEST], thread: [REPLY] },
    setup: ({ channel, thread }) => {
      window.__srv.channel = channel;
      window.__srv.thread = thread;
      window.__srv.holdWhen = (path) => (path === '/api/messages/s1' && window.__srv.channelReads === 1)
        || (path === '/api/messages/t1/thread' && window.__srv.threadReads === 2);
      window.__srv.netFailWhen = (path) => (path === '/api/messages/s1' && window.__srv.channelReads === 2)
        || (path === '/api/messages/t1/thread' && window.__srv.threadReads === 3);
    },
  });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    await waitHeld(page, 2);
    await drop(page);
    await reconnect(page);
    const panel = page.locator('.w-\\[400px\\]');
    const threadAlert = panel.getByRole('alert').filter({ hasText: 'Could not load' });
    await threadAlert.getByRole('button', { name: 'Retry' }).waitFor();
    const channelAlert = page.getByRole('alert').filter({ hasText: /Could not load (new )?messages\./ });
    await channelAlert.getByRole('button', { name: 'Retry' }).waitFor();
    // The superseded initial reads resolve later and must not change that.
    await release(page, 0); await release(page, 1);
    await srv(page, ([channel, thread]) => { window.__srv.channel = channel; window.__srv.thread = thread; },
      [[ROOT, DEST, MISSED_CHANNEL], [REPLY, MISSED_REPLY]]);
    await threadAlert.getByRole('button', { name: 'Retry' }).click();
    await panel.getByText('Thread answer from while you were offline.').waitFor();
    await channelAlert.getByRole('button', { name: 'Retry' }).click();
    await page.getByText('Summary that finished while you were offline.').waitFor();
  } finally {
    await close(page);
  }
});

test('R4-2: a reaction fetched by catch-up and one added live during it both stay; a live removal removes from the fetched set', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; window.__srv.hold = true; }, [
      { ...ROOT, reactions: [{ emoji: '👍', count: 2, users: ['u-alice', 'u-bob'] }] },
      { ...DEST, reactions: [{ emoji: '🎉', count: 1, users: ['u-alice'] }] },
      marker('mk-r4', 30, 'Catch-up marker four'),
    ]);
    await reconnect(page);
    await waitHeld(page, 1);
    await page.evaluate(() => {
      window.__deftDeliver('reaction:added', { message_id: 'm2', emoji: '🎉', user_id: 'u-bob' });
      window.__deftDeliver('reaction:removed', { message_id: 't1', emoji: '👍', user_id: 'u-alice' });
    });
    await release(page, 0);
    await page.getByText('Catch-up marker four').waitFor();
    assert.equal(await reactionCount(page.locator('[data-message-id="m2"]'), '🎉'), 2, 'Alice (fetched) and Bob (live)');
    assert.equal(await reactionCount(page.locator('[data-message-id="t1"]'), '👍'), 1, 'live removal of Alice');
  } finally {
    await close(page);
  }
});

test('R4-3: a live delete or reaction for a row the read introduces is applied when the row is inserted', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1', override: FAKE_SERVER });
  try {
    await page.getByText('Destination message from Priya').waitFor();
    await drop(page);
    await srv(page, (data) => { window.__srv.channel = data; }, [ROOT, DEST, ...many(600)]);
    await reconnect(page);
    const earlier = page.getByRole('button', { name: 'Load earlier messages' });
    await earlier.waitFor();
    await srv(page, () => { window.__srv.hold = true; });
    await earlier.click();
    await waitHeld(page, 1);
    await page.evaluate(() => {
      window.__deftDeliver('message:deleted', { id: 'x-050' });
      window.__deftDeliver('reaction:added', { message_id: 'x-060', emoji: '🚀', user_id: 'u-bob' });
    });
    await release(page, 0);
    await page.getByText('Missed x 001', { exact: true }).waitFor();
    assert.equal(await page.getByText('Missed x 050', { exact: true }).count(), 0, 'deleted live before it was shown');
    assert.equal(await page.locator('[data-message-id="x-050"]').getByText('This message was deleted').count(), 1);
    assert.equal(await reactionCount(page.locator('[data-message-id="x-060"]'), '🚀'), 1);
  } finally {
    await close(page);
  }
});

test('R4-3: a live reaction on a thread reply that is not shown yet is applied when the reply arrives', async () => {
  const page = await open(browser, {
    harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1',
    override: FAKE_SERVER,
    setupArg: { thread: [REPLY] },
    setup: ({ thread }) => {
      window.__srv.thread = thread;
      window.__srv.holdWhen = (path) => path === '/api/messages/t1/thread' && window.__srv.threadReads === 2;
    },
  });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    await waitHeld(page, 1);
    await page.evaluate(() => window.__deftDeliver('reaction:added', { message_id: 'r1', emoji: '🚀', user_id: 'u-bob' }));
    await release(page, 0);
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    await panel.locator('button', { hasText: '🚀' }).first().waitFor({ timeout: 3000 });
    assert.equal(await reactionCount(panel, '🚀'), 1);
  } finally {
    await close(page);
  }
});

// ── W2-6: the open thread shows edits and deletes of its replies live ──────

test('W2-6: an edit and a delete of a reply show in the open thread panel without a reload', async () => {
  const page = await open(browser, { harness: 'defty-chat-harness.tsx', url: '/chat?space=s1&thread=t1' });
  try {
    await page.getByRole('heading', { name: 'Thread' }).waitFor();
    const panel = page.locator('.w-\\[400px\\]');
    await panel.getByText('for the detail.', { exact: false }).waitFor();
    await page.evaluate((edit) => window.__deftDeliver('message:edited', edit),
      { id: 'r1', content: 'Reply edited by Rahul.', edited_at: '2026-10-22T10:30:00.000Z' });
    await panel.getByText('Reply edited by Rahul.').waitFor({ timeout: 3000 });
    await page.evaluate((id) => window.__deftDeliver('message:deleted', { id }), 'r1');
    await panel.getByText('This message was deleted').waitFor({ timeout: 3000 });
    assert.equal(await panel.getByText('Reply edited by Rahul.').count(), 0);
  } finally {
    await close(page);
  }
});
