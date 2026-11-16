import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');

const message = (id, content, extra = {}) => ({
  id, content, user_name: 'Reader', user_avatar: null,
  created_at: '2026-11-16T09:00:00Z', is_deleted: false, ...extra,
});
const parent = message('parent', 'Public parent', {
  space_id: 'public', reply_count: 2, files: [{ id: 'parent-file', name: 'public.txt' }],
});
const replies = [
  message('reply', 'Public reply', { space_id: 'public', parent_id: 'parent', files: [{ id: 'reply-file', name: 'reply.txt' }] }),
  message('gone', 'CANARY-DELETED', { is_deleted: true, files: [{ id: 'gone-file', name: 'secret.txt' }] }),
  message('internal-reply', 'CANARY-HIDDEN-REPLY', { metadata: { hidden: true } }),
  message('clip-reply', '[[clip:reply-clip:ready]]'),
];

const bundled = build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {PublicSpacePreview} from './src/components/public-space-preview';
      import ChatPage from './src/app/(app)/chat/page';
      window.mount = (props) => createRoot(document.getElementById('root')).render(props.chatPage ? <ChatPage /> : <PublicSpacePreview spaceId="public" ready {...props} />);`,
    resolveDir: web, loader: 'tsx',
  },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"test"' },
  banner: { js: 'var process = { env: { NODE_ENV: "test" } };' },
  alias: { '@': path.join(web, 'src') },
  plugins: [{
    name: 'preview-boundaries',
    setup(build) {
      build.onResolve({ filter: /^(?:next\/navigation|@\/components\/(?:space-chat|thread-panel)|@\/lib\/(?:api|chat-context)|\.\/(?:api|thread-panel))$/ }, (args) => ({ path: args.path, namespace: 'preview-boundaries' }));
      build.onLoad({ filter: /.*/, namespace: 'preview-boundaries' }, () => ({
        contents: `import React from 'react';
          const context = {spaces: [], refreshSpaces: () => {}, setThreadMessage: () => {}, syncActiveSpaceIdFromUrl: () => {}};
          const router = {replace: value => {window.destination = value;}};
          const search = new URLSearchParams(window.location.search);
          export const useRouter = () => router, useSearchParams = () => search;
          export const useChatContext = () => context;
          export const isSameWebSession = (a,b) => a === b;
          export const api = {get: path => fetch(path), fetch: (path, options) => fetch(path, options), post: path => fetch(path, {method:'POST'}), getAccessToken: () => 'fixture-session'};
          export const SpaceChat = () => null, ThreadPanel = () => null;
          export const ThreadMessageContent = ({content}) => <span>{content}</span>;`,
        loader: 'tsx', resolveDir: web,
      }));
    },
  }],
}).then(result => result.outputFiles[0].text);

async function open(browser, props = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(4000);
  const calls = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
    calls.push({ method: request.method(), pathname, search: new URL(request.url()).search });
    if (pathname.startsWith('/api/files/')) return route.fulfill({ contentType: 'text/plain', body: 'Readable attachment' });
    const body = pathname === '/api/spaces/public' ? { id: 'public', name: 'Public room', type: 'public' }
      : pathname === '/api/messages/public' ? { messages: [parent,
        message('internal', 'CANARY-HIDDEN', { metadata: { kind: 'tool_result' } }), message('clip', '[[clip:parent-clip:ready]]')] }
      : pathname === '/api/messages/parent/thread' ? { parent, replies }
      : pathname === '/api/messages/reply/thread' ? { parent: replies[0], replies: [] } : {};
    if (pathname.startsWith('/api/clips/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      id: pathname.split('/').pop(), status: 'ready', transcript: 'Public clip transcript',
      summary: { tldr: 'Public clip summary', decisions: [], actions: [], blockers: [] },
    }) });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1/${props.search ?? ''}`);
  await page.addScriptTag({ content: await bundled });
  assert.deepEqual(errors, []);
  await page.evaluate(props => window.mount(props), props);
  if (!props.chatPage || props.search?.includes('space=')) await page.getByTestId('public-space-preview').waitFor();
  return { page, calls, errors };
}

