#!/usr/bin/env tsx
/**
 * Deep chat UI probe — click every navigable surface, catch 404s and console errors.
 * Reports every clickable that leads to a 404, plus per-route render issues.
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

type Finding = { surface: string; severity: 'P0' | 'P1' | 'P2' | 'OK'; title: string; detail?: string };
const findings: Finding[] = [];
function rec(f: Finding) {
  const tag = f.severity === 'OK' ? '✓' : f.severity;
  findings.push(f);
  console.log(`[${tag}] ${f.surface} — ${f.title}${f.detail ? ` (${f.detail})` : ''}`);
}

const responseStatuses: Array<{ url: string; status: number }> = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

async function login(): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function api<T = unknown>(path: string, jwt: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}

async function probePage(page: Page, surface: string, url: string) {
  responseStatuses.length = 0;
  pageErrors.length = 0;
  consoleErrors.length = 0;
  const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForTimeout(2500);
  const status = r?.status() ?? 0;
  const finalUrl = page.url();
  const bodyText = (await page.locator('body').innerText()).slice(0, 200);
  const hasNotFound = /Page not found|404/.test(bodyText);
  if (status === 404 || hasNotFound) {
    rec({ surface, severity: 'P0', title: '404', detail: `${url} → ${finalUrl}` });
  } else if (status >= 500) {
    rec({ surface, severity: 'P0', title: `${status}`, detail: url });
  } else if (status >= 400) {
    rec({ surface, severity: 'P1', title: `${status}`, detail: url });
  } else {
    const bodyLen = (await page.locator('body').innerText()).length;
    if (bodyLen < 50) {
      rec({ surface, severity: 'P1', title: 'page rendered empty', detail: `len=${bodyLen}` });
    } else {
      rec({ surface, severity: 'OK', title: `loaded`, detail: `${status}` });
    }
  }
  // Surface 5xx network failures
  for (const r of responseStatuses) {
    if (r.status >= 500) {
      rec({ surface, severity: 'P0', title: `${r.status} on ${r.url.replace(API_URL, '')}` });
    }
  }
}

async function main() {
  const jwt = await login();

  // Probe data: pick real agent employees, real spaces, real DM ids from API
  const orgMembers = await api<Array<{ id: string; email?: string; name?: string; kind?: string }>>('/api/members', jwt);
  const orgArr = Array.isArray(orgMembers.body) ? orgMembers.body : [];
  const agents = orgArr.filter((m) => m.kind === 'agent' || m.kind === 'system');
  const humans = orgArr.filter((m) => m.kind === 'human').slice(0, 2);
  console.log(`\nfixtures: ${agents.length} agents, ${humans.length} humans\n`);

  const spaces = await api<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const spacesArr = Array.isArray(spaces.body) ? spaces.body : [];
  const publicSpaces = spacesArr.filter((s) => s.type === 'public').slice(0, 2);
  const dmSpaces = spacesArr.filter((s) => s.type === 'dm').slice(0, 2);
  const agentConvos = spacesArr.filter((s) => s.type === 'agent_conversation').slice(0, 2);
  console.log(`spaces: ${publicSpaces.length} public, ${dmSpaces.length} DM, ${agentConvos.length} agent_convo\n`);

  // Agent employees (BYOA)
  const employees = await api<Array<{ id: string; user_id: string; slug: string; name: string }>>('/api/agent-employees', jwt);
  const empArr = Array.isArray(employees.body) ? employees.body : [];
  const liveEmps = empArr.slice(0, 3);
  console.log(`agent-employees: ${empArr.length}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('response', (res) => {
    responseStatuses.push({ url: res.url(), status: res.status() });
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401|favicon/i.test(m.text())) {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });

  try {
    // Top-level routes
    await probePage(page, '/dashboard', `${WEB_URL}/dashboard`);
    await probePage(page, '/notes', `${WEB_URL}/notes`);
    await probePage(page, '/calendar', `${WEB_URL}/calendar`);
    await probePage(page, '/chat', `${WEB_URL}/chat`);
    await probePage(page, '/tasks', `${WEB_URL}/tasks`);
    await probePage(page, '/knowledge', `${WEB_URL}/knowledge`);
    await probePage(page, '/inbox', `${WEB_URL}/inbox`);
    await probePage(page, '/library', `${WEB_URL}/library`);
    await probePage(page, '/settings', `${WEB_URL}/settings`);

    // Settings sub-pages
    for (const sub of ['members', 'agent', 'tags', 'workflows', 'projects', 'ai', 'calendar']) {
      await probePage(page, `/settings/${sub}`, `${WEB_URL}/settings/${sub}`);
    }

    // /chat per-space
    for (const s of publicSpaces) {
      await probePage(page, `chat/public:${s.name}`, `${WEB_URL}/chat?space=${s.id}`);
    }
    for (const s of dmSpaces) {
      await probePage(page, `chat/dm:${s.name}`, `${WEB_URL}/chat?space=${s.id}`);
    }
    for (const s of agentConvos) {
      await probePage(page, `chat/agent_convo:${s.name}`, `${WEB_URL}/chat?space=${s.id}`);
    }

    // Agent employee surfaces — this is what user reported broken
    for (const emp of liveEmps) {
      await probePage(page, `employee:${emp.slug}/edit`, `${WEB_URL}/settings/agent-employees/${emp.id}`);
      await probePage(page, `employee:${emp.slug}/personality`, `${WEB_URL}/settings/agent-employees/${emp.id}/personality`);
      await probePage(page, `employee:${emp.slug}/developer`, `${WEB_URL}/settings/agent-employees/${emp.id}/developer`);
    }
    await probePage(page, `employees/create`, `${WEB_URL}/settings/agent-employees/create`);

    // The user-reported issue: clicking on an agent employee in chat sidebar.
    // The chat sidebar's DM rows for agents call openDmWith(member.id), which
    // creates/finds a DM space and routes to /chat?space=<id>. Test that flow:
    if (agents.length > 0) {
      const agent = agents.find((a) => a.email === 'deft-agent@system.local') ?? agents[0];
      console.log(`\n--- trying agent click flow for ${agent.name} (${agent.id}) ---`);
      // Navigate to /chat first
      await probePage(page, `chat-list-before-agent-click`, `${WEB_URL}/chat`);
      // Find the agent button in the sidebar by name
      const agentBtn = page.locator(`button:has-text("${agent.name}")`).first();
      const btnCount = await agentBtn.count();
      console.log(`  agent button found: ${btnCount}`);
      if (btnCount > 0) {
        // Capture POST/GET to /api/spaces/dms or similar that opening a DM should trigger
        const calls: Array<{ method: string; url: string; status: number }> = [];
        const handler = (res: import('playwright').Response) => {
          if (/api\//.test(res.url())) {
            calls.push({ method: res.request().method(), url: res.url(), status: res.status() });
          }
        };
        page.on('response', handler);
        await agentBtn.click();
        await page.waitForTimeout(3000);
        const finalUrl = page.url();
        const bodyText = (await page.locator('body').innerText()).slice(0, 300);
        const isError = /Page not found|404/.test(bodyText);
        if (isError) {
          rec({ surface: `agent-click:${agent.name}`, severity: 'P0', title: `404 after click`, detail: finalUrl });
        } else {
          rec({ surface: `agent-click:${agent.name}`, severity: 'OK', title: `navigated`, detail: finalUrl });
        }
        // Show the calls to look for 4xx/5xx
        const interesting = calls.filter((c) => c.status >= 400);
        if (interesting.length > 0) {
          for (const c of interesting) {
            rec({ surface: `agent-click:${agent.name}`, severity: c.status >= 500 ? 'P0' : 'P1', title: `${c.method} ${c.url.replace(API_URL, '')} → ${c.status}` });
          }
        }
        page.off('response', handler);
      } else {
        rec({ surface: `agent-click:${agent.name}`, severity: 'P1', title: 'agent button not found in sidebar' });
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  // Summary
  const counts = findings.reduce<Record<string, number>>((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {});
  console.log('\n=== SUMMARY ===');
  console.log(`Total: ${findings.length} | OK: ${counts.OK ?? 0} | P0: ${counts.P0 ?? 0} | P1: ${counts.P1 ?? 0} | P2: ${counts.P2 ?? 0}`);
  const issues = findings.filter((f) => f.severity !== 'OK');
  if (issues.length > 0) {
    console.log('\nIssues:');
    for (const f of issues) console.log(`  [${f.severity}] ${f.surface} — ${f.title}${f.detail ? ` (${f.detail})` : ''}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error('crashed:', err); process.exit(2); });
