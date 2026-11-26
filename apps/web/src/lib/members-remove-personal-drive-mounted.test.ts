import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real Members settings page inside the real AuthProvider, mounted in
// Chromium and viewed by the owner. When the person being removed has a
// personal drive with documents in it (the offboarding preview says so), the
// remove dialog shows the replacement picker even with no open work, and asks
// explicitly: hand the drive to the replacement, or freeze it. Removal stays
// disabled until a preview has loaded; a failed preview shows its error and a
// retry. The test reads the DELETE /api/members/:id body the dialog actually
// sends (spec 5.2, F6).
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

const stats = { spaces: 0, assigned_tasks_open: 0, assigned_tasks_total: 0, led_projects: 0, wiki_pages: 0, active_mcp_tokens: 0, active_api_keys: 0, active_oauth_grants: 0 };
function member(id: string, name: string) {
  return {
    id, name, email: `${id}@example.test`, kind: 'human', avatar_url: null, title: null, profile_summary: null,
    expertise_tags: [], timezone: 'UTC', status_emoji: null, status_text: null, last_seen_at: null, email_verified: true,
    role: 'member', owner_only: false, is_active: true, joined_at: null, lifecycle_status: 'active', pending_invite_id: null, pending_invite_expires_at: null,
    stats, agent: null,
  };
}
// The dialog's default replacement is the first other active member: the heir.
const MEMBERS = [member('heir', 'Hal Heir'), member('leaver', 'Lea Leaver'), member('other', 'Ola Other')];

function preview(openTasks: number, personalDriveWithDocuments: boolean) {
  return {
    personal_drive_with_documents: personalDriveWithDocuments,
    revoke_now: { spaces: [], teams: [], groups: [], secondary_task_assignments: 0, active_mcp_tokens: 0, active_api_keys: 0, active_oauth_grants: 0 },
    needs_reassignment: { primary_open_tasks: [], led_projects: [], led_teams: [] },
    counts: {
      spaces: 0, teams: 0, groups: 0, primary_open_tasks: openTasks, secondary_task_assignments: 0, led_projects: 0, led_teams: 0,
      active_mcp_tokens: 0, active_api_keys: 0, active_oauth_grants: 0,
    },
  };
}

type Scenario = {
  openTasks: number;
  personalDrive: boolean;
  /** 'hand_over' or 'freeze' clicks that radio; null clicks neither. */
  choose: 'hand_over' | 'freeze' | null;
  /** The first preview request fails with a 500; the dialog's retry loads it. */
  failFirstPreview?: boolean;
};
type Seen = {
  radios: boolean; picker: boolean; disabledBeforeChoice: boolean; line: string | null; body: Record<string, unknown>;
  /** While the preview had failed: its error, the retry, Confirm disabled, no choice shown and nothing sent. */
  failed?: { error: string | null; retry: boolean; confirmDisabled: boolean; radios: boolean; deletes: number };
};

