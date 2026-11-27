import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real notes page inside the real AuthProvider, mounted in Chromium, with
// the API answered by page.route the way the server answers. The note's owner
// opens Share note: "Add people" lists the workspace's people from
// /api/members (whose ids are `id`), without the owner, the people the note is
// already shared with, or Defty, which reads notes as the person asking it and
// so gains nothing from a share. Picking a person sends their id; the share
// route answers `{}` with 400 "user_id required", as it did live on 156.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'const params = {}; export const usePathname = () => window.location.pathname; export const useParams = () => params; export const useSearchParams = () => new URLSearchParams(window.location.search); export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};
const NOTE = 'note-1';
const OWNER = { id: 'owner', name: 'Sam Owner', email: 'sam@example.test', kind: 'human', role: 'owner' };
const RAJ = { id: 'raj', name: 'Raj Patel', email: 'raj@example.test', kind: 'human', role: 'member' };
const ANA = { id: 'ana', name: 'Ana Silva', email: 'ana@example.test', kind: 'human', role: 'member' };
const DEFTY = { id: 'defty', name: 'Defty', email: 'deft-agent@system.local', kind: 'agent', role: 'member', is_defty: true };
const HELPER = { id: 'helper-agent', name: 'Release Helper', email: 'helper@agents.local', kind: 'agent', role: 'member' };
const MEMBERS = [OWNER, RAJ, ANA, DEFTY, HELPER];

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

type ShareAnswer = 'server' | { status: number; body: unknown };
type Seen = {
  offered: string[];
  sharedWith: string[];
  requests: Array<{ method: string; path: string; body: unknown }>;
  alert: string | null;
};

type ShareRow = { id: string; user_id: string; permission: string; user_name: string | null; user_email: string | null };
type View = { members?: Array<Record<string, unknown>>; shares?: ShareRow[] };

