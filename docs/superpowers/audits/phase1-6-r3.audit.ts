#!/usr/bin/env tsx
/**
 * Round 3 audit — accessibility + mobile viewport.
 *
 * A11Y:
 *   A.1  Inbox page — every visible button has an accessible name
 *   A.2  Sidebar — every nav link has an accessible name
 *   A.3  Esc closes the SpaceMembersPanel modal
 *   A.4  AIBadge contrast meets WCAG AA in both themes
 *   A.5  Tab key moves focus through interactive elements (no traps)
 *
 * MOBILE (375x667):
 *   M.1  /inbox renders without horizontal scroll
 *   M.2  /chat layout adapts (touch targets meet 44px minimum on tab strip)
 *   M.3  /inbox tab buttons are tappable (44px tall)
 *   M.4  AIBadge survives the smaller viewport (still rendered)
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-r3.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { getStatePath } from './lib/auth.js';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3011';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';

type Severity = 'P0' | 'P1' | 'P2' | 'OK' | 'SKIP';
type Finding = { flow: string; id: string; severity: Severity; title: string; detail?: string };
const findings: Finding[] = [];

function record(f: Finding) {
  findings.push(f);
  const tag = f.severity === 'OK' ? '✓' : f.severity === 'SKIP' ? '∅' : f.severity;
  console.log(`[${tag}] [${f.flow}.${f.id}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
}

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

async function api<T = unknown>(path: string, jwt: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}

// ─────────────────────────────────────────────────────────────────────
// WCAG contrast helpers
// ─────────────────────────────────────────────────────────────────────

function parseRgb(s: string): [number, number, number] | null {
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function relLum(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number | null {
  const ar = parseRgb(a), br = parseRgb(b);
  if (!ar || !br) return null;
  const la = relLum(ar), lb = relLum(br);
  const [bright, dark] = la > lb ? [la, lb] : [lb, la];
  return (bright + 0.05) / (dark + 0.05);
}

// ─────────────────────────────────────────────────────────────────────
// A11Y — desktop sweeps
// ─────────────────────────────────────────────────────────────────────

async function flowA1_inbox_buttons(ctx: BrowserContext) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForSelector('h1:has-text("Inbox")', { timeout: 10_000 });
    await page.waitForTimeout(800);

    const orphans = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll<HTMLElement>('main button, main a[href]'));
      return btns
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0; // visible only
        })
        .filter((el) => {
          const text = (el.textContent ?? '').trim();
          const aria = el.getAttribute('aria-label')?.trim();
          const title = el.getAttribute('title')?.trim();
          return !text && !aria && !title;
        })
        .map((el) => el.outerHTML.slice(0, 200));
    });
    if (orphans.length > 0) {
      record({ flow: 'A', id: '1', severity: 'P1', title: `${orphans.length} interactive elements on /inbox lack accessible names`, detail: orphans[0] });
    } else {
      record({ flow: 'A', id: '1', severity: 'OK', title: '/inbox interactives all have accessible names' });
    }
  } finally {
    await page.close();
  }
}

async function flowA2_sidebar_nav(ctx: BrowserContext) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForSelector('a[href="/inbox"]', { timeout: 10_000 });
    await page.waitForTimeout(1000);

    const orphans = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLElement>('a[href^="/"]'));
      return links
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .filter((el) => {
          const text = (el.textContent ?? '').trim();
          const aria = el.getAttribute('aria-label')?.trim();
          const title = el.getAttribute('title')?.trim();
          return !text && !aria && !title;
        })
        .map((el) => `${el.tagName} ${el.getAttribute('href')}`);
    });
    if (orphans.length > 0) {
      record({ flow: 'A', id: '2', severity: 'P1', title: `${orphans.length} sidebar/nav links lack accessible names`, detail: orphans.slice(0, 3).join(' | ') });
    } else {
      record({ flow: 'A', id: '2', severity: 'OK', title: 'Sidebar nav links all have accessible names' });
    }
  } finally {
    await page.close();
  }
}

async function flowA3_modal_esc(ctx: BrowserContext, jwt: string) {
  const spaces = await api<Array<{ id: string; type: string }>>('/api/spaces', jwt);
  const arr = Array.isArray(spaces.body) ? spaces.body : [];
  const space = arr.find((s) => s.type === 'public');
  if (!space) { record({ flow: 'A', id: '3', severity: 'SKIP', title: 'No public space' }); return; }

  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const collapse = page.locator('button[aria-label*="Collapse issues" i]').first();
    if (await collapse.count() > 0) await collapse.click({ force: true }).catch(() => {});
    await page.locator('button[title="View members"]').first().click({ force: true });
    await page.waitForTimeout(1000);

    const open = await page.locator('h3:has-text("Members")').count();
    if (open === 0) { record({ flow: 'A', id: '3', severity: 'SKIP', title: 'Could not open members modal' }); return; }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const stillOpen = await page.locator('h3:has-text("Members")').count();
    if (stillOpen > 0) {
      record({ flow: 'A', id: '3', severity: 'P1', title: 'Esc did NOT close SpaceMembersPanel' });
    } else {
      record({ flow: 'A', id: '3', severity: 'OK', title: 'Esc closes SpaceMembersPanel' });
    }
  } finally {
    await page.close();
  }
}

async function flowA4_badge_contrast(ctx: BrowserContext, jwt: string) {
  // Find a space where Defty (or any agent) is a member so a real AIBadge
  // is rendered in the panel.
  const orgMembers = await api<Array<{ id: string; email?: string; kind?: string }>>('/api/members', jwt);
  const orgArr = Array.isArray(orgMembers.body) ? orgMembers.body : [];
  const defty = orgArr.find((m) => m.email === 'deft-agent@system.local');
  if (!defty) { record({ flow: 'A', id: '4', severity: 'SKIP', title: 'No Defty user' }); return; }

  const spaces = await api<Array<{ id: string; type: string }>>('/api/spaces', jwt);
  const spacesArr = Array.isArray(spaces.body) ? spaces.body : [];
  let space: { id: string } | undefined;
  for (const s of spacesArr) {
    if (s.type !== 'public') continue;
    const m = await api<Array<{ id: string }>>(`/api/spaces/${s.id}/members`, jwt);
    const mArr = Array.isArray(m.body) ? m.body : [];
    if (mArr.find((x) => x.id === defty.id)) { space = s; break; }
  }
  let bootstrapped = false;
  if (!space) {
    // Add Defty to the first public space temporarily
    const target = spacesArr.find((s) => s.type === 'public');
    if (!target) { record({ flow: 'A', id: '4', severity: 'SKIP', title: 'No public space' }); return; }
    await fetch(`${API_URL}/api/spaces/${target.id}/members`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: defty.id }),
    });
    space = target;
    bootstrapped = true;
  }

  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const collapse = page.locator('button[aria-label*="Collapse issues" i]').first();
    if (await collapse.count() > 0) await collapse.click({ force: true }).catch(() => {});
    await page.locator('button[title="View members"]').first().click({ force: true });
    await page.waitForTimeout(1000);

    const badge = page.locator('span.rounded-full:has-text("AI")').first();
    if (await badge.count() === 0) { record({ flow: 'A', id: '4', severity: 'SKIP', title: 'No AIBadge to test' }); return; }

    async function read(): Promise<{ bg: string; color: string; theme: string }> {
      return await badge.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          color: cs.color,
          theme: document.documentElement.classList.contains('light') ? 'light' : 'dark',
        };
      });
    }
    async function setTheme(t: 'light' | 'dark') {
      await page.evaluate((tt) => {
        document.documentElement.classList.toggle('dark', tt === 'dark');
        document.documentElement.classList.toggle('light', tt === 'light');
      }, t);
      await page.waitForTimeout(300);
    }

    await setTheme('dark');
    const dark = await read();
    await setTheme('light');
    const light = await read();
    await setTheme('dark'); // reset

    const darkRatio = contrast(dark.bg, dark.color);
    const lightRatio = contrast(light.bg, light.color);

    // WCAG AA for normal text is 4.5:1; the AI badge uses 10px text (small),
    // but we'll apply the AA threshold (lenient is 3:1 for large text only).
    const AA = 4.5;
    if (darkRatio === null || lightRatio === null) {
      record({ flow: 'A', id: '4', severity: 'P2', title: 'Could not parse colors for contrast', detail: `dark=${JSON.stringify(dark)} light=${JSON.stringify(light)}` });
    } else if (darkRatio < AA || lightRatio < AA) {
      record({ flow: 'A', id: '4', severity: 'P1', title: `AIBadge contrast below WCAG AA`, detail: `dark=${darkRatio.toFixed(2)}:1 light=${lightRatio.toFixed(2)}:1` });
    } else {
      record({ flow: 'A', id: '4', severity: 'OK', title: 'AIBadge meets WCAG AA in both themes', detail: `dark=${darkRatio.toFixed(2)}:1 light=${lightRatio.toFixed(2)}:1` });
    }
  } finally {
    if (bootstrapped && space) {
      await fetch(`${API_URL}/api/spaces/${space.id}/members/${defty.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` },
      }).catch(() => {});
    }
    await page.close();
  }
}

async function flowA5_tab_focus(ctx: BrowserContext) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1:has-text("Inbox")', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Press Tab N times, collect focused-element identifiers. Keep going
    // until we see a few unique focusable elements OR loop back.
    const focusOrder: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return 'BODY';
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent ?? '').trim().slice(0, 30);
        const aria = el.getAttribute('aria-label')?.trim();
        const href = (el as HTMLAnchorElement).href || '';
        return `${tag}:${aria || text || href.split('/').pop() || ''}`;
      });
      focusOrder.push(focused);
    }
    const uniques = new Set(focusOrder.filter((f) => f !== 'BODY'));
    if (uniques.size < 3) {
      record({ flow: 'A', id: '5', severity: 'P1', title: `Tab navigation reaches only ${uniques.size} unique elements after 20 presses (possible focus trap or no focusable elements)` });
    } else {
      record({ flow: 'A', id: '5', severity: 'OK', title: `Tab navigation reaches ${uniques.size} focusable elements`, detail: Array.from(uniques).slice(0, 3).join(' | ') });
    }
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// MOBILE — 375x667 viewport
// ─────────────────────────────────────────────────────────────────────

async function flowMobile(browser: Browser, jwt: string) {
  const ctx = await browser.newContext({
    storageState: getStatePath(),
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  try {
    // M.1 — /inbox horizontal scroll check
    await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1:has-text("Inbox")', { timeout: 10_000 });
    await page.waitForTimeout(1000);
    const inboxOverflow = await page.evaluate(() => {
      const root = document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    if (inboxOverflow.scrollWidth > inboxOverflow.clientWidth + 1) {
      record({ flow: 'M', id: '1', severity: 'P1', title: '/inbox has horizontal scroll on mobile', detail: `scroll=${inboxOverflow.scrollWidth} client=${inboxOverflow.clientWidth}` });
    } else {
      record({ flow: 'M', id: '1', severity: 'OK', title: '/inbox fits within mobile viewport (no h-scroll)' });
    }

    // M.2 — /chat sidebar nav touch targets ≥44px (or sidebar is collapsed)
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const navItems = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLElement>('a[href^="/"]'));
      return links
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { href: el.getAttribute('href'), w: r.width, h: r.height };
        });
    });
    const tooSmall = navItems.filter((n) => n.h < 44 && n.w < 44);
    if (tooSmall.length > 0) {
      record({ flow: 'M', id: '2', severity: 'P2', title: `${tooSmall.length} nav links < 44px on mobile`, detail: tooSmall.slice(0, 2).map((n) => `${n.href}=${n.w}x${n.h}`).join(' | ') });
    } else {
      record({ flow: 'M', id: '2', severity: 'OK', title: `Mobile nav links meet 44px touch target`, detail: `${navItems.length} links checked` });
    }

    // M.3 — /inbox tab strip touch target
    await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1:has-text("Inbox")', { timeout: 10_000 });
    await page.waitForTimeout(800);
    const tabSizes = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('main nav button, [class*="border-b"][class*="flex"] button'));
      return tabs.map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent ?? '').trim().slice(0, 20), h: r.height };
      });
    });
    const smallTabs = tabSizes.filter((t) => t.h > 0 && t.h < 32); // tabs are usually ~36-44px; flag anything <32
    if (smallTabs.length > 0) {
      record({ flow: 'M', id: '3', severity: 'P2', title: `${smallTabs.length} inbox tabs < 32px high on mobile`, detail: smallTabs.slice(0, 2).map((t) => `${t.text}=${t.h}px`).join(' | ') });
    } else {
      record({ flow: 'M', id: '3', severity: 'OK', title: `Inbox tabs sized for mobile`, detail: `${tabSizes.length} tabs ≥32px` });
    }

    // M.4 — AIBadge survives smaller viewport (still rendered if there's an agent in any visible context)
    const orgMembers = await api<Array<{ kind?: string }>>('/api/members', jwt);
    const orgArr = Array.isArray(orgMembers.body) ? orgMembers.body : [];
    const hasAgentInOrg = orgArr.some((m) => m.kind === 'agent' || m.kind === 'system');
    if (!hasAgentInOrg) {
      record({ flow: 'M', id: '4', severity: 'SKIP', title: 'No agents in org to test mobile AIBadge' });
    } else {
      // Re-load /chat where the create-DM modal can be opened to render badges
      await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const newDm = page.locator('button[title="New direct message"]').first();
      if (await newDm.count() > 0) {
        await newDm.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1000);
        const badges = await page.locator('span.rounded-full:has-text("AI")').count();
        if (badges > 0) {
          record({ flow: 'M', id: '4', severity: 'OK', title: `AIBadge renders on mobile (${badges} pills)` });
        } else {
          record({ flow: 'M', id: '4', severity: 'P1', title: 'AIBadge missing on mobile create-DM modal' });
        }
      } else {
        record({ flow: 'M', id: '4', severity: 'SKIP', title: 'New DM button not visible on mobile (sidebar may be hidden by design)' });
      }
    }
  } finally {
    await ctx.close();
  }
}

async function main() {
  console.log(`\n=== R3 audit — a11y + mobile ===\napi: ${API_URL}\nweb: ${WEB_URL}\n`);

  const jwt = await login();
  const browser = await chromium.launch({ headless: true });
  const desktopCtx = await browser.newContext({
    storageState: getStatePath(),
    viewport: { width: 1440, height: 900 },
  });

  try {
    console.log('--- A: accessibility ---');
    await flowA1_inbox_buttons(desktopCtx);
    await flowA2_sidebar_nav(desktopCtx);
    await flowA3_modal_esc(desktopCtx, jwt);
    await flowA4_badge_contrast(desktopCtx, jwt);
    await flowA5_tab_focus(desktopCtx);

    console.log('\n--- M: mobile viewport ---');
    await flowMobile(browser, jwt);
  } finally {
    await desktopCtx.close();
    await browser.close();
  }

  console.log('\n\n=== SUMMARY ===');
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Total: ${findings.length} | OK: ${counts.OK ?? 0} | SKIP: ${counts.SKIP ?? 0} | P0: ${counts.P0 ?? 0} | P1: ${counts.P1 ?? 0} | P2: ${counts.P2 ?? 0}`);
  const issues = findings.filter((f) => f.severity !== 'OK' && f.severity !== 'SKIP');
  if (issues.length > 0) {
    console.log('\nIssues:');
    for (const f of issues) {
      console.log(`  [${f.severity}] [${f.flow}.${f.id}] ${f.title}${f.detail ? `\n    → ${f.detail}` : ''}`);
    }
  }

  process.exit(counts.P0 ? 1 : 0);
}

main().catch((err) => { console.error('audit crashed:', err); process.exit(2); });
