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

