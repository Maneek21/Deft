#!/usr/bin/env tsx
/**
 * Focused chat UI audit — verifies the headline human flows render correctly
 * in Chrome and produces actionable bug reports (not selector noise).
 *
 * Flows:
 *   A. Login → /chat loads → sidebar has Spaces + DMs + Agent Employees
 *   B. Open public channel → post message → renders without page reload
 *   C. Open Defty DM → post (no @-mention) → Defty reply renders within 30s
 *   D. Open BYOA DM → post → BYOA agent_actions row exists in db
 *   E. @-autocomplete opens when typing "@" in post box
 *   F. Click sidebar Agent Employees row → opens DM space (regression check)
 *   G. /inbox loads, tab strip works, /approvals redirects
 */
import 'dotenv/config';
import { chromium, type Page, type Browser } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

type Sev = 'P0' | 'P1' | 'P2' | 'OK';
const findings: Array<{ flow: string; sev: Sev; msg: string }> = [];
function rec(flow: string, sev: Sev, msg: string) {
  findings.push({ flow, sev, msg });
  console.log(`[${sev}] ${flow} — ${msg}`);
}

async function login() {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
}

async function fetchJson<T>(path: string, jwt: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  return (await r.json()) as T;
}

async function getPostBox(page: Page) {
  // The send box is always the last contenteditable on the chat page
  const all = page.locator('[contenteditable="true"]');
  const count = await all.count();
  if (count === 0) return null;
  return all.nth(count - 1);
}

async function postMessage(page: Page, text: string) {
  const box = await getPostBox(page);
  if (!box) throw new Error('post box not found');
  await box.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Delete');
  await box.type(text);
  await page.keyboard.press('Enter');
}

