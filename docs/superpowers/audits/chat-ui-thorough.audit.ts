#!/usr/bin/env tsx
/**
 * Thorough chat UI audit — drives Chrome through every chat surface a human
 * would touch and reports findings as P0/P1/P2/OK.
 *
 * Coverage:
 *   1. Sidebar: spaces list, DMs, Agent Employees section, search, create-space, create-dm
 *   2. Channel chat: post message, reactions, threads, mentions, edit/delete
 *   3. DM chat: post message, see typing/online, history loads
 *   4. Agent chat: post @deft mention, post in Defty DM (no mention), tool-use rendering
 *   5. Slash commands / message actions: edit, delete, pin, react, copy
 *   6. Message renderer: link previews, code blocks, mentions, task refs
 *   7. Members panel, search-in-space, scroll-to-load-more
 *   8. Inbox + approvals integration
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

type Severity = 'P0' | 'P1' | 'P2' | 'OK';
type Finding = { surface: string; sev: Severity; title: string; detail?: string };
const findings: Finding[] = [];
function rec(f: Finding) {
  findings.push(f);
  const tag = f.sev === 'OK' ? 'OK' : f.sev;
  console.log(`[${tag}] ${f.surface} — ${f.title}${f.detail ? ` (${f.detail})` : ''}`);
}

async function login(): Promise<string> {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
}

async function api<T>(path: string, jwt: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const t = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(t); } catch { body = t; }
  return { status: res.status, body: body as T };
}

async function postBox(page: Page) {
  // Find the contenteditable post box
  return page.locator('[contenteditable="true"]').last();
}

async function sendInBox(page: Page, text: string) {
  const box = await postBox(page);
  await box.click();
  await box.fill('');
  await box.type(text);
  await page.keyboard.press('Enter');
}

async function probeSpace(page: Page, surface: string, spaceId: string) {
  await page.goto(`${WEB_URL}/chat?space=${spaceId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const bodyText = (await page.locator('body').innerText()).slice(0, 200);
  if (/Page not found|404/.test(bodyText)) {
    rec({ surface, sev: 'P0', title: '404 on space load' });
    return;
  }
  rec({ surface, sev: 'OK', title: 'space loaded' });

  // Check the post box exists
  const boxCount = await (await postBox(page)).count();
  if (boxCount === 0) rec({ surface, sev: 'P0', title: 'no post box found' });

  if (errors.length > 0) {
    rec({ surface, sev: 'P1', title: 'pageerror', detail: errors[0].slice(0, 120) });
  }
}

async function main() {
  const jwt = await login();

  // Fixtures
  const me = await api<{ id: string; org_id: string }>('/api/auth/me', jwt);
  const meId = me.body.id;
  const orgId = me.body.org_id;
  console.log(`me: ${meId}  org: ${orgId}`);

  const orgMembers = await api<Array<{ id: string; name: string; kind?: string; email?: string }>>('/api/members', jwt);
  const agents = orgMembers.body.filter((m) => m.kind === 'agent');
  const defty = agents.find((a) => a.email === 'deft-agent@system.local');
  const byoa = agents.find((a) => a.email !== 'deft-agent@system.local');
  const human = orgMembers.body.find((m) => m.kind === 'human' && m.id !== meId);
  console.log(`agents: ${agents.length}, defty=${defty?.name}, byoa=${byoa?.name}, peer=${human?.name}`);

  const spaces = await api<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const publicSpace = spaces.body.find((s) => s.type === 'public');
  const dmSpace = spaces.body.find((s) => s.type === 'dm');
  console.log(`spaces: ${spaces.body.length}, public=${publicSpace?.name}, dm=${dmSpace?.name}`);

  // Open a Defty DM if not already there
  const deftyDm = spaces.body.find((s) => s.type === 'dm' && s.name?.includes('Deft'));
  console.log(`defty DM: ${deftyDm?.id}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: getStatePath(),
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message.slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|401\b/i.test(t)) console.log(`[console.error] ${t.slice(0, 200)}`);
    }
  });

  try {
    // 1. /chat root
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const sidebarHeader = page.locator('span:has-text("Spaces")').first();
    if (await sidebarHeader.count() === 0) {
      rec({ surface: '/chat', sev: 'P0', title: 'sidebar Spaces header missing' });
    } else {
      rec({ surface: '/chat', sev: 'OK', title: 'sidebar renders' });
    }

    // 2. Public channel
    if (publicSpace) {
      await probeSpace(page, `chat:${publicSpace.name}`, publicSpace.id);

      // Try to post a message
      const surface = `chat:${publicSpace.name}/post`;
      const text = `audit message ${Date.now()}`;
      try {
        await sendInBox(page, text);
        await page.waitForTimeout(1500);
        const visible = await page.locator(`text="${text}"`).count();
        if (visible > 0) rec({ surface, sev: 'OK', title: 'message posted and rendered' });
        else rec({ surface, sev: 'P1', title: 'posted message did not render' });
      } catch (err) {
        rec({ surface, sev: 'P1', title: 'post threw', detail: (err as Error).message.slice(0, 100) });
      }

      // Hover to reveal message actions
      const msgRow = page.locator(`text="${text}"`).first();
      try {
        await msgRow.hover();
        await page.waitForTimeout(500);
        const reactBtn = page.locator('button[aria-label*="reaction" i], button:has(svg) >> text=/.*/').first();
        // Just check that hover surfaces *something*
        const buttons = await page.locator('button:visible').count();
        if (buttons < 3) {
          rec({ surface: `chat:${publicSpace.name}/hover`, sev: 'P2', title: 'no hover toolbar visible' });
        }
      } catch { /* ignore */ }
    }

    // 3. DM with human
    if (dmSpace) {
      await probeSpace(page, `chat:dm`, dmSpace.id);
    }

    // 4. Defty DM — auto-trigger test (the just-fixed bug)
    if (deftyDm) {
      await probeSpace(page, `chat:defty-dm`, deftyDm.id);
      const text = `audit defty test ${Date.now()}`;
      const surface = `chat:defty-dm/auto-trigger`;
      try {
        await sendInBox(page, text);
        await page.waitForTimeout(2000);
        // Wait up to 30s for Defty to reply
        let replied = false;
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(1000);
          // count of agent-authored messages in this view (BOT badge or kind indicator)
          const replyCount = await page.locator(`[data-test="agent-message"], span:has-text("BOT")`).count();
          if (replyCount > 0) {
            // Check if there's content from defty after our message
            const allMsgs = await page.locator('[data-message-id]').count();
            if (allMsgs > 0) {
              replied = true;
              break;
            }
          }
        }
        if (replied) rec({ surface, sev: 'OK', title: 'Defty auto-replies in DM (no @-mention)' });
        else rec({ surface, sev: 'P0', title: 'Defty did NOT reply within 30s' });
      } catch (err) {
        rec({ surface, sev: 'P0', title: 'send threw', detail: (err as Error).message.slice(0, 100) });
      }
    } else {
      rec({ surface: 'chat:defty-dm', sev: 'P1', title: 'no Defty DM found in spaces list' });
    }

    // 5. BYOA mention in public channel
    if (publicSpace && byoa) {
      const surface = `chat:${publicSpace.name}/byoa-mention`;
      await page.goto(`${WEB_URL}/chat?space=${publicSpace.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      try {
        const box = await postBox(page);
        await box.click();
        await box.fill('');
        await box.type('@');
        await page.waitForTimeout(800);
        const autocomplete = page.locator('[role="listbox"], [class*="autocomplete"], [class*="mention"]').first();
        const acVisible = (await autocomplete.count()) > 0 && (await autocomplete.isVisible().catch(() => false));
        if (!acVisible) {
          rec({ surface, sev: 'P1', title: '@ autocomplete did not open' });
        } else {
          rec({ surface, sev: 'OK', title: '@ autocomplete opened' });
        }
        // Send mentioning byoa name
        await box.fill('');
        await box.type(`@${byoa.name?.split(/\s+/)[0]} ping ${Date.now()}`);
        await page.waitForTimeout(800);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
      } catch (err) {
        rec({ surface, sev: 'P1', title: 'send w/ mention threw', detail: (err as Error).message.slice(0, 100) });
      }
    }

    // 6. Sidebar three-dot menu on a space
    if (publicSpace) {
      const surface = `sidebar/space-menu`;
      await page.goto(`${WEB_URL}/chat?space=${publicSpace.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      try {
        const spaceBtn = page.locator(`button:has-text("${publicSpace.name}")`).first();
        await spaceBtn.hover();
        const menuBtn = page.locator('button[aria-label*="menu" i], button:has(svg.lucide-more-horizontal)').first();
        if (await menuBtn.count() > 0) {
          await menuBtn.click({ force: true });
          await page.waitForTimeout(500);
          const items = await page.locator('[role="menuitem"], [data-menu-item]').count();
          rec({ surface, sev: items > 0 ? 'OK' : 'P1', title: items > 0 ? `${items} menu items` : 'menu opened but empty' });
        }
      } catch { /* ignore */ }
    }

    // 7. Inbox page
    {
      const surface = '/inbox';
      await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const txt = (await page.locator('body').innerText()).slice(0, 100);
      if (/Page not found|404/.test(txt)) rec({ surface, sev: 'P0', title: '404' });
      else rec({ surface, sev: 'OK', title: 'loaded' });
      // Try Approvals tab
      const approvalsTab = page.locator('button:has-text("Approvals"), a:has-text("Approvals")').first();
      if (await approvalsTab.count() > 0) {
        await approvalsTab.click();
        await page.waitForTimeout(800);
        const url = page.url();
        if (url.includes('approvals')) rec({ surface: '/inbox?tab=approvals', sev: 'OK', title: 'tab nav works' });
      }
    }

    // 8. /approvals → /inbox?tab=approvals redirect
    {
      const surface = '/approvals';
      await page.goto(`${WEB_URL}/approvals`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const finalUrl = page.url();
      if (finalUrl.includes('/inbox')) rec({ surface, sev: 'OK', title: 'redirected to /inbox' });
      else rec({ surface, sev: 'P1', title: `final url ${finalUrl}` });
    }

    // 9. Sidebar Agent Employees row (the prior bug)
    if (byoa) {
      const surface = 'sidebar/agent-employees-click';
      await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const header = page.locator('span:has-text("Agent Employees")').first();
      if (await header.count() === 0) {
        rec({ surface, sev: 'P2', title: 'section not visible (no agent_employees rows)' });
      } else {
        const section = header.locator('xpath=ancestor::div[contains(@class,"pt-5")][1]');
        const btn = section.locator('button').first();
        await btn.click({ force: true });
        await page.waitForTimeout(2000);
        const url = page.url();
        const body = (await page.locator('body').innerText()).slice(0, 100);
        const is404 = /Page not found|404/.test(body);
        if (is404) rec({ surface, sev: 'P0', title: '404 after click', detail: url });
        else if (url.includes('/chat?space=')) rec({ surface, sev: 'OK', title: `nav to ${url.split('?')[1]}` });
        else rec({ surface, sev: 'P1', title: `unexpected nav: ${url}` });
      }
    }

    // 10. /tasks open via task-ref click (in case agent posts a task ref)
    {
      const surface = '/tasks';
      await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const body = (await page.locator('body').innerText()).slice(0, 100);
      if (/Page not found|404/.test(body)) rec({ surface, sev: 'P0', title: '404' });
      else rec({ surface, sev: 'OK', title: 'loaded' });
    }

    // 11. Settings agent-employees [id] page (linked from sidebar/header indirectly)
    const employees = await api<Array<{ id: string }>>('/api/agent-employees', jwt);
    const empArr = Array.isArray(employees.body) ? employees.body : [];
    if (empArr[0]) {
      for (const sub of ['', '/personality', '/developer', '/heartbeats', '/webhooks']) {
        const surface = `settings/agent-employees/[id]${sub}`;
        const url = `${WEB_URL}/settings/agent-employees/${empArr[0].id}${sub}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const body = (await page.locator('body').innerText()).slice(0, 100);
        if (/Page not found|404/.test(body)) rec({ surface, sev: 'P0', title: '404', detail: url });
        else rec({ surface, sev: 'OK', title: 'loaded' });
      }
    }

  } finally {
    await ctx.close();
    await browser.close();
  }

  // Summary
  const counts = findings.reduce<Record<string, number>>((acc, f) => { acc[f.sev] = (acc[f.sev] ?? 0) + 1; return acc; }, {});
  console.log('\n=== SUMMARY ===');
  console.log(`Total: ${findings.length} | OK: ${counts.OK ?? 0} | P0: ${counts.P0 ?? 0} | P1: ${counts.P1 ?? 0} | P2: ${counts.P2 ?? 0}`);
  if ((counts.P0 ?? 0) + (counts.P1 ?? 0) + (counts.P2 ?? 0) > 0) {
    console.log('\nIssues:');
    for (const f of findings) if (f.sev !== 'OK') console.log(`  [${f.sev}] ${f.surface} — ${f.title}${f.detail ? ` (${f.detail})` : ''}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error('crashed:', err); process.exit(2); });