async function shareWith(person: string | null, answer: ShareAnswer, afterShare?: (tab: any) => Promise<void>, view: View = {}): Promise<Seen> {
  const page = path.join(web, 'src/app/(app)/notes/page.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const header = path.join(web, 'src/components/app-header-context.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import NotesPage from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
import { AppHeaderProvider } from ${JSON.stringify(header)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(AppHeaderProvider, null, createElement(NotesPage))));`,
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
  // The note starts shared with Ana.
  const members = view.members ?? MEMBERS;
  const shares: ShareRow[] = view.shares ? [...view.shares] : [
    { id: 'share-ana', user_id: ANA.id, permission: 'view', user_name: ANA.name, user_email: ANA.email },
  ];
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    tab.setDefaultTimeout(8000);
    await tab.route('**/*', (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== 'http://127.0.0.1') return route.abort();
      if (url.pathname === '/notes') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      const raw = request.postData();
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: request.method(), path: url.pathname, body });
      if (url.pathname === '/api/auth/me') {
        return json({ user: { id: OWNER.id, name: OWNER.name, email: OWNER.email, timezone: 'UTC', role: 'owner' }, org: { id: 'org', name: 'Launch Co', slug: 'launch' } });
      }
      if (url.pathname === '/api/members') return json(members);
      if (url.pathname === '/api/daily-notes') return json([]);
      if (url.pathname === '/api/daily-notes/folders') return json({ folders: [] });
      if (url.pathname === '/api/daily-notes/templates') return json({ templates: [] });
      if (url.pathname === `/api/notes/${NOTE}/references`) return json({ references: [] });
      if (url.pathname === `/api/daily-notes/${NOTE}`) {
        return json({ id: NOTE, title: 'Launch plan', content: '<p>Plan</p>', icon: null, user_id: OWNER.id, visibility: 'private', is_pinned: false, folder_id: null, version: 1, created_at: '2026-11-27T10:00:00Z', updated_at: '2026-11-27T10:00:00Z' });
      }
      if (url.pathname === `/api/daily-notes/${NOTE}/shares` && request.method() === 'GET') return json({ shares });
      if (url.pathname === `/api/daily-notes/${NOTE}/shares` && request.method() === 'POST') {
        if (answer !== 'server') return json(answer.body, answer.status);
        // As the server: no user_id is a 400; an id that is not an active member is a 404.
        if (typeof body?.user_id !== 'string' || !body.user_id) return json({ error: 'user_id required', code: 'VALIDATION_ERROR' }, 400);
        const member = members.find((m) => m.id === body.user_id) as { id: string; name: string | null; email: string | null } | undefined;
        if (!member) return json({ error: 'Member not found or inactive', code: 'MEMBER_NOT_FOUND' }, 404);
        const share = { id: `share-${member.id}`, user_id: member.id, permission: 'view', user_name: member.name, user_email: member.email };
        shares.push(share);
        return json({ id: share.id, note_id: NOTE, shared_with_user_id: member.id, permission: 'view' }, 201);
      }
      const removal = url.pathname.match(new RegExp(`^/api/daily-notes/${NOTE}/shares/([^/]+)$`));
      if (removal && request.method() === 'DELETE') {
        const index = shares.findIndex((s) => s.user_id === decodeURIComponent(removal[1]!));
        if (index >= 0) shares.splice(index, 1);
        return json({ success: true });
      }
      return route.abort();
    });
    await tab.goto(`http://127.0.0.1/notes?id=${NOTE}`);
    await tab.evaluate((access: string) => {
      localStorage.setItem('deft-access-token', access);
      localStorage.setItem('deft-refresh-token', access);
    }, token({ id: OWNER.id, org_id: 'org', sid: 'session', jti: 'n1' }));
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });

    await tab.getByRole('button', { name: 'Share note' }).click();
    const dialog = tab.locator('div', { has: tab.getByRole('heading', { name: 'Share Note' }) }).last();
    await dialog.getByText('Add people').waitFor();
    await dialog.getByRole('button', { name: HELPER.name }).waitFor();
    const addPeople = dialog.locator('div.max-h-40 button');
    const offered = await addPeople.allInnerTexts();

    if (person) {
      const answered = tab.waitForResponse((r: any) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/daily-notes/${NOTE}/shares`);
      await dialog.getByRole('button', { name: person }).click();
      await answered;
      // Let the dialog re-read the shares and render the answer.
      await tab.waitForTimeout(500);
    }
    if (afterShare) await afterShare(tab);
    await tab.waitForTimeout(200);
    const sharedWith = (await dialog.locator('span').allInnerTexts()).filter((t: string) => /\((view|edit)\)$/.test(t));
    const alerts = await tab.getByRole('alert').allInnerTexts();
    return { offered: offered.map((t: string) => t.trim()), sharedWith, requests, alert: alerts.join(' ') || null };
  } finally {
    await browser.close();
  }
}

const sharePosts = (seen: Seen) => seen.requests.filter((r) => r.method === 'POST' && r.path === `/api/daily-notes/${NOTE}/shares`);

test('note Share: "Add people" offers the workspace\'s people, not the owner, not those already shared with, not Defty', async () => {
  const seen = await shareWith(null, 'server');
  assert.deepEqual(seen.offered, [RAJ.name, HELPER.name]);
});

test('note Share: picking a person sends their id, and they are listed as shared with', async () => {
  const seen = await shareWith(RAJ.name, 'server');
  assert.deepEqual(sharePosts(seen).map((r) => r.body), [{ user_id: RAJ.id }]);
  assert.deepEqual(seen.sharedWith, [`${ANA.name} (view)`, `${RAJ.name} (view)`]);
  assert.equal(seen.alert, null);
});

test('note Share: an agent employee can be picked and is sent by id', async () => {
  const seen = await shareWith(HELPER.name, 'server');
  assert.deepEqual(sharePosts(seen).map((r) => r.body), [{ user_id: HELPER.id }]);
  assert.ok(seen.sharedWith.includes(`${HELPER.name} (view)`));
});

test('note Share: Remove takes a person off the note', async () => {
  const seen = await shareWith(null, 'server', async (tab) => {
    const row = tab.locator('div.py-1\\.5', { hasText: `${ANA.name} (view)` });
    await row.getByRole('button', { name: 'Remove' }).click();
    await row.waitFor({ state: 'detached' });
  });
  assert.ok(seen.requests.some((r) => r.method === 'DELETE' && r.path === `/api/daily-notes/${NOTE}/shares/${ANA.id}`));
  assert.deepEqual(seen.sharedWith, []);
});

test('note Share: when the server refuses the share, the dialog says so', async () => {
  const seen = await shareWith(RAJ.name, { status: 404, body: { error: 'Member not found or inactive', code: 'MEMBER_NOT_FOUND' } });
  assert.deepEqual(sharePosts(seen).map((r) => r.body), [{ user_id: RAJ.id }]);
  assert.match(seen.alert ?? '', /couldn.t share/i);
  assert.match(seen.alert ?? '', /Raj Patel/);
  assert.deepEqual(seen.sharedWith, [`${ANA.name} (view)`]);
});

// A guest sees no email address but their own (people-visibility), so Defty is
// known by the members list's is_defty flag, not by its address.
const asGuestSees = (m: Record<string, unknown>) => ({ ...m, email: m.id === OWNER.id ? OWNER.email : null });

test('note Share: a guest owner is not offered Defty either, though the members list hides its email', async () => {
  const seen = await shareWith(null, 'server', undefined, { members: MEMBERS.map(asGuestSees), shares: [] });
  assert.deepEqual(seen.offered, [RAJ.name, ANA.name, HELPER.name]);
});

test('note Share: a share row with no name shows the email, or "Someone" when neither can be shown', async () => {
  const seen = await shareWith(null, 'server', undefined, {
    shares: [
      { id: 'share-raj', user_id: RAJ.id, permission: 'view', user_name: '', user_email: RAJ.email },
      { id: 'share-hidden', user_id: 'hidden', permission: 'view', user_name: null, user_email: null },
    ],
  });
  assert.deepEqual(seen.sharedWith, [`${RAJ.email} (view)`, 'Someone (view)']);
});