test('a member can download a preview attachment without joining', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, calls, errors } = await open(browser);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'public.txt', exact: true }).click()]);
    assert.equal(download.suggestedFilename(), 'public.txt');
    assert.ok(calls.some(call => call.pathname === '/api/files/parent-file'));
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a member can open replies and their attachments in the preview without write controls', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, calls, errors } = await open(browser);
    await page.getByRole('button', { name: '2 replies', exact: true }).click();
    const thread = page.getByRole('region', { name: 'Thread' });
    await thread.getByText('Public reply', { exact: true }).waitFor();
    assert.equal(await thread.getByText('This message was deleted').count(), 1);
    assert.equal(await thread.getByText('CANARY-DELETED').count(), 0);
    assert.equal(await thread.getByRole('button', { name: 'secret.txt' }).count(), 0);
    const [download] = await Promise.all([page.waitForEvent('download'), thread.getByRole('button', { name: 'reply.txt', exact: true }).click()]);
    assert.equal(download.suggestedFilename(), 'reply.txt');
    assert.equal(await thread.locator('textarea, [contenteditable="true"]').count(), 0);
    await thread.getByRole('button', { name: 'Close thread' }).click();
    assert.equal(await page.getByRole('region', { name: 'Thread' }).count(), 0);
    assert.ok(calls.some(call => call.pathname === '/api/messages/parent/thread'));
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the preview hides internal rows and reads clip summaries and transcripts in messages and replies', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, calls } = await open(browser);
    assert.equal(await page.getByText('CANARY-HIDDEN', { exact: true }).count(), 0);
    await page.getByText('Public clip summary', { exact: true }).waitFor();
    await page.getByRole('button', { name: /transcript/i }).click();
    await page.getByText('Public clip transcript', { exact: true }).waitFor();
    await page.getByRole('button', { name: '2 replies', exact: true }).click();
    const thread = page.getByRole('region', { name: 'Thread' });
    await thread.getByText('Public clip summary', { exact: true }).waitFor();
    assert.equal(await thread.getByText('CANARY-HIDDEN-REPLY', { exact: true }).count(), 0);
    await thread.getByRole('button', { name: /transcript/i }).click();
    await thread.getByText('Public clip transcript', { exact: true }).waitFor();
    assert.ok(calls.every(call => call.method === 'GET'));
  } finally { await browser.close(); }
});

test('the preview loads around a deep-linked message and opens its read-only thread', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, calls } = await open(browser, { highlightMessageId: 'parent', initialThreadId: 'parent' });
    await page.getByRole('region', { name: 'Thread' }).getByText('Public reply', { exact: true }).waitFor();
    assert.ok(calls.some(call => call.pathname === '/api/messages/public' && call.search === '?around=parent'));
    assert.ok(calls.every(call => call.method === 'GET'));
  } finally { await browser.close(); }
});

test('ChatPage resolves a public message with no joined spaces and forwards preview deep links', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const first = await open(browser, { chatPage: true, search: '?message=parent' });
    await first.page.waitForFunction(() => window.destination === '/chat?message=parent&space=public');
    assert.ok(first.calls.some(call => call.pathname === '/api/messages/parent/thread'));
    const second = await open(browser, { chatPage: true, search: '?space=public&message=parent&thread=parent' });
    await second.page.getByRole('region', { name: 'Thread' }).getByText('Public reply', { exact: true }).waitFor();
    assert.ok(second.calls.some(call => call.pathname === '/api/messages/public' && call.search === '?around=parent'));
    assert.deepEqual([...first.errors, ...second.errors], []);
  } finally { await browser.close(); }
});

test('a reply link without thread opens its parent thread and retains the highlighted reply', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, calls, errors } = await open(browser, { chatPage: true, search: '?space=public&message=reply' });
    const reply = page.getByRole('region', { name: 'Thread' }).getByText('Public reply', { exact: true });
    await reply.waitFor();
    assert.equal(await page.getByRole('region', { name: 'Thread' }).locator('[data-highlighted="true"]').getByText('Public reply', { exact: true }).count(), 1);
    assert.ok(calls.some(call => call.pathname === '/api/messages/public' && call.search === '?around=parent'));
    assert.ok(!calls.some(call => call.pathname === '/api/messages/public' && call.search === '?around=reply'));
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a message-only reply link resolves its authorized parent thread', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, errors } = await open(browser, { chatPage: true, search: '?message=reply' });
    await page.waitForFunction(() => window.destination === '/chat?message=reply&space=public&thread=parent');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
