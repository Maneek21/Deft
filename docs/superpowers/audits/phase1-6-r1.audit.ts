#!/usr/bin/env tsx
/**
 * Round 1 audit — multi-tab real-time + storm detector live trip.
 *
 * Flows:
 *   M1. Two-tab message arrival      — Send a message via API; second tab
 *                                      currently viewing the space sees it
 *                                      via Socket.io within ~1.5s.
 *   M2. Two-tab inbox count          — POST /api/inbox/read in tab A; tab B's
 *                                      sidebar Inbox badge updates within ~15s
 *                                      (SWR refresh interval).
 *   S1. Storm detector trip          — Insert 5 agent thread replies. Attempt
 *                                      a 6th via the agent_actions executor.
 *                                      Verify error includes STORM_DETECTED.
 *   S2. Storm scope: top-level       — Same agent posts top-level in same
 *                                      space → succeeds.
 *   S3. Storm scope: other thread    — Same agent posts in DIFFERENT thread
 *                                      → succeeds.
 *   S4. Storm scope: human exempt    — A human (Maneek) posts in the same
 *                                      stormed thread → succeeds.
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-r1.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser } from 'playwright';
import { eq, inArray, and, gt, sql } from 'drizzle-orm';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';
// Direct executor import — same path the unit tests use, but exercised
// against the live DB so we know the storm guard fires end-to-end.
import { executeActionDirect } from '../../../apps/api/src/lib/agent-actions.js';

const { messages, users, spaces, agentActions } = schema;

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

async function login(): Promise<{ jwt: string; userId: string; orgId: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  const body = (await res.json()) as {
    accessToken?: string; access_token?: string;
    user: { id: string };
    org_id: string;
  };
  return {
    jwt: (body.accessToken ?? body.access_token)!,
    userId: body.user.id,
    orgId: body.org_id,
  };
}

async function getJWT(): Promise<string> {
  return (await login()).jwt;
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

// ─────────────────────────────────────────────────────────────────────
// M1 — Multi-tab message arrival via Socket.io
// ─────────────────────────────────────────────────────────────────────

async function flowM1_multitab_message(browser: Browser, jwt: string) {
  const spaces = await api<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const spacesArr = Array.isArray(spaces.body) ? spaces.body : [];
  const target = spacesArr.find((s) => s.type === 'public');
  if (!target) { record({ flow: 'M1', id: '1', severity: 'SKIP', title: 'No public space' }); return; }

  // Open two contexts (separate sockets)
  const ctxA = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // Both navigate to the same space
    await Promise.all([
      pageA.goto(`${WEB_URL}/chat?space=${target.id}`, { waitUntil: 'domcontentloaded' }),
      pageB.goto(`${WEB_URL}/chat?space=${target.id}`, { waitUntil: 'domcontentloaded' }),
    ]);
    // Give both pages time to mount and connect their sockets.
    await pageA.waitForTimeout(3500);
    await pageB.waitForTimeout(500);

    const marker = `r1-multitab-${Date.now()}`;
    const messageContent = `Round 1 multitab marker ${marker}`;

    // Have a Socket.io listener log on pageB BEFORE we send the message.
    await pageB.evaluate((mark) => {
      (window as unknown as { __r1_marker_seen?: number }).__r1_marker_seen = 0;
      // Hook into existing socket if present (chat-context exposes it via window?)
      // Fallback: poll DOM for the marker text.
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes(mark)) {
          (window as unknown as { __r1_marker_seen: number }).__r1_marker_seen = Date.now();
        }
      });
      observer.observe(document.body, { subtree: true, characterData: true, childList: true });
    }, marker);

    // Send a message via API (simulates what tab A would do).
    // Path is /api/messages/:spaceId, not /api/messages with body.space_id.
    const sendStart = Date.now();
    const sendRes = await api(`/api/messages/${target.id}`, jwt, {
      method: 'POST',
      body: JSON.stringify({ content: messageContent }),
    });
    if (sendRes.status !== 200 && sendRes.status !== 201) {
      record({ flow: 'M1', id: '1', severity: 'P0', title: 'POST /api/messages/:id failed', detail: `status=${sendRes.status} body=${JSON.stringify(sendRes.body).slice(0, 100)}` });
      return;
    }

    // Wait up to 12s for tab B to see the marker text. Socket.io needs to
    // (re)connect after page mount; chat-context joins the space-room async.
    let seenAt = 0;
    for (let i = 0; i < 120; i++) {
      seenAt = await pageB.evaluate(() => (window as unknown as { __r1_marker_seen: number }).__r1_marker_seen);
      if (seenAt > 0) break;
      await pageB.waitForTimeout(100);
    }

    if (seenAt === 0) {
      record({ flow: 'M1', id: '1', severity: 'P1', title: 'Tab B did NOT see new message within 12s', detail: `marker=${marker}` });
    } else {
      const lag = seenAt - sendStart;
      const sev: Severity = lag > 5000 ? 'P2' : 'OK';
      record({ flow: 'M1', id: '1', severity: sev, title: `Tab B saw new message after ${lag}ms` });
    }

    // Cleanup: soft-delete the test message
    await db.update(messages)
      .set({ is_deleted: true })
      .where(and(eq(messages.space_id, target.id), eq(messages.content, messageContent)));
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// M2 — Multi-tab inbox count update via SWR
// ─────────────────────────────────────────────────────────────────────

async function flowM2_multitab_inbox(browser: Browser, jwt: string, orgId: string, meId: string) {
  // Manufacture a fresh notification to mark-read so we always have something
  // to decrement (this audit is run repeatedly — seed state may be drained).
  await db.insert(schema.notifications).values({
    org_id: orgId,
    user_id: meId,
    type: 'system',
    title: '[r1-multitab seed]',
    is_read: false,
  });
  // Verify count is now > 0
  const before = await api<{ unread_count: number; items: Array<{ kind: string; id: string }> }>('/api/inbox?limit=100', jwt);
  if ((before.body?.unread_count ?? 0) === 0) {
    record({ flow: 'M2', id: '1', severity: 'SKIP', title: 'unread_count remains 0 after seeding — inbox API issue?' });
    return;
  }

  const ctxA = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // Tab B opens /chat (so its sidebar Inbox badge reflects current count via useInboxCount)
    await pageB.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('a[href="/inbox"]', { timeout: 10_000 });
    await pageB.waitForTimeout(3500); // let badge settle

    // Read tab B's badge
    async function readBadge(): Promise<number> {
      return await pageB.evaluate(() => {
        const link = document.querySelector('a[href="/inbox"]');
        if (!link) return 0;
        const badge = link.querySelector('div');
        const text = (badge?.textContent ?? '').trim();
        if (!text || !/^\d+/.test(text)) return 0;
        return parseInt(text.replace('+', ''), 10);
      });
    }
    const tabBStart = await readBadge();

    // Tab A: POST mark all read
    await pageA.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('h1:has-text("Inbox")', { timeout: 10_000 });
    await pageA.waitForTimeout(800);
    const markBtn = pageA.locator('button:has-text("Mark all read")').first();
    if (await markBtn.count() === 0) {
      // Fall back to API
      await api('/api/inbox/read', jwt, { method: 'POST', body: JSON.stringify({ all: true }) });
    } else {
      await markBtn.click();
      await pageA.waitForTimeout(1500);
    }

    // Wait up to 17s for tab B's badge to update (15s SWR refresh + 2s slack)
    let tabBNow = tabBStart;
    let waited = 0;
    while (waited < 17_000) {
      await pageB.waitForTimeout(1000);
      waited += 1000;
      tabBNow = await readBadge();
      if (tabBNow < tabBStart) break;
    }

    if (tabBStart === 0) {
      record({ flow: 'M2', id: '1', severity: 'SKIP', title: 'Tab B badge was 0 before mark-read; cannot test decrement', detail: 'badge fetch may have lagged the seed insert' });
    } else if (tabBNow >= tabBStart) {
      record({ flow: 'M2', id: '1', severity: 'P1', title: `Tab B badge did NOT decrement after ${waited}ms`, detail: `before=${tabBStart} after=${tabBNow}` });
    } else {
      record({ flow: 'M2', id: '1', severity: 'OK', title: `Tab B badge decremented within ${waited}ms`, detail: `before=${tabBStart} → after=${tabBNow}` });
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
    // Cleanup the seed notification
    await db.delete(schema.notifications).where(and(
      eq(schema.notifications.user_id, meId),
      eq(schema.notifications.title, '[r1-multitab seed]'),
    )).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────
// S1-S4 — Storm detector live trip + scope checks
// ─────────────────────────────────────────────────────────────────────

async function flowStorm(_browser: Browser, jwt: string) {
  // Setup: pick a public space and create a thread root + 5 agent replies + control rows.
  const spacesRes = await api<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const spacesArr = Array.isArray(spacesRes.body) ? spacesRes.body : [];
  const space = spacesArr.find((s) => s.type === 'public');
  if (!space) { record({ flow: 'S', id: '0', severity: 'SKIP', title: 'No public space for storm test' }); return; }

  // Org members & users we need: Maneek (human) and an agent user
  const auth = await login();
  const orgId = auth.orgId;
  const meId = auth.userId;

  const orgMembers = await api<Array<{ id: string; kind?: string; email?: string; name?: string }>>('/api/members', jwt);
  const orgArr = Array.isArray(orgMembers.body) ? orgMembers.body : [];
  const agentUser = orgArr.find((m) => m.email === 'deft-agent@system.local');
  if (!agentUser) { record({ flow: 'S', id: '0', severity: 'SKIP', title: 'No Defty user' }); return; }

  console.log(`[storm] org=${orgId} space=${space.id} agent=${agentUser.id} (${agentUser.name})`);

  const created: string[] = [];
  const cleanup = async () => {
    if (created.length) {
      await db.delete(messages).where(inArray(messages.id, created));
    }
  };

  try {
    // 1. Create a thread root (Maneek posts top-level)
    const [threadRoot] = await db.insert(messages).values({
      org_id: orgId, space_id: space.id, user_id: meId, content: `[r1-storm root] ${Date.now()}`,
    }).returning();
    created.push(threadRoot.id);

    // 2. Create another thread root for the cross-thread control
    const [otherRoot] = await db.insert(messages).values({
      org_id: orgId, space_id: space.id, user_id: meId, content: `[r1-storm other-root] ${Date.now()}`,
    }).returning();
    created.push(otherRoot.id);

    // 3. Insert 5 agent replies in threadRoot (this is what should trip the storm)
    for (let i = 0; i < 5; i++) {
      const [m] = await db.insert(messages).values({
        org_id: orgId, space_id: space.id, user_id: agentUser.id,
        content: `[r1-storm agent reply ${i}]`, parent_id: threadRoot.id,
      }).returning();
      created.push(m.id);
    }

    // ── S1: 6th agent reply via executor → STORM_DETECTED ──────────────
    // Use executeActionDirect with the agent's user_id — same path the
    // unit tests use, but exercised against the live DB. This is the
    // CANONICAL test of the storm guard.
    const sixth = await executeActionDirect(
      'post_thread_reply',
      { parent_message_id: threadRoot.id, content: '[r1-storm 6th]' },
      orgId,
      agentUser.id,
      null,
      'full',
    );
    if (!sixth.error || !/STORM_DETECTED/i.test(sixth.error)) {
      record({ flow: 'S', id: '1', severity: 'P0', title: 'Storm did NOT trip on 6th agent thread reply', detail: `success=${sixth.success} error=${sixth.error} result=${JSON.stringify(sixth.result)}` });
    } else {
      // Verify 6th was NOT inserted
      const replies = await db.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.parent_id, threadRoot.id), eq(messages.user_id, agentUser.id), eq(messages.is_deleted, false)));
      if (replies.length > 5) {
        record({ flow: 'S', id: '1', severity: 'P0', title: `Storm tripped BUT 6th reply was inserted`, detail: `count=${replies.length}` });
      } else {
        record({ flow: 'S', id: '1', severity: 'OK', title: 'Storm trip prevented 6th reply', detail: sixth.error.slice(0, 90) });
      }
    }

    // ── S2: top-level post in same space → succeeds (not throttled) ────
    const topLevel = await executeActionDirect(
      'post_message',
      { space_name: space.name, content: '[r1-storm top-level control]' },
      orgId,
      agentUser.id,
      null,
      'full',
    );
    if (topLevel.error && /STORM_DETECTED/i.test(topLevel.error)) {
      record({ flow: 'S', id: '2', severity: 'P0', title: 'STORM_DETECTED leaked to top-level post', detail: topLevel.error.slice(0, 100) });
    } else if (!topLevel.success) {
      record({ flow: 'S', id: '2', severity: 'P1', title: 'Top-level post failed for non-storm reason', detail: topLevel.error?.slice(0, 100) });
    } else {
      record({ flow: 'S', id: '2', severity: 'OK', title: 'Top-level post succeeded (not throttled)' });
      const r = topLevel.result as { message_id?: string };
      if (r.message_id) created.push(r.message_id);
    }

    // ── S3: agent reply in DIFFERENT thread → succeeds ─────────────────
    const otherThread = await executeActionDirect(
      'post_thread_reply',
      { parent_message_id: otherRoot.id, content: '[r1-storm other-thread control]' },
      orgId,
      agentUser.id,
      null,
      'full',
    );
    if (otherThread.error && /STORM_DETECTED/i.test(otherThread.error)) {
      record({ flow: 'S', id: '3', severity: 'P0', title: 'STORM_DETECTED leaked to OTHER thread', detail: otherThread.error.slice(0, 100) });
    } else if (!otherThread.success) {
      record({ flow: 'S', id: '3', severity: 'P1', title: 'Cross-thread reply failed for non-storm reason', detail: otherThread.error?.slice(0, 100) });
    } else {
      record({ flow: 'S', id: '3', severity: 'OK', title: 'Cross-thread reply succeeded (per-thread scope holds)' });
      const r = otherThread.result as { message_id?: string };
      if (r.message_id) created.push(r.message_id);
    }

    // ── S4: human posts in stormed thread → succeeds ───────────────────
    const humanPost = await api<{ id?: string }>(`/api/messages/${space.id}`, jwt, {
      method: 'POST',
      body: JSON.stringify({ content: '[r1-storm human in stormed thread]', parent_id: threadRoot.id }),
    });
    if (humanPost.status !== 200 && humanPost.status !== 201) {
      record({ flow: 'S', id: '4', severity: 'P1', title: `Human post in stormed thread returned ${humanPost.status}`, detail: JSON.stringify(humanPost.body).slice(0, 100) });
    } else if ((humanPost.body as { id?: string }).id) {
      record({ flow: 'S', id: '4', severity: 'OK', title: 'Human post in stormed thread succeeded' });
      created.push((humanPost.body as { id: string }).id);
    } else {
      record({ flow: 'S', id: '4', severity: 'P2', title: 'Human post returned 200 but no id', detail: JSON.stringify(humanPost.body).slice(0, 100) });
    }

    // ── S5: storm should auto-resolve after window ──────────────────────
    // Back-date the 5 seed replies by 11 minutes and re-attempt the 6th.
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000);
    await db.update(messages)
      .set({ created_at: elevenMinAgo })
      .where(and(
        eq(messages.parent_id, threadRoot.id),
        eq(messages.user_id, agentUser.id),
        eq(messages.is_deleted, false),
        sql`${messages.content} LIKE '[r1-storm agent reply%'`,
      ));
    const postWindow = await executeActionDirect(
      'post_thread_reply',
      { parent_message_id: threadRoot.id, content: '[r1-storm post-window]' },
      orgId,
      agentUser.id,
      null,
      'full',
    );
    if (postWindow.error && /STORM_DETECTED/i.test(postWindow.error)) {
      record({ flow: 'S', id: '5', severity: 'P1', title: 'Storm did not clear after rolling window passed', detail: postWindow.error.slice(0, 100) });
    } else if (!postWindow.success) {
      record({ flow: 'S', id: '5', severity: 'P1', title: 'Post-window reply failed for non-storm reason', detail: postWindow.error?.slice(0, 100) });
    } else {
      record({ flow: 'S', id: '5', severity: 'OK', title: 'Storm cleared after window — agent reply accepted' });
      const r = postWindow.result as { message_id?: string };
      if (r.message_id) created.push(r.message_id);
    }

    // ── S6: BUG — approve-route uses approver's user_id, not agent's ───
    // The /api/agent/actions/:id/approve route passes user.id (the approver)
    // to executeAction. This means: (a) the inserted message is authored
    // by the human approver, not the proposing agent; (b) the storm guard
    // checks the human's count instead of the agent's, defeating Phase 6
    // for the manual-approval path.
    const [approveActionRow] = await db.insert(agentActions).values({
      org_id: orgId, user_id: agentUser.id,
      action: 'post_thread_reply',
      params: { parent_message_id: otherRoot.id, content: '[r1-storm approve-bug check]' },
      approval_status: 'pending', approval_tier: 'full', source: 'mention',
    }).returning();
    const approveRes = await api<unknown>(`/api/agent/actions/${approveActionRow.id}/approve`, jwt, {
      method: 'POST', body: JSON.stringify({}),
    });
    if (approveRes.status === 200) {
      // Find the inserted message — author should be agent, not Maneek
      const inserted = await db.select({ id: messages.id, user_id: messages.user_id }).from(messages)
        .where(and(eq(messages.parent_id, otherRoot.id), eq(messages.content, '[r1-storm approve-bug check]')))
        .limit(1);
      if (inserted.length === 0) {
        record({ flow: 'S', id: '6', severity: 'P1', title: 'Approve-route: post_thread_reply approval did not insert message' });
      } else if (inserted[0].user_id === agentUser.id) {
        record({ flow: 'S', id: '6', severity: 'OK', title: 'Approve-route preserves agent identity' });
        created.push(inserted[0].id);
      } else if (inserted[0].user_id === meId) {
        record({ flow: 'S', id: '6', severity: 'P0', title: 'BUG: approve-route attributes agent action to approver', detail: `expected user_id=${agentUser.id} (Defty) got=${inserted[0].user_id} (Maneek). Storm guard also runs against wrong user.` });
        created.push(inserted[0].id);
      } else {
        record({ flow: 'S', id: '6', severity: 'P1', title: 'Approve-route author unexpected', detail: `inserted user_id=${inserted[0].user_id}` });
        created.push(inserted[0].id);
      }
    } else {
      record({ flow: 'S', id: '6', severity: 'P1', title: `Approve route returned ${approveRes.status}` });
    }
  } finally {
    await cleanup();
    // Also clean up the agent_actions rows we created
    await db.delete(agentActions).where(and(
      eq(agentActions.org_id, orgId),
      eq(agentActions.user_id, agentUser.id),
      sql`${agentActions.params}::text LIKE '%r1-storm%'`,
    )).catch(() => {});
  }
}

async function main() {
  console.log(`\n=== R1 audit — multi-tab + storm-live ===`);
  console.log(`api: ${API_URL}\nweb: ${WEB_URL}\n`);

  const auth = await login();
  const jwt = auth.jwt;
  const browser = await chromium.launch({ headless: true });

  try {
    console.log('--- M1: multitab message arrival ---');
    await flowM1_multitab_message(browser, jwt);

    console.log('\n--- M2: multitab inbox count ---');
    await flowM2_multitab_inbox(browser, jwt, auth.orgId, auth.userId);

    console.log('\n--- S1-S6: storm detector live ---');
    await flowStorm(browser, jwt);
  } finally {
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
