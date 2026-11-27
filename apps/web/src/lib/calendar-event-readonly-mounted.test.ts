import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real event detail modal, mounted in Chromium. A native event shows Edit
// and Delete to its own user. An attendee sees someone else's event read-only
// (the calendar list marks it viewer_is_owner: false), so neither is offered.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'const params = {}; export const usePathname = () => window.location.pathname; export const useParams = () => params; export const useSearchParams = () => new URLSearchParams(window.location.search); export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

async function actionsShown(event: Record<string, unknown>): Promise<string[]> {
  const modal = path.join(web, 'src/components/calendar/event-detail-modal.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EventDetailModal } from ${JSON.stringify(modal)};
createRoot(document.getElementById('root')).render(createElement(EventDetailModal, { event: ${JSON.stringify(event)}, onClose() {} }));`,
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
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1"' },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  try {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(6000);
    await tab.route('**/*', (route: any) => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1' && url.pathname === '/calendar') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      return route.abort();
    });
    await tab.goto('http://127.0.0.1/calendar');
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });
    await tab.getByText('Launch sync', { exact: false }).first().waitFor();
    const names: string[] = [];
    for (const name of ['Edit', 'Delete']) {
      if ((await tab.getByRole('button', { name, exact: true }).count()) > 0) names.push(name);
    }
    return names;
  } finally {
    await browser.close();
  }
}

const EVENT = {
  id: 'event-1',
  title: 'Launch sync',
  body: 'Agenda',
  event_type: 'calendar_event',
  url: null,
  timestamp: '2026-11-30T10:00:00.000Z',
  source: 'native',
  metadata: {
    start: '2026-11-30T10:00:00.000Z',
    end: '2026-11-30T10:30:00.000Z',
    attendees: [{ email: 'raj@example.test', displayName: 'Raj' }],
    status: 'confirmed',
  },
};

test('event detail: the event\'s own user can edit and delete a native event', async () => {
  assert.deepEqual(await actionsShown({ ...EVENT, viewer_is_owner: true }), ['Edit', 'Delete']);
});

test('event detail: an attendee sees someone else\'s event read-only, with no Edit or Delete', async () => {
  assert.deepEqual(await actionsShown({ ...EVENT, viewer_is_owner: false }), []);
});