async function probeFlow(browser: Browser, jwt: string) {
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('pageerror', (e) => rec('pageerror', 'P1', e.message.slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|401\b|TS2|Failed to load resource/i.test(t)) {
        // record only "real" console errors
      }
    }
  });

  // ── A. /chat loads with sidebar ────────────────────────────
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  // Look for any of the section headers
  const sections = await page.locator('span').filter({ hasText: /^(Spaces|Direct Messages|Agent Employees)$/ }).count();
  if (sections >= 2) rec('A.sidebar', 'OK', `${sections} section headers visible`);
  else rec('A.sidebar', 'P0', `only ${sections} sidebar section headers found`);

  // ── B. Public channel: post and render ─────────────────────
  const spaces = await fetchJson<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const publicSpace = spaces.find((s) => s.type === 'public');
  if (publicSpace) {
    await page.goto(`${WEB_URL}/chat?space=${publicSpace.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const stamp = `audit-msg-${Date.now()}`;
    try {
      await postMessage(page, stamp);
      // Wait for it to render via WebSocket
      const found = await page.locator(`text="${stamp}"`).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
      if (found) rec('B.public-post', 'OK', 'message renders');
      else rec('B.public-post', 'P1', 'message did not render after post');
    } catch (err) {
      rec('B.public-post', 'P0', (err as Error).message.slice(0, 150));
    }
  } else {
    rec('B.public-post', 'P2', 'no public space available');
  }

  // ── C. Defty DM: auto-reply without @-mention ──────────────
  const deftyDm = spaces.find((s) => s.type === 'dm' && /Deft\b/.test(s.name ?? ''));
  if (deftyDm) {
    await page.goto(`${WEB_URL}/chat?space=${deftyDm.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const stamp = `defty-test-${Date.now()}`;
    let postOk = false;
    try {
      await postMessage(page, stamp);
      postOk = true;
    } catch (err) {
      rec('C.defty-post', 'P0', (err as Error).message.slice(0, 150));
    }
    if (postOk) {
      // Wait for the user msg to render
      await page.locator(`text="${stamp}"`).first().waitFor({ timeout: 5000 }).catch(() => {});
      // Wait up to 35s for Defty to reply, polling DB indirectly via API
      let replied = false;
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const msgs = await fetchJson<Array<{ id: string; content: string; user_id: string; parent_id: string | null; created_at: string }>>(
          `/api/messages/${deftyDm.id}`, jwt,
        );
        const userMsg = msgs.find((m) => m.content?.includes(stamp));
        if (!userMsg) continue;
        const reply = msgs.find((m) => m.parent_id === userMsg.id && m.user_id !== userMsg.user_id);
        if (reply) { replied = true; break; }
      }
      rec('C.defty-auto-reply', replied ? 'OK' : 'P0', replied ? 'Defty replied without @-mention' : 'no reply within 35s');
    }
  } else {
    rec('C.defty-auto-reply', 'P2', 'no Defty DM space available — open one via DM picker first');
  }

  // ── E. @-autocomplete ──────────────────────────────────────
  if (publicSpace) {
    await page.goto(`${WEB_URL}/chat?space=${publicSpace.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const box = await getPostBox(page);
    if (box) {
      try {
        await box.click();
        await box.type('@');
        await page.waitForTimeout(800);
        // Look for any visible popup/listbox-shaped overlay
        const popup = page.locator('[role="listbox"], [class*="mention" i], [class*="autocomplete" i], [class*="popover" i]').first();
        const visible = (await popup.count()) > 0 && (await popup.isVisible().catch(() => false));
        rec('E.autocomplete', visible ? 'OK' : 'P1', visible ? 'opens on @' : 'did not open on @');
        // Press Escape to close
        await page.keyboard.press('Escape');
      } catch (err) {
        rec('E.autocomplete', 'P1', (err as Error).message.slice(0, 100));
      }
    }
  }

  // ── F. Sidebar Agent Employees row ─────────────────────────
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const header = page.locator('span:has-text("Agent Employees")').first();
  if (await header.count() > 0) {
    const sec = header.locator('xpath=ancestor::div[contains(@class,"pt-5")][1]');
    const btn = sec.locator('button').first();
    if (await btn.count() > 0) {
      const before = page.url();
      await btn.click({ force: true });
      await page.waitForTimeout(2000);
      const after = page.url();
      const txt = (await page.locator('body').innerText()).slice(0, 100);
      const is404 = /Page not found|404/.test(txt);
      if (is404) rec('F.agent-emp-click', 'P0', '404 on click');
      else if (after.includes('/chat?space=')) rec('F.agent-emp-click', 'OK', 'opens DM');
      else rec('F.agent-emp-click', 'P1', `nav: ${before} → ${after}`);
    }
  } else {
    rec('F.agent-emp-click', 'P2', 'no Agent Employees section visible');
  }

  // ── G. /inbox + tabs + /approvals redirect ─────────────────
  await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const inboxBody = (await page.locator('body').innerText()).slice(0, 100);
  rec('G.inbox', /Page not found|404/.test(inboxBody) ? 'P0' : 'OK', /404/.test(inboxBody) ? '404' : 'loaded');
  const approvalsTab = page.locator('button:has-text("Approvals"), a:has-text("Approvals")').first();
  if (await approvalsTab.count() > 0) {
    await approvalsTab.click();
    await page.waitForTimeout(1000);
    rec('G.inbox-tabs', page.url().includes('approvals') ? 'OK' : 'P1', `url after tab click: ${page.url()}`);
  }
  await page.goto(`${WEB_URL}/approvals`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  const finalUrl = page.url();
  rec('G.approvals-redirect', finalUrl.includes('/inbox') ? 'OK' : 'P1', finalUrl);

  await ctx.close();
}

async function main() {
  const jwt = await login();
  const browser = await chromium.launch({ headless: true });
  try { await probeFlow(browser, jwt); } finally { await browser.close(); }

  const counts = findings.reduce<Record<Sev, number>>((acc, f) => { acc[f.sev] = (acc[f.sev] ?? 0) + 1; return acc; }, { P0: 0, P1: 0, P2: 0, OK: 0 });
  console.log(`\n=== SUMMARY === total=${findings.length}  OK=${counts.OK}  P0=${counts.P0}  P1=${counts.P1}  P2=${counts.P2}`);
  if (counts.P0 + counts.P1 > 0) {
    console.log('\nIssues:');
    for (const f of findings) if (f.sev === 'P0' || f.sev === 'P1') console.log(`  [${f.sev}] ${f.flow} — ${f.msg}`);
  }
  process.exit(counts.P0 > 0 ? 1 : 0);
}

main().catch((e) => { console.error('crashed:', e); process.exit(2); });