let bundled: string | null = null;
async function bundle(): Promise<string> {
  if (bundled) return bundled;
  const page = path.join(web, 'src/app/(app)/settings/members/page.tsx');
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const result = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import MembersPage from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(MembersPage)));`,
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
  bundled = result.outputFiles[0].text as string;
  return bundled;
}

async function removeLeaver(browser: any, scenario: Scenario): Promise<Seen> {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(6000);
  let deleteBody: Record<string, unknown> | null = null;
  let deletes = 0;
  let previews = 0;
  await tab.route('**/*', (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== 'http://127.0.0.1') return route.abort();
    if (url.pathname === '/settings/members') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/auth/me') {
      return json({ user: { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', timezone: 'UTC', role: 'owner' }, org: { id: 'org', name: 'Org', slug: 'org' } });
    }
    if (url.pathname === '/api/members/directory') return json({ members: MEMBERS, invites: [], summary: { active: 3, pending: 0, inactive: 0, agents: 0 } });
    if (url.pathname === '/api/members/seats') return json({ hosted: false });
    if (url.pathname === '/api/members/leaver/offboarding-preview') {
      previews += 1;
      if (scenario.failFirstPreview && previews === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Failed to load offboarding preview', code: 'INTERNAL_ERROR' }) });
      }
      return json(preview(scenario.openTasks, scenario.personalDrive));
    }
    if (url.pathname === '/api/members/leaver' && request.method() === 'DELETE') {
      deletes += 1;
      deleteBody = JSON.parse(request.postData() ?? '{}');
      return json({ success: true, receipt: {} });
    }
    const detail = /^\/api\/members\/([^/]+)\/detail$/.exec(url.pathname);
    if (detail) {
      return json({ member: MEMBERS.find((m) => m.id === detail[1]), spaces: [], open_tasks: [], led_projects: [], pending_invites: [], mcp_tokens: [], oauth_grants: [] });
    }
    return route.abort();
  });
  await tab.goto('http://127.0.0.1/settings/members');
  await tab.evaluate((access: string) => {
    localStorage.setItem('deft-access-token', access);
    localStorage.setItem('deft-refresh-token', access);
  }, token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }));
  await tab.addScriptTag({ content: await bundle() });

  await tab.getByRole('button', { name: /Lea Leaver/ }).first().click();
  await tab.getByText('Admin actions').waitFor();
  await tab.getByRole('button', { name: 'Remove', exact: true }).click();
  await tab.getByText('Remove Lea Leaver?').waitFor();
  const confirm = tab.getByRole('button', { name: scenario.openTasks > 0 ? 'Transfer and remove' : 'Confirm remove' });
  let failed: Seen['failed'];
  if (scenario.failFirstPreview) {
    const retryButton = tab.getByTestId('offboarding-preview-retry');
    await retryButton.waitFor();
    // Without a preview the button reads "Confirm remove" (no open work is known yet).
    const confirmNow = tab.getByRole('button', { name: 'Confirm remove' });
    failed = {
      error: (await tab.getByText('Failed to load offboarding preview').textContent())?.trim() ?? null,
      retry: await retryButton.isVisible(),
      confirmDisabled: await confirmNow.isDisabled(),
      radios: await tab.getByTestId('offboarding-drive-hand-over').count() > 0,
      deletes,
    };
    await retryButton.click();
  }
  await tab.getByText(/Also revokes/).waitFor();

  const radios = await tab.getByTestId('offboarding-drive-hand-over').count() > 0;
  const picker = await tab.getByTestId('offboarding-replacement-select').count() > 0;
  const disabledBeforeChoice = await confirm.isDisabled();
  if (scenario.choose === 'hand_over') await tab.getByTestId('offboarding-drive-hand-over').check();
  if (scenario.choose === 'freeze') await tab.getByTestId('offboarding-drive-freeze').check();
  const lineLocator = tab.getByTestId('offboarding-personal-drive');
  const line = await lineLocator.count() > 0 ? (await lineLocator.textContent())?.trim() ?? null : null;
  await confirm.click();
  await tab.waitForFunction(() => !document.body.textContent?.includes('Remove Lea Leaver?'));
  await tab.close();
  assert.ok(deleteBody, 'the dialog sent DELETE /api/members/leaver');
  assert.equal(deletes, 1, 'one DELETE');
  return { radios, picker, disabledBeforeChoice, line, body: deleteBody, failed };
}

test('Members page: the remove dialog hands My drive to the chosen replacement, or freezes it, and sends exactly that', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  try {
    // No open work, but a drive with documents: the picker and the choice show, and nothing is sent until one is made.
    const handOver = await removeLeaver(browser, { openTasks: 0, personalDrive: true, choose: 'hand_over' });
    assert.equal(handOver.radios, true);
    assert.equal(handOver.picker, true);
    assert.equal(handOver.disabledBeforeChoice, true, 'an explicit choice is required');
    assert.equal(handOver.line, 'Their personal drive goes to Hal Heir.');
    assert.deepEqual(handOver.body, { replacement_user_id: 'heir', personal_drive: 'hand_over' });

    const freeze = await removeLeaver(browser, { openTasks: 0, personalDrive: true, choose: 'freeze' });
    assert.equal(freeze.line, 'Their personal drive will be frozen until an owner hands it on.');
    assert.deepEqual(freeze.body, { replacement_user_id: null, personal_drive: 'freeze' });

    // Open work goes to the replacement whatever is chosen for the drive.
    const workButFreeze = await removeLeaver(browser, { openTasks: 2, personalDrive: true, choose: 'freeze' });
    assert.equal(workButFreeze.disabledBeforeChoice, true);
    assert.deepEqual(workButFreeze.body, { replacement_user_id: 'heir', personal_drive: 'freeze' });

    const workAndDrive = await removeLeaver(browser, { openTasks: 2, personalDrive: true, choose: 'hand_over' });
    assert.deepEqual(workAndDrive.body, { replacement_user_id: 'heir', personal_drive: 'hand_over' });

    // No documents in a personal drive and no open work: no picker, no choice, nothing handed over.
    const nothing = await removeLeaver(browser, { openTasks: 0, personalDrive: false, choose: null });
    assert.equal(nothing.radios, false);
    assert.equal(nothing.picker, false);
    assert.equal(nothing.disabledBeforeChoice, false);
    assert.equal(nothing.line, null);
    assert.deepEqual(nothing.body, { replacement_user_id: null, personal_drive: 'freeze' });

    // A failed preview: an error and a retry, Confirm disabled, no choice offered and nothing sent;
    // after the retry the explicit choice is required as usual.
    const retried = await removeLeaver(browser, { openTasks: 0, personalDrive: true, choose: 'hand_over', failFirstPreview: true });
    assert.deepEqual(retried.failed, { error: 'Failed to load offboarding preview', retry: true, confirmDisabled: true, radios: false, deletes: 0 });
    assert.equal(retried.radios, true);
    assert.equal(retried.disabledBeforeChoice, true);
    assert.deepEqual(retried.body, { replacement_user_id: 'heir', personal_drive: 'hand_over' });

    // Open work only: the replacement is sent for the work; the empty drive is frozen.
    const workOnly = await removeLeaver(browser, { openTasks: 1, personalDrive: false, choose: null });
    assert.equal(workOnly.radios, false);
    assert.equal(workOnly.picker, true);
    assert.deepEqual(workOnly.body, { replacement_user_id: 'heir', personal_drive: 'freeze' });
  } finally {
    await browser.close();
  }
});
