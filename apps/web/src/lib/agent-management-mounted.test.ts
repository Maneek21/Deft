import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real agent settings pages inside the real AuthProvider, mounted in
// Chromium. An agent that is or was an owner or admin is managed only by the
// owner: an admin who is not the owner sees no Pause or Delete for it on the
// fleet page, and its key, certification and webhook controls are disabled.
// A member-level agent is managed by admins as before. The API sends
// `management` with each agent (apps/api/src/lib/agent-management.ts).
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const NEXT_STUBS: Record<string, string> = {
  'next/navigation': 'export const usePathname = () => window.location.pathname; export const useParams = () => window.__params ?? {}; export const useSearchParams = () => new URLSearchParams(window.location.search); export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }); export const redirect = () => {};',
  'next/link': "import { createElement } from 'react'; export default function Link({ href, children, prefetch, ...rest }) { return createElement('a', { href, ...rest }, children); }",
  'next/image': "import { createElement } from 'react'; export default function Image({ priority, ...rest }) { return createElement('img', rest); }",
};

function token(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

type Viewer = 'admin' | 'owner';
const management = (viewer: Viewer, ownerOnly: boolean) => ({ owner_only: ownerOnly, can_manage: viewer === 'owner' || !ownerOnly });

function employee(id: string, name: string, ownerOnly: boolean, viewer: Viewer) {
  return {
    id, user_id: `user-${id}`, name, slug: id, role: 'project_manager', is_active: true, is_byoa: true, trust_level: 'standard',
    max_daily_actions: 50, daily_action_count: 3, avatar_url: null, created_at: '2026-11-01T00:00:00Z', last_heartbeat_at: null,
    last_mcp_call_at: null, last_work_outcome_at: null, byoa_model_info: null, heartbeat_enabled: false, heartbeat_interval_min: 30,
    runtime_kind: 'custom', wake_mode: 'poll', certification_status: 'token_issued', unhealthy: false, unhealthy_reason: null,
    management: management(viewer, ownerOnly),
  };
}

function developerPayload(id: string, ownerOnly: boolean, viewer: Viewer) {
  return {
    management: management(viewer, ownerOnly),
    employee: { id, slug: id, name: id, runtime_kind: 'custom', certification_status: 'token_issued', is_byoa: true },
    certification: null,
    runtime_setup: {
      runtime_kind: 'custom', tool_server_name: null, channel_protocol_version: '1', channel_capabilities: [], integration_version: null,
      integration_bundle_url: null, integration_bundle_status: null, integration_bundle_detail: null, mcp_endpoint_url: 'http://127.0.0.1/mcp',
      channel_endpoint_url: 'http://127.0.0.1/channel', tool_name_style: 'bare', tool_call_names: [], setup_steps: [], commands: [],
      config_snippet: null, bridge_script: null, certification_prompt: '', troubleshooting: [],
    },
    onboarding_preflight: null,
    diagnostics: {
      recent_mcp_calls: [], recent_cooperative_log: [], activity: [],
      recent_channel_events: [{ id: 'ev-1', kind: 'mention', status: 'failed', delivery_count: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' }],
    },
    mcp_endpoint_url: 'http://127.0.0.1/mcp', mcp_token_masked: 'deft_****', mcp_token: null,
    channel_endpoint_url: 'http://127.0.0.1/channel', channel_token_masked: null, channel_token: null,
    channel: {
      protocol_version: '1', connection: null, token: null,
      queue: { pending: 0, delivered: 0, completed: 0, failed: 1, cancelled: 0 },
      metrics: { sample_count: 0, delivery: { p50_ms: null, p95_ms: null }, acknowledgement: { p50_ms: null, p95_ms: null }, completion: { p50_ms: null, p95_ms: null }, oldest_open_age_ms: null },
      recovery: { state: 'setup_required', title: 'Set up the channel', detail: 'No channel key yet.', action: 'regenerate_channel_token' },
    },
  };
}

async function bundle(entry: string, exportName = 'default'): Promise<string> {
  const page = path.join(web, entry);
  const auth = path.join(web, 'src/lib/auth-context.tsx');
  const out = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as Page from ${JSON.stringify(page)};
import { AuthProvider } from ${JSON.stringify(auth)};
createRoot(document.getElementById('root')).render(createElement(AuthProvider, null, createElement(Page[${JSON.stringify(exportName)}])));`,
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
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1"' },
    plugins: [{
      name: 'next-stubs',
      setup(b: any) {
        b.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args: any) => ({ path: args.path, namespace: 'next-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'next-stub' }, (args: any) => ({ contents: NEXT_STUBS[args.path], loader: 'js', resolveDir: web }));
      },
    }],
  });
  return out.outputFiles[0].text;
}

async function mount(browser: any, script: string, viewer: Viewer, params: Record<string, string>, api: (pathname: string) => unknown) {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(8000);
  await tab.route('**/*', (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1') return route.abort();
    if (url.pathname === '/page') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/auth/me') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 'viewer', name: 'Viewer', email: 'v@example.test', timezone: 'UTC', role: viewer }, org: { id: 'org', name: 'Org', slug: 'org' } }) });
    }
    const body = api(url.pathname);
    if (body === undefined) return route.abort();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await tab.goto('http://127.0.0.1/page');
  await tab.evaluate(({ access, p }: { access: string; p: Record<string, string> }) => {
    localStorage.setItem('deft-access-token', access);
    localStorage.setItem('deft-refresh-token', access);
    (window as any).__params = p;
  }, { access: token({ id: 'viewer', org_id: 'org', sid: 'session', jti: 'v1' }), p: params });
  await tab.addScriptTag({ content: script });
  return tab;
}

test('agent settings pages: an agent that is or was an admin is the owner’s to manage; a member-level agent is not', async () => {
  const fleet = await bundle('src/app/(app)/settings/agent-employees/page.tsx');
  const developer = await bundle('src/app/(app)/settings/agent-employees/[id]/developer/page.tsx');
  const webhooks = await bundle('src/app/(app)/settings/agent-employees/[id]/webhooks/page.tsx');
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  try {
    for (const viewer of ['admin', 'owner'] as const) {
      // Fleet: Pause and Delete per agent.
      const list = [employee('admin-agent', 'Admin Agent', true, viewer), employee('member-agent', 'Member Agent', false, viewer)];
      const fleetTab = await mount(browser, fleet, viewer, {}, (p) => (p === '/api/agent-employees' ? list : undefined));
      await fleetTab.getByText('Member Agent').first().waitFor();
      const fleetControls = async (name: string) => ({
        pause: await fleetTab.getByRole('button', { name: `Pause ${name}` }).count() > 0,
        delete: await fleetTab.getByRole('button', { name: `Delete ${name}` }).count() > 0,
      });
      assert.deepEqual(await fleetControls('Admin Agent'), viewer === 'owner' ? { pause: true, delete: true } : { pause: false, delete: false }, `${viewer}: fleet, admin agent`);
      assert.deepEqual(await fleetControls('Member Agent'), { pause: true, delete: true }, `${viewer}: fleet, member agent`);
      await fleetTab.close();

      for (const [id, ownerOnly] of [['admin-agent', true], ['member-agent', false]] as const) {
        const locked = viewer === 'admin' && ownerOnly;
        // Developer tab: key, certification and delivery controls.
        const devTab = await mount(browser, developer, viewer, { id }, (p) => (p === `/api/agent-employees/${id}/developer` ? developerPayload(id, ownerOnly, viewer) : undefined));
        await devTab.getByRole('button', { name: /Regenerate/ }).first().waitFor();
        const devButtons = devTab.getByRole('button', { name: /Regenerate|Generate token|Start check|Check now|Reset|Retry|Send test event|Run test/ });
        const count = await devButtons.count();
        assert.ok(count >= 3, `${viewer}/${id}: found the developer controls (${count})`);
        for (let i = 0; i < count; i += 1) {
          assert.equal(await devButtons.nth(i).isDisabled(), locked, `${viewer}/${id}: developer button ${await devButtons.nth(i).textContent()}`);
        }
        assert.equal(await devTab.getByRole('note').count() > 0, locked, `${viewer}/${id}: owner-only note`);
        await devTab.close();

        // Webhooks tab: create and revoke.
        const hookTab = await mount(browser, webhooks, viewer, { id }, (p) => {
          if (p === '/api/agent-webhooks') return { webhooks: [{ id: 'hook-1', agent_employee_id: id, slug: 'slug-1', label: 'Hook', enabled: true, last_fired_at: null, fire_count: 0, created_at: '2026-11-01T00:00:00Z' }] };
          if (p === `/api/agent-employees/${id}`) return employee(id, id, ownerOnly, viewer);
          return undefined;
        });
        await hookTab.getByRole('button', { name: 'Revoke webhook Hook' }).waitFor();
        await hookTab.waitForFunction(() => document.readyState === 'complete');
        await hookTab.waitForTimeout(200);
        assert.equal(await hookTab.getByRole('button', { name: /Create webhook/ }).isDisabled(), locked, `${viewer}/${id}: create webhook`);
        assert.equal(await hookTab.getByRole('button', { name: 'Revoke webhook Hook' }).isDisabled(), locked, `${viewer}/${id}: revoke webhook`);
        await hookTab.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('agent overview page: clone, trust and delete on an agent that is or was an admin are the owner’s; a member-level agent is not', async () => {
  const overview = await bundle('src/app/(app)/settings/agent/page.tsx');
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  try {
    for (const viewer of ['admin', 'owner'] as const) {
      const list = [employee('admin-agent', 'Admin Agent', true, viewer), employee('member-agent', 'Member Agent', false, viewer)];
      const tab = await mount(browser, overview, viewer, {}, (p) => {
        if (p === '/api/agent-employees') return list;
        if (p === '/api/agent/actions') return [];
        if (/^\/api\/agent-employees\/[^/]+\/turns$/.test(p)) return { turns: [] };
        return undefined;
      });
      for (const [slug, name, ownerOnly] of [['admin-agent', 'Admin Agent', true], ['member-agent', 'Member Agent', false]] as const) {
        const locked = viewer === 'admin' && ownerOnly;
        // Row menu: Clone agent.
        await tab.getByTestId(`employee-menu-${slug}`).click();
        const clone = tab.getByRole('button', { name: /Clone agent/ });
        await clone.waitFor();
        assert.equal(await clone.isDisabled(), locked, `${viewer}/${slug}: clone`);
        await tab.keyboard.press('Escape');
        // Drawer: trust changes and Delete.
        await tab.getByRole('button', { name: `Open drawer for ${name}` }).click();
        await tab.getByTestId('employee-drawer').waitFor();
        assert.equal(await tab.getByTestId('delete-employee-btn').isDisabled(), locked, `${viewer}/${slug}: delete`);
        assert.equal(await tab.getByTestId('upgrade-autonomous-btn').count(), locked ? 0 : 1, `${viewer}/${slug}: upgrade trust`);
        await tab.getByTestId('drawer-close').click();
        await tab.getByTestId('employee-drawer').waitFor({ state: 'detached' });
      }
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('API access page: a key bound to a deleted agent that was an admin is the owner’s; other keys are not', async () => {
  const page = await bundle('src/app/(app)/settings/api-access/page.tsx');
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  const key = (id: string, name: string, agentId: string | null, viewer: Viewer, ownerOnly: boolean) => ({
    id, name, key_prefix: `deft_${id}`, agent_employee_id: agentId, permissions: ['mcp:full'], rate_limit_per_minute: 60, rate_limit_per_day: 1000,
    last_used_at: null, request_count: 0, is_active: true, expires_at: null, created_at: '2026-11-01T00:00:00Z', management: management(viewer, ownerOnly),
  });
  try {
    for (const viewer of ['admin', 'owner'] as const) {
      // The deleted agent is absent from /api/agent-employees; the key itself says it is owner-only.
      const keys = [key('k1', 'Deleted admin agent key', 'deleted-agent', viewer, true), key('k2', 'Member agent key', 'member-agent', viewer, false)];
      const tab = await mount(browser, page, viewer, {}, (p) => {
        if (p === '/api/api-keys') return keys;
        if (p === '/api/agent-employees') return [employee('member-agent', 'Member Agent', false, viewer)];
        return undefined;
      });
      await tab.getByText('Member agent key').waitFor();
      const toggles = tab.locator('button[title="Deactivate"]');
      // The member-level agent's key always has its toggle; the deleted admin agent's only for the owner.
      assert.equal(await toggles.count(), viewer === 'owner' ? 2 : 1, `${viewer}: key toggles`);
      assert.equal(await tab.getByText('Owner only').count(), viewer === 'owner' ? 0 : 1, `${viewer}: owner-only label`);
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});
