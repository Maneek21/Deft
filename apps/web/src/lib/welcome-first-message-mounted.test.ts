import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real welcome page inside the real AuthProvider, mounted in Chromium,
// with the API answered by page.route. Its last step, "Say hello in
// #general", posts the hello to #general through the chat route (POST
// /api/messages/:spaceId, with an Idempotency-Key a retry reuses) and then
// finishes onboarding, with the button disabled until it has. When the hello
// can't be posted, or there is no #general, the person is told so on that
// step instead of being sent on as if it had worked.
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
const NO_GENERAL = "There's no #general";
const SPACES = [
  { id: 'space-launch', name: 'launch', type: 'public', is_default: false },
  { id: GENERAL, name: 'general', type: 'public', is_default: true },
];

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

type MessageAnswer = { status: number; body: unknown } | 'abort';
type Seen = {
  requests: Array<{ method: string; path: string; body: unknown; key: string | undefined }>;
  pushed: string[];
  failureShown: boolean;
  alert: string;
  disabledWhileFinishing?: boolean;
};
type Options = {
  /** The answers to each hello POST, in order; the last one repeats. */
  answers?: MessageAnswer[];
  spaces?: unknown[];
  /** Hold the "first_message_sent" save this long and read the button meanwhile. */
  holdFinishMs?: number;
  /** After the first failure, optionally edit the text, then click Post again. */
  retry?: { editTo?: string };
};

const POSTED: MessageAnswer = { status: 201, body: { id: 'message-1', space_id: GENERAL, content: HELLO } };

async function postHello(answerOrOptions: MessageAnswer | Options): Promise<Seen> {
  const options: Options = answerOrOptions === 'abort' || 'status' in answerOrOptions
    ? { answers: [answerOrOptions as MessageAnswer] } : answerOrOptions as Options;
  const answers = options.answers ?? [POSTED];
  let posts = 0;
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
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: request.method(), path: url.pathname, body, key: request.headers()['idempotency-key'] });
      if (url.pathname === '/api/auth/me') {
        return json({ user: { id: 'newcomer', name: 'Raj Newcomer', email: 'raj@example.test', timezone: 'UTC', role: 'member' }, org: { id: 'org', name: 'Launch Co', slug: 'launch' } });
      }
      if (url.pathname === '/api/auth/onboarding') {
        if (options.holdFinishMs && body?.first_message_sent) {
          return new Promise((resolve) => setTimeout(resolve, options.holdFinishMs)).then(() => json({ completed: false }));
        }
        return json({ completed: false });
      }
      if (url.pathname === '/api/spaces') return json(options.spaces ?? SPACES);
      if (url.pathname.startsWith('/api/messages/')) {
        const answer = answers[Math.min(posts++, answers.length - 1)]!;
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
    const finishing = options.holdFinishMs
      ? tab.waitForRequest((r: any) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/auth/onboarding' && /first_message_sent/.test(r.postData() ?? ''))
      : null;
    await tab.getByRole('button', { name: 'Post and finish' }).click();
    let disabledWhileFinishing: boolean | undefined;
    if (finishing) {
      await finishing;
      disabledWhileFinishing = await tab.locator('button', { hasText: /Post and finish|Posting/ }).isDisabled();
    }

    // Either the page moves on to the dashboard or it shows an alert.
    const settled = () => tab.waitForFunction(() => (window as any).__pushed?.includes('/dashboard') || document.querySelector('[role="alert"]'));
    await settled();
    if (options.retry) {
      if (options.retry.editTo !== undefined) await tab.getByRole('textbox').fill(options.retry.editTo);
      await tab.getByRole('button', { name: 'Post and finish' }).click();
      await tab.waitForFunction(() => (window as any).__pushed?.includes('/dashboard')).catch(() => {});
    }
    // Let any request the click started settle before reading what was sent.
    await tab.waitForTimeout(300);
    const pushed = await tab.evaluate(() => [...((window as any).__pushed ?? [])]);
    const alert = (await tab.getByRole('alert').allInnerTexts()).join(' ');
    return { requests, pushed, failureShown: alert.includes(FAILED), alert, disabledWhileFinishing };
  } finally {
    await browser.close();
  }
}

const helloPosts = (seen: Seen) => seen.requests.filter((r) => r.method === 'POST' && /messages/.test(r.path));
const messagePosts = (seen: Seen) => helloPosts(seen).map(({ key: _key, ...rest }) => rest);
const messageKeys = (seen: Seen) => helloPosts(seen).map((r) => r.key);
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

test('welcome: Post and finish stays disabled until onboarding is finished, so a second click cannot post twice', async () => {
  const seen = await postHello({ holdFinishMs: 1500 });
  assert.equal(seen.disabledWhileFinishing, true);
  assert.equal(messagePosts(seen).length, 1);
  assert.deepEqual(seen.pushed, ['/dashboard']);
});

test('welcome: the hello carries an Idempotency-Key, and a retry after no answer reuses it', async () => {
  const seen = await postHello({ answers: ['abort', POSTED], retry: {} });
  const keys = messageKeys(seen);
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[0].length >= 16, 'a key is sent');
  assert.equal(keys[1], keys[0], 'the retry of the same hello reuses the key, so the server posts it once');
  assert.deepEqual(seen.pushed, ['/dashboard']);
});

test('welcome: an edited hello after a failure is a new hello with a new key', async () => {
  const seen = await postHello({ answers: [{ status: 500, body: { error: 'Internal error' } }, POSTED], retry: { editTo: 'Hello all!' } });
  const keys = messageKeys(seen);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[1], keys[0]);
  assert.deepEqual(messagePosts(seen).map((r) => r.body), [{ content: HELLO }, { content: 'Hello all!' }]);
});

test('welcome: with no #general, the hello is not posted to another space and the person is told', async () => {
  const seen = await postHello({ spaces: [{ id: 'private-leadership', name: 'leadership', type: 'private', is_default: false }] });
  assert.deepEqual(messagePosts(seen), []);
  assert.match(seen.alert, new RegExp(NO_GENERAL));
  assert.deepEqual(seen.pushed, []);
});
