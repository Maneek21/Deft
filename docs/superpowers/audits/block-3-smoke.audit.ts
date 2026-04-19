#!/usr/bin/env tsx
/**
 * Block 3 end-to-end smoke — power users + ecosystem polish.
 * Runs against dev API on :3001 + web on :3000. maneek@test.com.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/block-3-smoke';
const REPORT = 'docs/superpowers/audits/block-3-smoke.last-run.txt';

const log: Array<{ level: 'ok' | 'fail' | 'info'; msg: string }> = [];
const ok = (m: string) => { log.push({ level: 'ok', msg: m }); console.log('OK', m); };
const fail = (m: string) => { log.push({ level: 'fail', msg: m }); console.error('FAIL', m); };
const info = (m: string) => { log.push({ level: 'info', msg: m }); console.log('INFO', m); };
const assertTrue = (c: boolean, m: string) => { if (c) ok(m); else fail(m); return c; };

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: (j.access_token ?? j.accessToken) as string,
    refreshToken: (j.refresh_token ?? j.refreshToken) as string | undefined,
    orgId: (j.org_id ?? j.orgId) as string,
    userId: (j.user as { id: string } | undefined)?.id ?? '',
  };
}

async function api<T>(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const txt = await res.text();
  let body: unknown = txt;
  try { body = JSON.parse(txt); } catch { /* keep text */ }
  return { status: res.status, body: body as T };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
  info(`screenshot ${SHOT_DIR}/${name}.png`);
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  const auth = await login();
  ok(`login: org=${auth.orgId.slice(0, 8)}`);

  // ── API: 3.1 clone ───────────────────────────────────────────────
  const emps = await api<Array<{ id: string; name: string; slug: string }>>(
    '/api/agent-employees', auth.accessToken,
  );
  const firstEmp = Array.isArray(emps.body) ? emps.body[0] : undefined;
  if (firstEmp) {
    const clone = await api<{ employee: { id: string; slug: string } }>(
      `/api/agent-employees/${firstEmp.id}/clone`,
      auth.accessToken,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assertTrue(clone.status === 201 && !!clone.body?.employee?.id,
      `3.1 POST /:id/clone → ${clone.status}`);
    // Cleanup: delete the clone
    if (clone.body?.employee?.id) {
      await api(`/api/agent-employees/${clone.body.employee.id}`, auth.accessToken, { method: 'DELETE' });
    }
  } else {
    info('3.1 no employees in org — skipping clone test');
  }

  // ── API: 3.2 developer ───────────────────────────────────────────
  if (firstEmp) {
    const dev = await api<{ connection_url: string | null; wscat_command: string | null; gateway_token: string | null; gateway_token_masked: string | null }>(
      `/api/agent-employees/${firstEmp.id}/developer`, auth.accessToken,
    );
    assertTrue(dev.status === 200, `3.2 GET /:id/developer → ${dev.status}`);
    assertTrue(dev.body?.gateway_token === null, '3.2 token hidden by default');

    const devReveal = await api<{ gateway_token: string | null }>(
      `/api/agent-employees/${firstEmp.id}/developer?reveal=1`, auth.accessToken,
    );
    assertTrue(devReveal.status === 200 || devReveal.status === 403,
      `3.2 GET /:id/developer?reveal=1 → ${devReveal.status} (200 admin or 403 non-admin)`);
  }

  // ── API: 3.3 webhooks ────────────────────────────────────────────
  if (firstEmp) {
    const create = await api<{ webhook: { id: string; slug: string }; secret: string; post_url: string }>(
      '/api/agent-webhooks', auth.accessToken,
      { method: 'POST', body: JSON.stringify({ agent_employee_id: firstEmp.id, label: 'smoke test' }) },
    );
    assertTrue(create.status === 201 && !!create.body?.secret,
      `3.3 POST /api/agent-webhooks → ${create.status}`);

    // Public fire
    if (create.body?.webhook?.slug && create.body?.secret) {
      const fire = await fetch(`${API_URL}/api/agent-webhooks/${create.body.webhook.slug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-deft-webhook-secret': create.body.secret,
        },
        body: JSON.stringify({ event: 'smoke', at: Date.now() }),
      });
      assertTrue(fire.status === 200, `3.3 public POST /:slug → ${fire.status}`);

      // Wrong secret
      const fireBad = await fetch(`${API_URL}/api/agent-webhooks/${create.body.webhook.slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-deft-webhook-secret': 'wrong' },
        body: JSON.stringify({}),
      });
      assertTrue(fireBad.status === 401, `3.3 wrong secret → ${fireBad.status} (expect 401)`);

      // Cleanup
      await api(`/api/agent-webhooks/${create.body.webhook.id}`, auth.accessToken, { method: 'DELETE' });
    }
  }

  // ── API: 3.4 deft-mcp-client in bundled catalog ─────────────────
  const skillsRes = await api<Array<{ slug: string; source: string }>>(
    '/api/skills', auth.accessToken,
  );
  const skillsList = Array.isArray(skillsRes.body) ? skillsRes.body : (skillsRes.body as any)?.skills ?? [];
  const hasDeftMcp = skillsList.some((s: { slug: string; source: string }) =>
    s.slug === 'deft-mcp-client' && s.source === 'bundled',
  );
  assertTrue(hasDeftMcp, `3.4 deft-mcp-client present in /api/skills (source=bundled)`);

  // ── API: 3.8 trace export ───────────────────────────────────────
  const convos = await api<Array<{ id: string }>>('/api/agent/conversations', auth.accessToken);
  const firstConvo = Array.isArray(convos.body) ? convos.body[0] : undefined;
  if (firstConvo) {
    const traceRes = await fetch(`${API_URL}/api/agent/conversations/${firstConvo.id}/trace.json`, {
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    assertTrue(traceRes.status === 200, `3.8 trace.json → ${traceRes.status}`);
    const cd = traceRes.headers.get('content-disposition') ?? '';
    assertTrue(/attachment/.test(cd), `3.8 Content-Disposition is attachment (got "${cd}")`);
    const trace = await traceRes.json() as any;
    assertTrue(trace.format === 'deft.agent_trace.v1', `3.8 format=${trace.format}`);
  } else {
    info('3.8 no conversations to export');
  }

  // ── UI: Developer page ──────────────────────────────────────────
  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: auth.accessToken, rt: auth.refreshToken ?? null },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(12_000);

  try {
    if (firstEmp) {
      await page.goto(`${WEB_URL}/settings/agent-employees/${firstEmp.id}/developer`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await shot(page, '01-developer-page');

      const hasDeveloperHeader = await page.getByText(/Developer/).count();
      const hasReveal = await page.getByRole('button', { name: /reveal/i }).count();
      const hasWscat = await page.getByText(/wscat one-liner/i).count();
      assertTrue(hasDeveloperHeader > 0, '3.2 Developer page renders header');
      assertTrue(hasReveal > 0, '3.2 Reveal button present');
      assertTrue(hasWscat > 0, '3.2 wscat one-liner section visible');
    }

    // Regression — Library still has ClawHub tab from Block 1.5
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const clawhubTab = await page.getByRole('button', { name: /^clawhub$/i }).count();
    assertTrue(clawhubTab > 0, 'regression: ClawHub tab still present (Block 1.5)');
  } finally {
    await browser.close();
  }

  const pass = log.filter((l) => l.level === 'ok').length;
  const failN = log.filter((l) => l.level === 'fail').length;
  const report = [
    `Run: ${new Date().toISOString()}`,
    `API: ${API_URL}`,
    `Web: ${WEB_URL}`,
    `pass=${pass} fail=${failN}`,
    '',
    ...log.map((l) => `${l.level.toUpperCase().padEnd(4)} ${l.msg}`),
    '',
    failN === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failN})`,
  ].join('\n');
  writeFileSync(REPORT, report);
  console.log(`\n${REPORT}`);
  console.log(`pass=${pass} fail=${failN}`);
  process.exit(failN === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(REPORT, `FATAL: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
