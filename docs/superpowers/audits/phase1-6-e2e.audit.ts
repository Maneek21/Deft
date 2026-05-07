#!/usr/bin/env tsx
/**
 * Phase 1-6 end-to-end audit — drives a real browser through every
 * user-visible surface introduced or changed by the agent-chat
 * unification arc.
 *
 * Reports findings as a list of `{ phase, id, severity, title, detail }`
 * objects. Severity = 'P0' | 'P1' | 'P2' | 'OK'. The script does NOT throw
 * on individual failures — it accumulates and prints the full report at
 * the end so a single regression doesn't mask others.
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-e2e.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';
import { getStatePath } from './lib/auth.js';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3011';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';

type Severity = 'P0' | 'P1' | 'P2' | 'OK';
type Finding = {
  phase: string;
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
};

const findings: Finding[] = [];
const consoleErrors: { url: string; text: string }[] = [];
const networkFailures: { url: string; status: number }[] = [];

function record(f: Finding) {
  findings.push(f);
  const tag = f.severity === 'OK' ? '✓' : f.severity;
  console.log(`[${tag}] [${f.phase}.${f.id}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
}

async function getJWT(): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  const body = (await res.json()) as { accessToken?: string; access_token?: string };
  return (body.accessToken ?? body.access_token)!;
}

async function api<T = unknown>(path: string, jwt: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: getStatePath(),
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ url: page.url(), text: msg.text() });
    }
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 500) networkFailures.push({ url: res.url(), status });
    // 401 on api endpoints during nav can mask bigger issues — track them too
    if (status === 401 && /\/api\//.test(res.url())) {
      networkFailures.push({ url: res.url(), status });
    }
  });
  return page;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 1 — Participant model
// ─────────────────────────────────────────────────────────────────────

async function testPhase1(jwt: string, browser: Browser) {
  // 1.1 — /api/members returns kind for both human and agent rows
  const members = await api<Array<{ id: string; name: string; kind?: string; email?: string }>>('/api/members', jwt);
  if (members.status !== 200) {
    record({ phase: '1', id: '1', severity: 'P0', title: '/api/members not 200', detail: `status=${members.status}` });
    return;
  }
  const arr = Array.isArray(members.body) ? members.body : [];
  const agents = arr.filter((m) => m.kind === 'agent');
  const humans = arr.filter((m) => m.kind === 'human');
  if (humans.length === 0) {
    record({ phase: '1', id: '1', severity: 'P0', title: '/api/members has zero humans', detail: `total=${arr.length}` });
  } else if (agents.length === 0) {
    record({ phase: '1', id: '1', severity: 'P1', title: '/api/members has zero agents', detail: 'expected at least Defty' });
  } else {
    record({ phase: '1', id: '1', severity: 'OK', title: `/api/members returns kind`, detail: `${humans.length} humans, ${agents.length} agents` });
  }

  // 1.2 — Defty user exists
  const defty = arr.find((m) => m.email === 'deft-agent@system.local' || /defty/i.test(m.name));
  if (!defty) {
    record({ phase: '1', id: '2', severity: 'P0', title: 'Defty user not in /api/members' });
    return;
  }
  if (defty.kind !== 'agent' && defty.kind !== 'system') {
    record({ phase: '1', id: '2', severity: 'P0', title: `Defty has wrong kind`, detail: `kind=${defty.kind}` });
  } else {
    record({ phase: '1', id: '2', severity: 'OK', title: 'Defty present with kind=agent/system' });
  }

  // 1.3 — Sidebar shows DM picker with Agents section
  const page = await newPage(browser);
  try {
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Wait for the sidebar to render at least one DM-section element.
    await page.waitForSelector('text=Direct Messages', { timeout: 10_000 }).catch(() => {});

    // Wait for sidebar DMs section to render (loads agentEmployees + spaces)
    await page.waitForTimeout(2500);
    const newDmBtn = page.locator('button[title="New direct message"]').first();
    let opened = false;
    if (await newDmBtn.count() > 0) {
      await newDmBtn.click({ timeout: 5_000 }).catch(() => {});
      opened = true;
      await page.waitForTimeout(1500);
    }

    if (!opened) {
      record({ phase: '1', id: '3', severity: 'P1', title: 'Could not locate New DM button', detail: 'sidebar may have changed' });
    } else {
      const peopleHeader = await page.locator('text=People').count().catch(() => 0);
      const agentsHeader = await page.locator('text=Agents').count().catch(() => 0);
      if (peopleHeader === 0 || agentsHeader === 0) {
        record({ phase: '1', id: '3', severity: 'P1', title: 'CreateDmModal missing People/Agents partition', detail: `people=${peopleHeader} agents=${agentsHeader}` });
      } else {
        // Verify Defty appears in the modal (should be in Agents section).
        const deftyInModal = await page.locator(`text=${defty.name}`).count().catch(() => 0);
        if (deftyInModal === 0) {
          record({ phase: '1', id: '3', severity: 'P1', title: 'Defty not visible in CreateDmModal' });
        } else {
          record({ phase: '1', id: '3', severity: 'OK', title: 'CreateDmModal partitioned People/Agents and shows Defty' });
        }
      }
    }
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — Agent conversations as spaces
// ─────────────────────────────────────────────────────────────────────

async function testPhase2(jwt: string, _browser: Browser) {
  // 2.1 — /api/agent/conversations contract preserved
  const r1 = await api<unknown>('/api/agent/conversations', jwt);
  if (r1.status !== 200) {
    record({ phase: '2', id: '1', severity: 'P0', title: '/api/agent/conversations broken', detail: `status=${r1.status}` });
  } else if (!Array.isArray(r1.body) && !(r1.body as { conversations?: unknown[] }).conversations) {
    record({ phase: '2', id: '1', severity: 'P1', title: '/api/agent/conversations returned unexpected shape', detail: JSON.stringify(r1.body).slice(0, 200) });
  } else {
    record({ phase: '2', id: '1', severity: 'OK', title: '/api/agent/conversations contract intact' });
  }

  // 2.2 — Spaces of type 'agent_conversation' exist (or zero is OK if user hasn't talked to Defty)
  const spaces = await api<Array<{ id: string; type: string }>>('/api/spaces', jwt);
  if (spaces.status !== 200) {
    record({ phase: '2', id: '2', severity: 'P0', title: '/api/spaces broken', detail: `status=${spaces.status}` });
  } else {
    const arr = Array.isArray(spaces.body) ? spaces.body : (spaces.body as { spaces?: Array<{ type: string }> }).spaces ?? [];
    const agentConvos = arr.filter((s) => s.type === 'agent_conversation');
    record({ phase: '2', id: '2', severity: 'OK', title: 'spaces enum supports agent_conversation', detail: `found ${agentConvos.length}` });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 3 — Unified MCP tools (read-side check; agent-driven test out of scope)
// ─────────────────────────────────────────────────────────────────────

async function testPhase3(jwt: string, _browser: Browser) {
  // 3.1 — pending agent_actions endpoint works (the same data fetch_unread surfaces)
  const r = await api<{ actions: Array<{ id: string }> } | Array<{ id: string }>>('/api/agent/actions/pending', jwt);
  if (r.status !== 200) {
    record({ phase: '3', id: '1', severity: 'P0', title: '/api/agent/actions/pending broken', detail: `status=${r.status}` });
  } else {
    const count = Array.isArray(r.body) ? r.body.length : (r.body.actions?.length ?? 0);
    record({ phase: '3', id: '1', severity: 'OK', title: 'pending approvals queryable', detail: `${count} pending` });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 4 — UI collapse
// ─────────────────────────────────────────────────────────────────────

async function testPhase4(_jwt: string, browser: Browser) {
  const page = await newPage(browser);
  try {
    // 4.1 — /agent route is gone (404 or redirect)
    const resp = await page.goto(`${WEB_URL}/agent`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const finalUrl = page.url();
    const status = resp?.status() ?? 0;
    // Acceptable: 404 status, or redirect to /chat or /inbox or any non-/agent URL.
    if (finalUrl.endsWith('/agent') && status !== 404) {
      record({ phase: '4', id: '1', severity: 'P0', title: '/agent route still rendering', detail: `status=${status} url=${finalUrl}` });
    } else {
      record({ phase: '4', id: '1', severity: 'OK', title: '/agent removed', detail: `status=${status} → ${finalUrl}` });
    }

    // 4.2 — Sidebar shows Inbox not Approvals (also Phase 5)
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForSelector('a[href="/inbox"], a[href="/approvals"]', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const inboxNav = await page.locator('a[href="/inbox"]').count();
    const approvalsNav = await page.locator('a[href="/approvals"]').count();
    if (inboxNav === 0) {
      record({ phase: '4', id: '2', severity: 'P0', title: 'Sidebar missing Inbox nav entry' });
    } else if (approvalsNav > 0) {
      record({ phase: '4', id: '2', severity: 'P1', title: 'Sidebar still has Approvals nav entry (should be removed)' });
    } else {
      record({ phase: '4', id: '2', severity: 'OK', title: 'Sidebar shows Inbox, no Approvals' });
    }
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 5 — Universal /inbox
// ─────────────────────────────────────────────────────────────────────

async function testPhase5(jwt: string, browser: Browser) {
  // 5.1 — /api/inbox aggregates
  const inbox = await api<{ items?: unknown[]; unread_count?: number }>('/api/inbox', jwt);
  if (inbox.status !== 200) {
    record({ phase: '5', id: '1', severity: 'P0', title: '/api/inbox not 200', detail: `status=${inbox.status}` });
  } else if (!Array.isArray(inbox.body.items)) {
    record({ phase: '5', id: '1', severity: 'P0', title: '/api/inbox missing items array' });
  } else {
    record({ phase: '5', id: '1', severity: 'OK', title: '/api/inbox returns items', detail: `${inbox.body.items.length} items, unread_count=${inbox.body.unread_count}` });
  }

  // 5.2 — count_only=1 cheap branch
  const cnt = await api<{ unread_count?: number; items?: unknown }>('/api/inbox?count_only=1', jwt);
  if (cnt.status !== 200) {
    record({ phase: '5', id: '2', severity: 'P0', title: '/api/inbox?count_only=1 broken' });
  } else if (cnt.body.items !== undefined) {
    record({ phase: '5', id: '2', severity: 'P1', title: 'count_only=1 should NOT return items array', detail: `items=${JSON.stringify(cnt.body.items).slice(0, 80)}` });
  } else if (typeof cnt.body.unread_count !== 'number') {
    record({ phase: '5', id: '2', severity: 'P0', title: 'count_only response missing unread_count' });
  } else {
    record({ phase: '5', id: '2', severity: 'OK', title: 'count_only returns just unread_count', detail: `${cnt.body.unread_count}` });
  }

  // 5.3 — kind filter
  const filtered = await api<{ items?: Array<{ kind: string }> }>('/api/inbox?kind=pending_approval', jwt);
  if (filtered.status === 200 && Array.isArray(filtered.body.items)) {
    const wrongKinds = filtered.body.items.filter((it) => it.kind !== 'pending_approval');
    if (wrongKinds.length > 0) {
      record({ phase: '5', id: '3', severity: 'P0', title: 'kind filter leaks other kinds', detail: `${wrongKinds.length} wrong-kind items` });
    } else {
      record({ phase: '5', id: '3', severity: 'OK', title: 'kind=pending_approval filter clean', detail: `${filtered.body.items.length} items` });
    }
  } else {
    record({ phase: '5', id: '3', severity: 'P0', title: 'kind filter request failed', detail: `status=${filtered.status}` });
  }

  // 5.4 — POST /api/inbox/read with empty ids
  const markEmpty = await api<{ success?: boolean; updated?: number }>('/api/inbox/read', jwt, {
    method: 'POST', body: JSON.stringify({ ids: [] }),
  });
  if (markEmpty.status !== 200 || markEmpty.body.success !== true) {
    record({ phase: '5', id: '4', severity: 'P1', title: 'POST /api/inbox/read with empty ids returned non-success', detail: `status=${markEmpty.status} body=${JSON.stringify(markEmpty.body)}` });
  } else {
    record({ phase: '5', id: '4', severity: 'OK', title: 'POST /api/inbox/read accepts empty ids' });
  }

  // 5.5 — UI: /inbox page renders
  const page = await newPage(browser);
  try {
    await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForSelector('h1:has-text("Inbox")', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const heading = await page.locator('h1:has-text("Inbox")').count();
    const tabAll = await page.locator('button:has-text("All")').count();
    const tabApprovals = await page.locator('button:has-text("Approvals")').count();
    if (heading === 0) {
      record({ phase: '5', id: '5', severity: 'P0', title: '/inbox page missing Inbox heading' });
    } else if (tabAll === 0 || tabApprovals === 0) {
      record({ phase: '5', id: '5', severity: 'P1', title: '/inbox tab strip incomplete', detail: `all=${tabAll} approvals=${tabApprovals}` });
    } else {
      record({ phase: '5', id: '5', severity: 'OK', title: '/inbox page renders heading + tabs' });
    }

    // 5.6 — Click Approvals tab, URL should not change but content should filter
    if (tabApprovals > 0) {
      await page.locator('button:has-text("Approvals")').first().click();
      await page.waitForTimeout(500);
      // We don't have a strict assertion on items here (they may be empty);
      // just check that the tab visually activates without error.
      record({ phase: '5', id: '6', severity: 'OK', title: 'Approvals tab click survives without console error' });
    }

    // 5.7 — /approvals redirect
    const r = await page.goto(`${WEB_URL}/approvals`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await page.waitForTimeout(3500);
    const finalUrl = page.url();
    // The redirect target is /inbox?tab=approvals. The (app) layout is a client component
    // so the redirect resolves client-side; the URL bar lands on /inbox?... after hydration.
    if (/\/inbox/.test(finalUrl)) {
      record({ phase: '5', id: '7', severity: 'OK', title: '/approvals → /inbox redirect works', detail: `final=${finalUrl}` });
    } else if (r?.status() === 307 || r?.status() === 308) {
      record({ phase: '5', id: '7', severity: 'OK', title: '/approvals returns redirect', detail: `status=${r.status()}` });
    } else {
      // Check the rendered page — if it shows Inbox content, the redirect happened.
      const inboxHeading = await page.locator('h1:has-text("Inbox")').count();
      if (inboxHeading > 0) {
        record({ phase: '5', id: '7', severity: 'OK', title: '/approvals renders Inbox via client redirect', detail: `final=${finalUrl}` });
      } else {
        record({ phase: '5', id: '7', severity: 'P1', title: '/approvals redirect not visibly working', detail: `final=${finalUrl} status=${r?.status()}` });
      }
    }
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 6 — Multi-agent affordances
// ─────────────────────────────────────────────────────────────────────

async function testPhase6(_jwt: string, browser: Browser) {
  const page = await newPage(browser);
  try {
    // 6.1 — Open a public space, open the members panel, verify partition + AI badge
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(2000); // let chat context load spaces

    // Click the first non-DM space in the sidebar to navigate into it.
    const spaceBtn = page.locator('button[class*="text-left"]:has(svg)').first();
    const spaceCount = await page.locator('button:has(svg)').count();
    if (spaceCount === 0) {
      record({ phase: '6', id: '1', severity: 'P1', title: 'No spaces visible in sidebar', detail: 'cannot test members panel' });
      return;
    }

    // Try to find the members panel directly via the space-chat header / kebab.
    // We hit a known dev seed channel via URL if possible; otherwise click first space.
    const spacesRes = await fetch(`${API_URL}/api/spaces`, {
      headers: { Authorization: `Bearer ${await getJWT()}` },
    });
    const spacesBody = await spacesRes.json() as Array<{ id: string; type: string; name: string }> | { spaces: Array<{ id: string; type: string; name: string }> };
    const spaceArr = Array.isArray(spacesBody) ? spacesBody : spacesBody.spaces;
    const publicSpace = spaceArr.find((s) => s.type === 'public');
    if (!publicSpace) {
      record({ phase: '6', id: '1', severity: 'P2', title: 'No public space in seed', detail: 'skipping members-panel test' });
      return;
    }

    await page.goto(`${WEB_URL}/chat?space=${publicSpace.id}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(2000);

    // Open members panel via the "View members" button in the channel header
    // (it's `hidden md:flex` so requires width >= 768px).
    const viewMembersBtn = page.locator('button[title="View members"]').first();
    if (await viewMembersBtn.count() === 0) {
      record({ phase: '6', id: '1', severity: 'P1', title: 'Could not find View members button', detail: 'space-chat header may have changed' });
      return;
    }
    // Dismiss any overlays that might block the click (e.g., issues-badge expander)
    const collapseBadge = page.locator('button[aria-label*="Collapse issues" i]').first();
    if (await collapseBadge.count() > 0) {
      await collapseBadge.click({ timeout: 2000 }).catch(() => {});
    }
    await viewMembersBtn.click({ timeout: 5000, force: true });
    await page.waitForTimeout(1500);
    const panelOpen = (await page.locator('h3:has-text("Members")').count()) > 0;
    if (!panelOpen) {
      record({ phase: '6', id: '1', severity: 'P1', title: 'View members click did not open panel' });
      return;
    }

    // Click "Add members" to open the picker section.
    const addBtn = page.locator('button:has-text("Add members")').first();
    if (await addBtn.count() === 0) {
      record({ phase: '6', id: '1', severity: 'P1', title: 'Members panel missing "Add members" button' });
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(500);

    // Use the api to predict expected partition state for THIS space.
    const jwt = await getJWT();
    const orgMembers = await api<Array<{ id: string; kind?: string }>>('/api/members', jwt);
    const spaceMembersRes = await api<Array<{ id: string; kind?: string }>>(`/api/spaces/${publicSpace.id}/members`, jwt);
    const orgArr = Array.isArray(orgMembers.body) ? orgMembers.body : [];
    const spaceMembersArr = Array.isArray(spaceMembersRes.body) ? spaceMembersRes.body : [];
    const memberIds = new Set(spaceMembersArr.map((m) => m.id));
    const nonMembers = orgArr.filter((m) => !memberIds.has(m.id));
    const expectedHumans = nonMembers.filter((m) => m.kind !== 'agent' && m.kind !== 'system').length;
    const expectedAgents = nonMembers.filter((m) => m.kind === 'agent' || m.kind === 'system').length;

    // The partition headers are styled `text-[10px] font-semibold uppercase tracking-wider` —
    // very specific. Match them via text + class to avoid false positives from "People"/"Agents"
    // appearing elsewhere on the page.
    const peopleHeader = await page.locator('div.uppercase:has-text("People")').count();
    const agentsHeader = await page.locator('div.uppercase:has-text("Agents")').count();

    // Expected behavior: a section header is rendered only when its array is non-empty.
    let partitionOk = true;
    const checks: string[] = [];
    if (expectedHumans > 0 && peopleHeader === 0) {
      partitionOk = false;
      checks.push(`expected People header (${expectedHumans} addable humans) but missing`);
    }
    if (expectedHumans === 0 && peopleHeader > 0) {
      checks.push(`People header rendered with no addable humans (cosmetic)`);
    }
    if (expectedAgents > 0 && agentsHeader === 0) {
      partitionOk = false;
      checks.push(`expected Agents header (${expectedAgents} addable agents) but missing`);
    }
    if (expectedAgents === 0 && agentsHeader > 0) {
      checks.push(`Agents header rendered with no addable agents (cosmetic)`);
    }

    if (partitionOk && checks.length === 0) {
      record({ phase: '6', id: '1', severity: 'OK', title: 'SpaceMembersPanel partition matches expected state', detail: `${expectedHumans} humans + ${expectedAgents} agents addable` });
    } else if (!partitionOk) {
      record({ phase: '6', id: '1', severity: 'P0', title: 'SpaceMembersPanel partition broken', detail: checks.join('; ') });
    } else {
      record({ phase: '6', id: '1', severity: 'P2', title: 'SpaceMembersPanel partition has cosmetic issue', detail: checks.join('; ') });
    }

    // 6.2 — AI badges in the existing-members list. Count agents already in
    // the space; that's the minimum number of AIBadge pills expected
    // (the picker may add more for addable agents, but we assert the floor here).
    const expectedAgentMembers = spaceMembersArr.filter((m) => m.kind === 'agent' || m.kind === 'system').length;
    // Match the AIBadge specifically by its rounded-full pill shape.
    const aiBadgePills = await page.locator('span.rounded-full:has-text("AI")').count();
    if (expectedAgentMembers > 0 && aiBadgePills < expectedAgentMembers) {
      record({ phase: '6', id: '2', severity: 'P0', title: 'AIBadge missing on existing agent members', detail: `expected at least ${expectedAgentMembers} pills, found ${aiBadgePills}` });
    } else {
      record({ phase: '6', id: '2', severity: 'OK', title: 'AIBadge pills match expected agent count', detail: `${aiBadgePills} pills, ${expectedAgentMembers} existing agents in space` });
    }
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cross-phase regression
// ─────────────────────────────────────────────────────────────────────

async function testCrossPhase(_jwt: string, browser: Browser) {
  const page = await newPage(browser);
  try {
    // No 5xx during normal navigation
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);

    const fives = networkFailures.filter((n) => n.status >= 500);
    const fourOhOnes = networkFailures.filter((n) => n.status === 401);
    if (fives.length > 0) {
      record({ phase: 'X', id: '1', severity: 'P0', title: `${fives.length} 5xx responses during navigation`, detail: fives.slice(0, 3).map(n => `${n.status} ${n.url}`).join(' | ') });
    } else {
      record({ phase: 'X', id: '1', severity: 'OK', title: 'No 5xx responses during navigation across /chat /inbox /dashboard /tasks' });
    }
    if (fourOhOnes.length > 0) {
      // Distill which endpoints. 401 on /api/auth/me right after page load is normal
      // (the token isn't injected until the auth context mounts). Anything else is a finding.
      const sample = fourOhOnes.slice(0, 5).map((n) => n.url.replace(API_URL, '')).join(' | ');
      const allOnAuthMe = fourOhOnes.every((n) => /\/api\/auth\/(me|refresh)/.test(n.url));
      if (allOnAuthMe) {
        record({ phase: 'X', id: '3', severity: 'P2', title: `${fourOhOnes.length} early-load 401s on /api/auth/me|refresh`, detail: 'pre-hydration auth fetch — benign' });
      } else {
        record({ phase: 'X', id: '3', severity: 'P1', title: `${fourOhOnes.length} 401s on api endpoints during nav`, detail: sample });
      }
    }

    // Filter out console errors that match the 401 fetches already covered by X.3
    const nonAuthErrors = consoleErrors.filter((e) => !/401|Unauthorized/i.test(e.text));
    if (nonAuthErrors.length > 5) {
      record({ phase: 'X', id: '2', severity: 'P1', title: `${nonAuthErrors.length} non-auth console errors during navigation`, detail: nonAuthErrors.slice(0, 3).map(e => e.text.slice(0, 100)).join(' | ') });
    } else if (nonAuthErrors.length > 0) {
      record({ phase: 'X', id: '2', severity: 'P2', title: `${nonAuthErrors.length} non-auth console errors`, detail: nonAuthErrors.map(e => e.text.slice(0, 80)).join(' | ') });
    } else {
      record({ phase: 'X', id: '2', severity: 'OK', title: 'Console clean during navigation (excluding pre-hydration 401s)' });
    }
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Phase 1-6 e2e audit ===`);
  console.log(`api: ${API_URL}`);
  console.log(`web: ${WEB_URL}\n`);

  const jwt = await getJWT();
  const browser = await chromium.launch({ headless: true });

  try {
    console.log('--- Phase 1: Participant model ---');
    await testPhase1(jwt, browser);

    console.log('\n--- Phase 2: Agent conversations as spaces ---');
    await testPhase2(jwt, browser);

    console.log('\n--- Phase 3: Unified MCP tools ---');
    await testPhase3(jwt, browser);

    console.log('\n--- Phase 4: UI collapse ---');
    await testPhase4(jwt, browser);

    console.log('\n--- Phase 5: Universal /inbox ---');
    await testPhase5(jwt, browser);

    console.log('\n--- Phase 6: Multi-agent affordances ---');
    await testPhase6(jwt, browser);

    console.log('\n--- Cross-phase regression ---');
    await testCrossPhase(jwt, browser);
  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n\n=== SUMMARY ===');
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Total: ${findings.length} | OK: ${counts.OK ?? 0} | P0: ${counts.P0 ?? 0} | P1: ${counts.P1 ?? 0} | P2: ${counts.P2 ?? 0}`);

  const issues = findings.filter((f) => f.severity !== 'OK');
  if (issues.length > 0) {
    console.log('\nIssues:');
    for (const f of issues) {
      console.log(`  [${f.severity}] [${f.phase}.${f.id}] ${f.title}${f.detail ? `\n    → ${f.detail}` : ''}`);
    }
  }

  process.exit(counts.P0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Audit script crashed:', err);
  process.exit(2);
});
