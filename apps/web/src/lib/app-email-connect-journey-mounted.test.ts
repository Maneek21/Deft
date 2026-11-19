import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A workspace owner takes the Email App from upload to the Connect account
// button using only the screens: the real Apps settings page and the real
// installed App page, mounted in Chromium. Every API answer is a real answer
// recorded from a local hosted-mode Deft cell walking the real Email package
// (see the fixture's `source`), so the field names are the server's, not ours.
// The one step without a screen, admitting the account operator, happened on
// the server before the recording and appears here as its result.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

type Answer = { status: number; body: unknown };
const fixture = JSON.parse(readFileSync(path.join(web, 'test/fixtures/email-app-connect-journey.json'), 'utf8')) as {
  source: { recorded_at: string; installation_id: string }; package: string; bundle: unknown; answers: Record<string, Answer>;
};
const answers = fixture.answers;
const installation = fixture.source.installation_id;
const ORIGIN = 'http://127.0.0.1';

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useSearchParams = () => new URLSearchParams(window.location.search); export const useParams = () => ({}); export const notFound = () => { throw new Error("not found"); }; export const useRouter = () => ({ push(u) { window.location.assign(u); }, replace(u) { window.location.replace(u); }, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

async function bundle(): Promise<string> {
  const entry = `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from ${JSON.stringify(path.join(web, 'src/lib/auth-context.tsx'))};
import { AppHeaderProvider } from ${JSON.stringify(path.join(web, 'src/components/app-header-context.tsx'))};
import { AppsClient } from ${JSON.stringify(path.join(web, 'src/app/(app)/settings/apps/apps-client.tsx'))};
import { InstalledAppExperience } from ${JSON.stringify(path.join(web, 'src/components/apps/installed-app-experience.tsx'))};
import { ExperienceNavigationProvider } from ${JSON.stringify(path.join(web, 'src/components/apps/experience-navigation-context.tsx'))};
const parts = window.location.pathname.split('/').filter(Boolean);
const view = parts[0] === 'apps' ? createElement(InstalledAppExperience, { installationId: parts[1], experienceKey: parts[2] })
  : createElement(AppsClient, parts[2] ? { selectedId: parts[2] } : {});
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(AppHeaderProvider, null, createElement(ExperienceNavigationProvider, null, view))));`;
  const result = await build({
    stdin: { contents: entry, resolveDir: web, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    banner: { js: 'var process = { env: {} };' }, loader: { '.css': 'empty' },
    alias: { '@/lib/socket': path.join(web, 'test/mounted/deft-socket.ts'), '@': path.join(web, 'src') },
    define: {
      'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(ORIGIN),
      'process.env.NEXT_PUBLIC_FEATURE_APPS': '"true"', 'process.env.NEXT_PUBLIC_FEATURE_APP_RESOURCE_SYNC': '"true"',
      'process.env.NEXT_PUBLIC_FEATURE_APP_ATTACHMENT_BROKER': '"true"',
    },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

const expand = (value: unknown): unknown => value === '$package' ? JSON.parse(fixture.package) : value === '$bundle' ? fixture.bundle
  : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;

test('Email App: an owner gets from upload to the Connect account button with screens only', { timeout: 180_000 }, async () => {
  const script = await bundle();
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  // What the recorded workspace had done so far. Answers follow it, as the server's did.
  const state = { phase: 'empty' as 'empty' | 'staged' | 'active', account: false };
  const posted: Array<{ path: string; body: any }> = [];
  const unrecorded: string[] = [];
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    tab.setDefaultTimeout(15_000);
    // The recorded consents and reviews carry deadlines; run at the recording time.
    await tab.clock.setFixedTime(new Date(fixture.source.recorded_at));
    await tab.route('**/*', async (route: any) => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
      const reply = (answer: Answer) => route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(expand(answer.body)) });
      if (url.origin !== ORIGIN) return route.abort();
      if (p === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (!p.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      if (method !== 'GET') posted.push({ path: p, body });
      const app = `/api/apps/${installation}`, blob = `/api/apps/blob/composition/${installation}`, experience = `/api/app-experiences/${installation}/main`;
      if (p === '/api/auth/me' && method === 'GET') return reply(answers.auth_me);
      if (p === '/api/modules') return reply(answers.modules);
      if (p === '/api/apps/navigation') return reply(answers.navigation);
      if (p === '/api/members') return reply(answers.members);
      if (p === '/api/attention') return reply(answers.attention);
      if (p === '/api/spaces') return reply(answers.spaces);
      if (p === '/api/spaces/unread') return reply(answers.unread);
      if (p === '/api/apps') return reply(answers[`apps_${state.phase}`]);
      if (p === '/api/apps/inspect') return reply(answers.inspect);
      if (p === '/api/apps/blob/composition/stage') { state.phase = 'staged'; return reply(answers.stage); }
      if (p === `${app}/upgrade-trust`) return reply(answers.upgrade_trust);
      if (p === `${blob}/context`) return reply(answers.blob_context);
      if (p === `${blob}/review`) return reply(answers.blob_review);
      if (p === `${blob}/activate`) { state.phase = 'active'; return reply(answers.blob_activate); }
      if (p === `${app}/grants`) return reply(answers.grants);
      if (p === `${blob}/runtime/targets`) return reply(answers.runtime_targets);
      if (p === `${blob}/runtime/context`) return reply(answers.runtime_context);
      if (p === `${experience}/targets`) return reply(state.account ? answers.targets_personal : answers.targets_none);
      if (p === `${experience}/sessions`) return reply(body?.resource_target_key === 'personal' ? answers.session_personal : answers.session_primary);
      if (method === 'DELETE' && /^\/api\/app-experiences\/sessions\/[^/]+$/.test(p)) return reply(answers.session_retire);
      if (/^\/api\/app-experiences\/sessions\/[^/]+\/access\/acquire$/.test(p)) return reply(state.account ? answers.acquire_review_required : answers.acquire_unavailable);
      if (p === `/api/app-owner-connections/${installation}/context`) return reply(state.account ? answers.owner_context_bound : answers.owner_context_admitted);
      if (p === `/api/app-owner-connections/${installation}/connections`) return reply(answers.owner_connections_list);
      if (p === `/api/app-connection-forms/installations/${installation}/context`) return reply(state.account ? answers.forms_context_connectable : answers.forms_context_none);
      if (p === `/api/app-connection-sessions/installations/${installation}/context`) return reply(answers.connection_context);
      if (p === `/api/app-connection-sessions/installations/${installation}/consent-continuation-context`) return reply(answers.consent_continuation_context);
      if (p === `/api/app-connection-sessions/installations/${installation}/upgrade-context`) return reply(answers.upgrade_context);
      if (p === '/api/app-owner-connections/resources/review') {
        // The server refuses a first account permission without an end date,
        // and otherwise reviews the requested end date as sent.
        if (body.consent_expires_at === null) return reply(answers.resource_review_until_revoked);
        const review = answers.resource_review.body as { review: Record<string, unknown> };
        return reply({ status: 200, body: { review: { ...review.review, consent_expires_at: body.consent_expires_at } } });
      }
      if (p === '/api/app-owner-connections/resources/activate') { state.account = true; return reply(answers.resource_activate); }
      unrecorded.push(`${method} ${p}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not recorded', code: 'NOT_FOUND' }) });
    });
    await tab.goto(`${ORIGIN}/settings/apps`);
    const owner = answers.auth_me.body as { user: { id: string }; org: { id: string } };
    const access = `header.${Buffer.from(JSON.stringify({ id: owner.user.id, org_id: owner.org.id, sid: 'journey-session', jti: 'journey' })).toString('base64url')}.signature`;
    await tab.evaluate((token: string) => { localStorage.setItem('deft-access-token', token); localStorage.setItem('deft-refresh-token', token); }, access);
    await tab.reload();

    // Upload the real package and stage it.
    await tab.getByText('No Apps installed').waitFor();
    await tab.getByLabel('Choose a Deft App package').setInputFiles({ name: 'app.deft.json', mimeType: 'application/json', buffer: Buffer.from(fixture.package) });
    await tab.getByRole('button', { name: /Stage/ }).click();
    await tab.getByText('Connected App staged for explicit authority review.').waitFor();

    // Review and activate it. The review lists the server's runtime actions.
    await tab.getByLabel('Installed Apps').getByRole('link').first().click();
    await tab.getByRole('button', { name: 'Review App activation' }).click();
    await tab.getByRole('button', { name: 'Accept review and activate' }).waitFor();
    await tab.getByText('Declared actions: mirror_drafts, organize_messages, send_message.', { exact: false }).waitFor();
    await tab.getByRole('button', { name: 'Accept review and activate' }).click();
    await tab.getByText('Enabled · approved for use').waitFor();

    // A new owner opening the Inbox is offered account setup, not a dead end.
    await tab.getByText('Open Inbox', { exact: true }).first().click();
    await tab.getByRole('button', { name: 'Set up account' }).click();
    await tab.getByRole('button', { name: 'Review account permission' }).click();
    await tab.getByRole('button', { name: 'Allow and continue to connect' }).click();
    await tab.getByText('Account permission saved.', { exact: false }).waitFor();
    const review = posted.find(item => item.path === '/api/app-owner-connections/resources/review');
    assert.ok(review && typeof review.body.consent_expires_at === 'string' && review.body.consent_lifetime === undefined,
      'the first account permission is sent with an end date');
    assert.ok(posted.some(item => item.path === '/api/app-owner-connections/resources/activate'), 'approving the account permission sends it');

    // Reopen the Inbox: the account exists, so account settings offer Connect.
    await tab.reload();
    await tab.getByRole('button', { name: 'Review private access' }).waitFor();
    await tab.getByRole('button', { name: 'Account settings' }).click();
    const connect = tab.getByRole('button', { name: 'Connect account', exact: true });
    await connect.waitFor();
    assert.equal(await connect.isEnabled(), true);
    assert.deepEqual(unrecorded.filter(entry => !entry.startsWith('GET ')), [], 'every write the screens sent has a recorded answer');
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    const shown = page ? await page.locator('[role=alert],[role=status]').allInnerTexts().catch(() => []) : [];
    throw new Error(`${error instanceof Error ? error.message.split('\n')[0] : error}; on screen: ${shown.join(' | ')}; unrecorded: ${unrecorded.join(', ')}`);
  } finally {
    await browser.close();
  }
});
