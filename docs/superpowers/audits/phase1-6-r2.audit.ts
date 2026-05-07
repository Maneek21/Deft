#!/usr/bin/env tsx
/**
 * Round 2 audit — cross-tenant isolation + agent reply round-trip.
 *
 * Cross-tenant: create a fresh org B with its own user, space, message,
 * notification, and agent_action. Use Maneek's JWT (org A) to hit every
 * Phase 1-6 endpoint with org B's IDs and confirm none leak. Bonus:
 * verify POST /api/inbox/read with another user's notif id is a no-op.
 *
 * Agent reply: send "@deft" in a public space, wait up to 60s for the
 * reply, inspect rendering — text, tool chips, model+tokens footer,
 * metadata.agent_blocks, agent authorship.
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-r2.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser } from 'playwright';
import { eq, and, inArray, desc, gt, sql } from 'drizzle-orm';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';

const { messages, users, spaces, spaceMembers, orgs, orgMembers, notifications, agentActions } = schema;

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
  const body = (await res.json()) as { accessToken: string; user: { id: string }; org_id: string };
  return { jwt: body.accessToken, userId: body.user.id, orgId: body.org_id };
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
// CT — Cross-tenant isolation
// ─────────────────────────────────────────────────────────────────────

async function flowCrossTenant(jwt: string, attackerOrgId: string, attackerUserId: string) {
  const ts = Date.now();
  const created = {
    orgId: '' as string,
    userIds: [] as string[],
    spaceId: '' as string,
    messageId: '' as string,
    notifId: '' as string,
    actionId: '' as string,
  };

  try {
    // Set up a fresh org B
    const [orgB] = await db.insert(orgs).values({ name: `r2-victim-${ts}`, slug: `r2-victim-${ts}` }).returning();
    created.orgId = orgB.id;

    const [victim] = await db.insert(users).values({
      email: `r2-victim-${ts}@test.com`, name: 'Victim', org_id: orgB.id, kind: 'human',
    }).returning();
    created.userIds.push(victim.id);
    await db.insert(orgMembers).values({ org_id: orgB.id, user_id: victim.id, role: 'owner' });

    const [secretSpace] = await db.insert(spaces).values({
      name: 'r2-victim-secret', type: 'private', org_id: orgB.id, created_by: victim.id,
    }).returning();
    created.spaceId = secretSpace.id;
    await db.insert(spaceMembers).values({ space_id: secretSpace.id, user_id: victim.id });

    const [secretMsg] = await db.insert(messages).values({
      org_id: orgB.id, space_id: secretSpace.id, user_id: victim.id, content: 'TOP SECRET',
    }).returning();
    created.messageId = secretMsg.id;

    const [secretNotif] = await db.insert(notifications).values({
      org_id: orgB.id, user_id: victim.id, type: 'mention', title: 'Secret mention', is_read: false,
    }).returning();
    created.notifId = secretNotif.id;

    const [secretAction] = await db.insert(agentActions).values({
      org_id: orgB.id, user_id: victim.id, action: 'create_task',
      params: { title: 'secret task' }, approval_status: 'pending', approval_tier: 'quick', source: 'mention',
    }).returning();
    created.actionId = secretAction.id;

    // Now probe each endpoint with Maneek's JWT (org A) trying to access org B's IDs.
    // Each MUST return 4xx (404 / 403) or empty results, never the secret data.

    // CT.1 — /api/inbox does NOT include the victim's notification or action
    const inbox = await api<{ items: Array<{ id: string }> }>('/api/inbox?limit=100', jwt);
    const items = inbox.body?.items ?? [];
    const leakedNotif = items.find((it) => it.id === `notif:${secretNotif.id}`);
    const leakedAction = items.find((it) => it.id === `approval:${secretAction.id}`);
    if (leakedNotif || leakedAction) {
      record({ flow: 'CT', id: '1', severity: 'P0', title: 'Cross-tenant leak in /api/inbox', detail: `notif=${!!leakedNotif} action=${!!leakedAction}` });
    } else {
      record({ flow: 'CT', id: '1', severity: 'OK', title: '/api/inbox does not leak cross-org notif/action' });
    }

    // CT.2 — POST /api/inbox/read with the victim's notif id should be a no-op
    //        (the route filters by user_id + org_id, so the update should affect 0 rows)
    const markRes = await api<{ updated?: number }>('/api/inbox/read', jwt, {
      method: 'POST', body: JSON.stringify({ ids: [`notif:${secretNotif.id}`] }),
    });
    const stillUnread = await db.select({ is_read: notifications.is_read })
      .from(notifications).where(eq(notifications.id, secretNotif.id)).limit(1);
    if (stillUnread[0]?.is_read === true) {
      record({ flow: 'CT', id: '2', severity: 'P0', title: 'Cross-tenant: POST /inbox/read flipped victim notif', detail: `updated=${markRes.body?.updated}` });
    } else {
      record({ flow: 'CT', id: '2', severity: 'OK', title: '/inbox/read scoped to current user', detail: `victim notif untouched, updated=${markRes.body?.updated ?? 0}` });
    }

    // CT.3 — GET /api/spaces/:id with the victim's space id should 404
    const spaceRes = await api<{ id?: string }>(`/api/spaces/${secretSpace.id}`, jwt);
    if (spaceRes.status === 200 && spaceRes.body?.id === secretSpace.id) {
      record({ flow: 'CT', id: '3', severity: 'P0', title: 'Cross-tenant leak: GET /api/spaces/:id returned victim space', detail: `status=${spaceRes.status}` });
    } else {
      record({ flow: 'CT', id: '3', severity: 'OK', title: 'Cross-org space lookup blocked', detail: `status=${spaceRes.status}` });
    }

    // CT.4 — GET /api/spaces/:id/members should 404 / 403
    const memRes = await api<unknown>(`/api/spaces/${secretSpace.id}/members`, jwt);
    if (memRes.status === 200) {
      record({ flow: 'CT', id: '4', severity: 'P0', title: 'Cross-tenant leak: members of victim space', detail: `status=${memRes.status}` });
    } else {
      record({ flow: 'CT', id: '4', severity: 'OK', title: 'Cross-org members lookup blocked', detail: `status=${memRes.status}` });
    }

    // CT.5 — POST /api/spaces/:id/members trying to add Maneek to the victim's space
    const addRes = await api<unknown>(`/api/spaces/${secretSpace.id}/members`, jwt, {
      method: 'POST', body: JSON.stringify({ user_id: attackerUserId }),
    });
    if (addRes.status === 200 || addRes.status === 201) {
      // Check if the row was actually inserted
      const inserted = await db.select({ id: spaceMembers.id }).from(spaceMembers)
        .where(and(eq(spaceMembers.space_id, secretSpace.id), eq(spaceMembers.user_id, attackerUserId)));
      if (inserted.length > 0) {
        record({ flow: 'CT', id: '5', severity: 'P0', title: 'Cross-tenant: attacker added themselves to victim space', detail: `status=${addRes.status}` });
        await db.delete(spaceMembers).where(eq(spaceMembers.id, inserted[0].id));
      } else {
        record({ flow: 'CT', id: '5', severity: 'OK', title: 'Cross-org member-add returned ok but no row inserted', detail: `status=${addRes.status}` });
      }
    } else {
      record({ flow: 'CT', id: '5', severity: 'OK', title: 'Cross-org member-add blocked', detail: `status=${addRes.status}` });
    }

    // CT.6 — GET /api/messages/:spaceId
    const msgListRes = await api<unknown>(`/api/messages/${secretSpace.id}`, jwt);
    if (msgListRes.status === 200) {
      const arr = Array.isArray(msgListRes.body) ? msgListRes.body : [];
      const leaked = arr.find((m: { content?: string }) => m.content === 'TOP SECRET');
      if (leaked) {
        record({ flow: 'CT', id: '6', severity: 'P0', title: 'Cross-tenant leak: TOP SECRET visible via /api/messages/:id', detail: `arr.len=${arr.length}` });
      } else {
        record({ flow: 'CT', id: '6', severity: 'P1', title: 'Cross-org messages list returned 200 (expected 4xx)', detail: `len=${arr.length}` });
      }
    } else {
      record({ flow: 'CT', id: '6', severity: 'OK', title: 'Cross-org messages lookup blocked', detail: `status=${msgListRes.status}` });
    }

    // CT.7 — POST /api/messages/:spaceId trying to inject a message into the victim's space
    const injectRes = await api<unknown>(`/api/messages/${secretSpace.id}`, jwt, {
      method: 'POST', body: JSON.stringify({ content: 'INJECTED' }),
    });
    if (injectRes.status === 200 || injectRes.status === 201) {
      const inj = await db.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.space_id, secretSpace.id), eq(messages.content, 'INJECTED')));
      if (inj.length > 0) {
        record({ flow: 'CT', id: '7', severity: 'P0', title: 'Cross-tenant: attacker posted message into victim space', detail: `status=${injectRes.status}` });
        await db.delete(messages).where(eq(messages.id, inj[0].id));
      } else {
        record({ flow: 'CT', id: '7', severity: 'OK', title: 'Cross-org message-inject returned ok but no row', detail: `status=${injectRes.status}` });
      }
    } else {
      record({ flow: 'CT', id: '7', severity: 'OK', title: 'Cross-org message inject blocked', detail: `status=${injectRes.status}` });
    }

    // CT.8 — GET /api/agent/actions/pending should not include the victim's action
    const pendingRes = await api<{ actions: Array<{ id: string }> } | Array<{ id: string }>>('/api/agent/actions/pending', jwt);
    const pendingArr = Array.isArray(pendingRes.body)
      ? pendingRes.body
      : pendingRes.body.actions ?? [];
    if (pendingArr.find((a) => a.id === secretAction.id)) {
      record({ flow: 'CT', id: '8', severity: 'P0', title: 'Cross-tenant leak: victim action visible in /api/agent/actions/pending' });
    } else {
      record({ flow: 'CT', id: '8', severity: 'OK', title: 'Cross-org actions list does not leak' });
    }

    // CT.9 — POST /api/agent/actions/:id/approve with victim action id
    const approveRes = await api<unknown>(`/api/agent/actions/${secretAction.id}/approve`, jwt, {
      method: 'POST', body: JSON.stringify({}),
    });
    if (approveRes.status === 200) {
      const [actionAfter] = await db.select({ approval_status: agentActions.approval_status }).from(agentActions).where(eq(agentActions.id, secretAction.id));
      if (actionAfter?.approval_status === 'approved' || actionAfter?.approval_status === 'executed') {
        record({ flow: 'CT', id: '9', severity: 'P0', title: 'Cross-tenant: attacker APPROVED victim agent action', detail: `status_now=${actionAfter.approval_status}` });
      } else {
        record({ flow: 'CT', id: '9', severity: 'P1', title: 'Cross-org approve returned 200 but didn\'t mutate', detail: `status=${approveRes.status}` });
      }
    } else {
      record({ flow: 'CT', id: '9', severity: 'OK', title: 'Cross-org approve blocked', detail: `status=${approveRes.status}` });
    }

    // CT.10 — POST /api/agent/actions/:id/reject with victim action id
    const rejectRes = await api<unknown>(`/api/agent/actions/${secretAction.id}/reject`, jwt, {
      method: 'POST', body: JSON.stringify({}),
    });
    if (rejectRes.status === 200) {
      const [actionAfter] = await db.select({ approval_status: agentActions.approval_status }).from(agentActions).where(eq(agentActions.id, secretAction.id));
      if (actionAfter?.approval_status === 'rejected') {
        record({ flow: 'CT', id: '10', severity: 'P0', title: 'Cross-tenant: attacker REJECTED victim agent action' });
      } else {
        record({ flow: 'CT', id: '10', severity: 'P1', title: 'Cross-org reject returned 200 but didn\'t mutate' });
      }
    } else {
      record({ flow: 'CT', id: '10', severity: 'OK', title: 'Cross-org reject blocked', detail: `status=${rejectRes.status}` });
    }

    // CT.11 — GET /api/members must not include the victim user
    const orgMembersRes = await api<Array<{ id: string }>>('/api/members', jwt);
    const orgMembersArr = Array.isArray(orgMembersRes.body) ? orgMembersRes.body : [];
    if (orgMembersArr.find((m) => m.id === victim.id)) {
      record({ flow: 'CT', id: '11', severity: 'P0', title: 'Cross-tenant leak: victim user in /api/members' });
    } else {
      record({ flow: 'CT', id: '11', severity: 'OK', title: 'Cross-org user list scoped to attacker org' });
    }

    // CT.12 — GET /api/members/:id with victim id should 404
    const userRes = await api<{ id?: string }>(`/api/members/${victim.id}`, jwt);
    if (userRes.status === 200 && userRes.body?.id === victim.id) {
      record({ flow: 'CT', id: '12', severity: 'P0', title: 'Cross-tenant leak: GET /api/members/:id returned victim profile' });
    } else {
      record({ flow: 'CT', id: '12', severity: 'OK', title: 'Cross-org user profile lookup blocked', detail: `status=${userRes.status}` });
    }
  } finally {
    // Cleanup org B
    if (created.actionId) await db.delete(agentActions).where(eq(agentActions.id, created.actionId)).catch(() => {});
    if (created.notifId) await db.delete(notifications).where(eq(notifications.id, created.notifId)).catch(() => {});
    if (created.messageId) await db.delete(messages).where(eq(messages.id, created.messageId)).catch(() => {});
    if (created.spaceId) {
      await db.delete(spaceMembers).where(eq(spaceMembers.space_id, created.spaceId)).catch(() => {});
      await db.delete(spaces).where(eq(spaces.id, created.spaceId)).catch(() => {});
    }
    if (created.userIds.length) {
      await db.delete(orgMembers).where(inArray(orgMembers.user_id, created.userIds)).catch(() => {});
      await db.delete(users).where(inArray(users.id, created.userIds)).catch(() => {});
    }
    if (created.orgId) await db.delete(orgs).where(eq(orgs.id, created.orgId)).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────
// AR — Agent reply round-trip with rendering inspection
// ─────────────────────────────────────────────────────────────────────

async function flowAgentReply(browser: Browser, jwt: string, attackerOrgId: string, attackerUserId: string) {
  // Send a message that should produce a reply: @-mention Defty in any space.
  // The agent-reply worker fires async after the message inserts.
  const orgMembersRes = await api<Array<{ id: string; email?: string; name?: string }>>('/api/members', jwt);
  const orgArr = Array.isArray(orgMembersRes.body) ? orgMembersRes.body : [];
  const defty = orgArr.find((m) => m.email === 'deft-agent@system.local');
  if (!defty) { record({ flow: 'AR', id: '1', severity: 'SKIP', title: 'No Defty user' }); return; }

  // Find or create a Defty DM
  const spacesRes = await api<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const spacesArr = Array.isArray(spacesRes.body) ? spacesRes.body : [];
  let dmSpace: { id: string } | undefined;
  for (const s of spacesArr) {
    if (s.type !== 'dm' && s.type !== 'agent_conversation') continue;
    const m = await api<Array<{ id: string }>>(`/api/spaces/${s.id}/members`, jwt);
    const mArr = Array.isArray(m.body) ? m.body : [];
    if (mArr.find((x) => x.id === defty.id)) { dmSpace = s; break; }
  }
  if (!dmSpace) { record({ flow: 'AR', id: '1', severity: 'SKIP', title: 'No existing Defty DM/agent_conversation space' }); return; }

  // Snapshot the current latest agent-authored message id so we can detect a NEW one.
  const beforeMsgs = await db.select({ id: messages.id, created_at: messages.created_at })
    .from(messages)
    .where(and(eq(messages.space_id, dmSpace.id), eq(messages.user_id, defty.id), eq(messages.is_deleted, false)))
    .orderBy(desc(messages.created_at))
    .limit(1);
  const lastBefore = beforeMsgs[0]?.created_at ?? new Date(0);

  // Send a question via API. Use a marker so we can match.
  const markerId = `r2-ar-${Date.now()}`;
  const sendRes = await api<{ id: string }>(`/api/messages/${dmSpace.id}`, jwt, {
    method: 'POST',
    body: JSON.stringify({ content: `@${defty.name} reply with the word "pong" only. Marker: ${markerId}` }),
  });
  if (sendRes.status !== 200 && sendRes.status !== 201) {
    record({ flow: 'AR', id: '1', severity: 'P1', title: `Could not send mention message`, detail: `status=${sendRes.status}` });
    return;
  }
  const userMsgId = sendRes.body.id;

  // Poll for a Defty message newer than lastBefore. Up to 60s.
  const pollStart = Date.now();
  let agentMsg: { id: string; metadata: unknown; user_id: string; content: string } | null = null;
  for (let i = 0; i < 60; i++) {
    const candidates = await db.select({ id: messages.id, metadata: messages.metadata, user_id: messages.user_id, content: messages.content })
      .from(messages)
      .where(and(
        eq(messages.space_id, dmSpace.id),
        eq(messages.user_id, defty.id),
        eq(messages.is_deleted, false),
        gt(messages.created_at, lastBefore),
      ))
      .orderBy(desc(messages.created_at))
      .limit(5);
    // Find a candidate whose metadata includes agent_blocks (Phase 2 invariant).
    const m = candidates.find((c) => {
      const md = c.metadata as { agent_blocks?: unknown[]; kind?: string } | null;
      return md && Array.isArray(md.agent_blocks) && md.kind !== 'tool_result';
    });
    if (m) { agentMsg = m as typeof agentMsg; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const lag = Date.now() - pollStart;

  if (!agentMsg) {
    record({ flow: 'AR', id: '1', severity: 'P1', title: `No Defty reply within 60s`, detail: `userMsgId=${userMsgId} marker=${markerId}` });
    return;
  }
  const sev: Severity = lag > 30_000 ? 'P2' : 'OK';
  record({ flow: 'AR', id: '1', severity: sev, title: `Defty replied in ${lag}ms with agent_blocks`, detail: `msg=${agentMsg.id}` });

  // AR.2 — agent reply has model + tokens metadata
  const md = agentMsg.metadata as { model?: string; tokens_in?: number; tokens_out?: number };
  if (!md.model || md.tokens_in === undefined || md.tokens_out === undefined) {
    record({ flow: 'AR', id: '2', severity: 'P1', title: 'Agent reply metadata missing model/tokens', detail: JSON.stringify(md).slice(0, 100) });
  } else {
    record({ flow: 'AR', id: '2', severity: 'OK', title: 'Agent reply has model + tokens', detail: `model=${md.model} in=${md.tokens_in} out=${md.tokens_out}` });
  }

  // AR.3 — UI rendering: open the space in the browser and verify
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${WEB_URL}/chat?space=${dmSpace.id}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(3500);

    const bodyText = await page.locator('body').innerText();

    // AgentMessageBlocks strips "claude-" prefix and trailing date, so
    // "claude-sonnet-4-20250514" renders as "sonnet-4". Match on the
    // shortened form OR any "sonnet|opus|haiku" hint.
    const modelStr = String(md.model);
    const shortModel = modelStr.replace('claude-', '').replace(/-\d+$/, '');
    const modelVisible = bodyText.includes(shortModel) || /sonnet|opus|haiku/i.test(bodyText);
    // Token footer renders as "<n> tokens" (sum of in+out).
    const tokensVisible = /\d+\s+tokens/i.test(bodyText);

    if (!modelVisible) {
      record({ flow: 'AR', id: '3', severity: 'P1', title: 'Model name not rendered on agent message', detail: `expected token like "${shortModel}"` });
    } else if (!tokensVisible) {
      record({ flow: 'AR', id: '3', severity: 'P1', title: 'Token footer not rendered on agent message' });
    } else {
      record({ flow: 'AR', id: '3', severity: 'OK', title: 'Agent message renders model + tokens footer', detail: `model match=${shortModel}` });
    }

    // AR.4 — agent_blocks should include text content; if a tool was used, also a tool_use block.
    const blocks = (md as { agent_blocks?: Array<{ type: string }> }).agent_blocks ?? [];
    const hasText = blocks.some((b) => b.type === 'text');
    const hasTool = blocks.some((b) => b.type === 'tool_use');
    if (!hasText) {
      record({ flow: 'AR', id: '4', severity: 'P1', title: 'agent_blocks missing text content' });
    } else if (hasTool) {
      // If there was a tool_use, the rendered chat should show a tool chip.
      const toolBlocks = blocks.filter((b) => b.type === 'tool_use') as Array<{ name?: string }>;
      const toolNames = toolBlocks.map((t) => t.name).filter(Boolean);
      const anyToolNameVisible = toolNames.some((n) => bodyText.includes(String(n)));
      if (toolNames.length && !anyToolNameVisible) {
        record({ flow: 'AR', id: '4', severity: 'P2', title: 'Tool chips may not render tool names', detail: `tools=${toolNames.join(',')}` });
      } else {
        record({ flow: 'AR', id: '4', severity: 'OK', title: 'agent_blocks well-formed (text + tool_use rendered)', detail: `text=1 tool_use=${toolBlocks.length}` });
      }
    } else {
      record({ flow: 'AR', id: '4', severity: 'OK', title: 'agent_blocks well-formed (text only)' });
    }

    // AR.5 — author of the message is Defty, NOT the human (Phase 2/4 invariant)
    if (agentMsg.user_id !== defty.id) {
      record({ flow: 'AR', id: '5', severity: 'P0', title: 'Agent reply NOT authored by agent', detail: `user_id=${agentMsg.user_id} expected=${defty.id}` });
    } else {
      record({ flow: 'AR', id: '5', severity: 'OK', title: 'Agent reply authored by agent (not human)' });
    }
  } finally {
    await ctx.close();
  }
}

async function main() {
  console.log(`\n=== R2 audit — cross-tenant + agent-reply ===`);
  console.log(`api: ${API_URL}\nweb: ${WEB_URL}\n`);

  const auth = await login();
  const browser = await chromium.launch({ headless: true });

  try {
    console.log('--- CT: cross-tenant isolation ---');
    await flowCrossTenant(auth.jwt, auth.orgId, auth.userId);

    console.log('\n--- AR: agent reply round-trip ---');
    await flowAgentReply(browser, auth.jwt, auth.orgId, auth.userId);
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
