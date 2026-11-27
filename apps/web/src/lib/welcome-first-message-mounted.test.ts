import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real welcome page inside the real AuthProvider, mounted in Chromium,
// with the API answered by page.route. Its last step, "Say hello in
// #general", posts the hello to the chat route (POST /api/messages/:spaceId)
// and then finishes onboarding. When the hello can't be posted, the person is
// told so on that step instead of being sent on as if it had worked.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'const pushed = (window.__pushed = window.__pushed || []); export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push(u) { pushed.push(u); }, replace(u) { pushed.push(u); }, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};
const GENERAL = 'space-general';
const HELLO = 'Hi team — happy to be here!';
const FAILED = "Your hello wasn't posted.";

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

type MessageAnswer = { status: number; body: unknown } | 'abort';
type Seen = {
  requests: Array<{ method: string; path: string; body: unknown }>;
  pushed: string[];
  failureShown: boolean;
};

async function postHello(answer: MessageAnswer): Promise<Seen> {
  const page = path.join(web, 'src/app/welcome/page.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import WelcomePage from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(WelcomePage)));`,
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
        b.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  const requests: Seen['requests'] = [];
  try {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(6000);
    await tab.route('**/*', (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/welcome') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      const raw = request.postData();
      requests.push({ method: request.method(), path: url.pathname, body: raw ? JSON.parse(raw) : undefined });
      if (url.pathname === '/api/auth/me') {
        return json({ user: { id: 'newcomer', name: 'Raj Newcomer', email: 'raj@example.test', timezone: 'UTC', role: 'member' }, org: { id: 'org', name: 'Launch Co', slug: 'launch' } });
      }
      if (url.pathname === '/api/auth/onboarding') return json({ completed: false });
      if (url.pathname === '/api/spaces') {
        return json([
          { id: 'space-launch', name: 'launch', is_default: false },
          { id: GENERAL, name: 'general', is_default: true },
        ]);
      }
      if (url.pathname === `/api/messages/${GENERAL}`) {
        if (answer === 'abort') return route.abort();
        return json(answer.body, answer.status);
      }
      return route.abort();
    });
    await tab.goto('http://127.0.0.1/welcome');
    await tab.evaluate((access: string) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', access);
    }, token({ id: 'newcomer', org_id: 'org', sid: 'session', jti: 'w1' }));
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });

    await tab.getByRole('button', { name: "Let's go" }).click();
    await tab.getByRole('button', { name: 'Save and continue' }).click();
    await tab.getByRole('button', { name: 'Continue' }).click();
    await tab.getByRole('button', { name: 'Got it' }).click();
    await tab.getByRole('heading', { name: 'Say hello in #general' }).waitFor();
    await tab.getByRole('button', { name: 'Post and finish' }).click();

    // Either the page moves on to the dashboard or it says the hello failed.
    await tab.waitForFunction(
      (failed: string) => (window as any).__pushed?.includes('/dashboard') || document.body.innerText.includes(failed),
      FAILED,
    );
    // Let any request the click started settle before reading what was sent.
    await tab.waitForTimeout(300);
    const pushed = await tab.evaluate(() => [...((window as any).__pushed ?? [])]);
    const failureShown = (await tab.getByRole('alert').filter({ hasText: FAILED }).count()) > 0;
    return { requests, pushed, failureShown };
  } finally {
    await browser.close();
  }
}

const messagePosts = (seen: Seen) => seen.requests.filter((r) => r.method === 'POST' && /messages/.test(r.path));
const onboardingPatches = (seen: Seen) => seen.requests.filter((r) => r.method === 'PATCH' && r.path === '/api/auth/onboarding').map((r) => r.body);

test('welcome: the hello is posted to #general through the chat route, then onboarding finishes', async () => {
  const seen = await postHello({ status: 201, body: { id: 'message-1', space_id: GENERAL, content: HELLO } });
  assert.deepEqual(messagePosts(seen), [{ method: 'POST', path: `/api/messages/${GENERAL}`, body: { content: HELLO } }]);
  assert.equal(seen.failureShown, false);
  assert.deepEqual(seen.pushed, ['/dashboard']);
  const patches = onboardingPatches(seen);
  assert.ok(patches.some((b: any) => b?.first_message_sent === true), 'the hello is recorded as sent');
  assert.ok(patches.some((b: any) => b?.completed === true), 'onboarding is finished');
});

for (const [label, answer] of [
  ['the server refuses it', { status: 403, body: { error: 'Not a member of this space', code: 'FORBIDDEN' } }],
  ['the server fails', { status: 500, body: { error: 'Internal error', code: 'INTERNAL' } }],
  ['there is no answer', 'abort'],
] as Array<[string, MessageAnswer]>) {
  test(`welcome: when ${label}, the person is told the hello was not posted and stays on the step`, async () => {
    const seen = await postHello(answer);
    assert.equal(messagePosts(seen).length >= 1, true, 'the hello was attempted');
    assert.equal(seen.failureShown, true, 'a plain failure message is shown');
    assert.deepEqual(seen.pushed, [], 'the page does not move on as if the hello had been posted');
    assert.equal(onboardingPatches(seen).some((b: any) => b?.first_message_sent === true), false, 'the hello is not recorded as sent');
  });
}
