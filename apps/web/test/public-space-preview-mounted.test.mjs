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
  reply_count: 2, files: [{ id: 'parent-file', name: 'public.txt' }],
});
const replies = [
  message('reply', 'Public reply', { files: [{ id: 'reply-file', name: 'reply.txt' }] }),
  message('gone', 'CANARY-DELETED', { is_deleted: true, files: [{ id: 'gone-file', name: 'secret.txt' }] }),
];

const bundled = build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {PublicSpacePreview} from './src/components/public-space-preview';
      window.mount = () => createRoot(document.getElementById('root')).render(<PublicSpacePreview spaceId="public" ready />);`,
    resolveDir: web, loader: 'tsx',
  },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"test"' },
  banner: { js: 'var process = { env: { NODE_ENV: "test" } };' },
  alias: { '@': path.join(web, 'src') },
  plugins: [{
    name: 'preview-boundaries',
    setup(build) {
      build.onResolve({ filter: /^(?:@\/lib\/(?:api|chat-context)|\.\/(?:api|thread-panel))$/ }, (args) => ({ path: args.path, namespace: 'preview-boundaries' }));
      build.onLoad({ filter: /.*/, namespace: 'preview-boundaries' }, () => ({
        contents: `import React from 'react';
          export const useChatContext = () => ({refreshSpaces: () => {}});
          export const api = {get: path => fetch(path), fetch: (path, options) => fetch(path, options), post: path => fetch(path, {method:'POST'})};
          export const ThreadMessageContent = ({content}) => <span>{content}</span>;`,
        loader: 'tsx', resolveDir: web,
      }));
    },
  }],
}).then(result => result.outputFiles[0].text);

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(4000);
  const calls = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
    calls.push({ method: request.method(), pathname });
    if (pathname.startsWith('/api/files/')) return route.fulfill({ contentType: 'text/plain', body: 'Readable attachment' });
    const body = pathname === '/api/spaces/public' ? { id: 'public', name: 'Public room', type: 'public' }
      : pathname === '/api/messages/public' ? { messages: [parent] }
      : pathname === '/api/messages/parent/thread' ? { parent, replies } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://127.0.0.1/');
  await page.addScriptTag({ content: await bundled });
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.mount());
  await page.getByTestId('public-space-preview').waitFor();
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
