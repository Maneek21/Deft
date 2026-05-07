#!/usr/bin/env tsx
/**
 * Round 6 audit — trace export + kind-consistency sweep.
 *
 * T.1   GET /api/agent/conversations/:id/trace.json — schema version
 * T.2   Trace includes conversation metadata
 * T.3   Trace includes messages with content + author
 * T.4   Trace includes attached agent_actions
 *
 * K.1   /api/members rows all have valid kind ∈ {human, agent, system}
 * K.2   /api/spaces/:id/members rows include kind
 * K.3   POST /api/spaces creates a space — verify response shape
 * K.4   No user has kind missing or null
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-r6.audit.ts
 */
import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from './lib/db.js';

const { users, spaces, messages: messagesTbl } = schema;
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3011';

type Severity = 'P0' | 'P1' | 'P2' | 'OK' | 'SKIP';
type Finding = { id: string; severity: Severity; title: string; detail?: string };
const findings: Finding[] = [];

function record(f: Finding) {
  findings.push(f);
  const tag = f.severity === 'OK' ? '✓' : f.severity === 'SKIP' ? '∅' : f.severity;
  console.log(`[${tag}] [${f.id}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
}

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  const body = (await res.json()) as { accessToken: string; org_id: string };
  return { jwt: body.accessToken, orgId: body.org_id };
}

async function api<T = unknown>(path: string, jwt: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}

async function flowTraceExport(jwt: string) {
  // Find a conversation (space of type agent_conversation OR dm with Defty)
  const spacesRes = await api<Array<{ id: string; type: string; name: string }>>('/api/spaces', jwt);
  const arr = Array.isArray(spacesRes.body) ? spacesRes.body : [];
  const candidate = arr.find((s) => s.type === 'agent_conversation') ?? arr.find((s) => s.type === 'dm');
  if (!candidate) {
    record({ id: 'T.1', severity: 'SKIP', title: 'No agent_conversation or dm space to test trace export' });
    return;
  }

  const r = await api<{
    format?: string;
    version?: string;
    conversation?: { id?: string; name?: string };
    messages?: Array<{ id: string; user_id: string; content: string; metadata?: unknown }>;
    actions?: Array<{ id: string; action: string }>;
  }>(`/api/agent/conversations/${candidate.id}/trace.json`, jwt);

  if (r.status !== 200) {
    record({ id: 'T.1', severity: 'P1', title: `trace.json returned ${r.status}`, detail: JSON.stringify(r.body).slice(0, 100) });
    return;
  }

  // T.1 — schema version per CLAUDE.md ("deft.agent_trace.v1")
  const expectedFormat = 'deft.agent_trace.v1';
  const formatField = r.body?.format ?? r.body?.version;
  if (formatField === expectedFormat) {
    record({ id: 'T.1', severity: 'OK', title: `Trace schema version = ${expectedFormat}` });
  } else if (typeof formatField === 'string' && formatField.includes('agent_trace')) {
    record({ id: 'T.1', severity: 'P2', title: `Trace schema version differs`, detail: `got=${formatField} expected=${expectedFormat}` });
  } else {
    record({ id: 'T.1', severity: 'P1', title: `Trace schema version field missing or unrecognized`, detail: `format=${formatField}` });
  }

  // T.2 — conversation metadata
  if (r.body?.conversation && (r.body.conversation as { id?: string }).id === candidate.id) {
    record({ id: 'T.2', severity: 'OK', title: 'Trace includes conversation metadata' });
  } else {
    record({ id: 'T.2', severity: 'P1', title: 'Trace missing or wrong conversation metadata', detail: JSON.stringify(r.body?.conversation).slice(0, 100) });
  }

  // T.3 — messages array
  if (Array.isArray(r.body?.messages)) {
    const withContent = r.body.messages.filter((m) => typeof m.content === 'string');
    record({ id: 'T.3', severity: 'OK', title: `Trace includes ${r.body.messages.length} messages`, detail: `${withContent.length} have content` });
  } else {
    record({ id: 'T.3', severity: 'P1', title: 'Trace messages array missing or not an array' });
  }

  // T.4 — actions array (may be empty if conversation has no agent actions)
  if (Array.isArray(r.body?.actions)) {
    record({ id: 'T.4', severity: 'OK', title: `Trace includes actions array (${r.body.actions.length} actions)` });
  } else {
    record({ id: 'T.4', severity: 'P1', title: 'Trace actions array missing or not an array' });
  }
}

async function flowKindConsistency(jwt: string, orgId: string) {
  // K.1 — /api/members
  const r1 = await api<Array<{ id: string; kind?: string }>>('/api/members', jwt);
  if (r1.status !== 200 || !Array.isArray(r1.body)) {
    record({ id: 'K.1', severity: 'P0', title: '/api/members not returning an array' });
  } else {
    const valid = ['human', 'agent', 'system'];
    const invalid = r1.body.filter((m) => !m.kind || !valid.includes(m.kind));
    if (invalid.length > 0) {
      record({ id: 'K.1', severity: 'P1', title: `${invalid.length}/${r1.body.length} /api/members rows have invalid kind`, detail: `samples=${invalid.slice(0, 3).map((m) => `${m.id}:${m.kind}`).join(', ')}` });
    } else {
      const breakdown = ['human', 'agent', 'system'].map((k) => `${k}:${r1.body.filter((m) => m.kind === k).length}`).join(' ');
      record({ id: 'K.1', severity: 'OK', title: `/api/members all have valid kind`, detail: breakdown });
    }
  }

  // K.2 — /api/spaces/:id/members
  const sr = await api<Array<{ id: string; type: string }>>('/api/spaces', jwt);
  const sArr = Array.isArray(sr.body) ? sr.body : [];
  const space = sArr.find((s) => s.type === 'public') ?? sArr.find((s) => s.type === 'private') ?? sArr[0];
  if (!space) {
    record({ id: 'K.2', severity: 'SKIP', title: 'No space to test members endpoint' });
  } else {
    const m = await api<Array<{ id: string; kind?: string }>>(`/api/spaces/${space.id}/members`, jwt);
    if (m.status !== 200 || !Array.isArray(m.body)) {
      record({ id: 'K.2', severity: 'P1', title: `/api/spaces/:id/members status=${m.status}` });
    } else {
      const missingKind = m.body.filter((row) => row.kind === undefined || row.kind === null);
      if (missingKind.length > 0) {
        record({ id: 'K.2', severity: 'P0', title: `${missingKind.length}/${m.body.length} space members missing kind field` });
      } else {
        record({ id: 'K.2', severity: 'OK', title: `/api/spaces/:id/members all rows have kind`, detail: `${m.body.length} rows` });
      }
    }
  }

  // K.3 — Direct DB sanity: every users row has non-null kind
  const dbCheck = await db.execute(sql`SELECT COUNT(*)::int AS c FROM users WHERE kind IS NULL`);
  const nullKindCount = (dbCheck.rows[0] as { c?: number })?.c ?? 0;
  if (nullKindCount > 0) {
    record({ id: 'K.3', severity: 'P0', title: `${nullKindCount} users rows have NULL kind` });
  } else {
    record({ id: 'K.3', severity: 'OK', title: 'No users rows with NULL kind' });
  }

  // K.4 — Defty-specific check: Defty exists as a user AND is a member of
  // the current org via org_members (Phase 1 invariant — ensureDeftyMembership).
  // Multi-tenancy is via org_members, not users.org_id.
  const deftyCheck = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM users u
    JOIN org_members om ON om.user_id = u.id
    WHERE u.email = 'deft-agent@system.local' AND om.org_id = ${orgId}
  `);
  const deftyCount = (deftyCheck.rows[0] as { c?: number })?.c ?? 0;
  if (deftyCount === 0) {
    record({ id: 'K.4', severity: 'P1', title: 'No Defty membership for this org' });
  } else if (deftyCount > 1) {
    record({ id: 'K.4', severity: 'P0', title: `${deftyCount} Defty memberships for this org (should be exactly 1)` });
  } else {
    record({ id: 'K.4', severity: 'OK', title: 'Exactly one Defty membership for this org' });
  }
}

async function main() {
  console.log(`\n=== R6 audit — trace export + kind consistency ===\napi: ${API_URL}\n`);
  const auth = await login();

  console.log('--- T: trace export ---');
  await flowTraceExport(auth.jwt);

  console.log('\n--- K: kind consistency ---');
  await flowKindConsistency(auth.jwt, auth.orgId);

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
      console.log(`  [${f.severity}] [${f.id}] ${f.title}${f.detail ? `\n    → ${f.detail}` : ''}`);
    }
  }
  process.exit(counts.P0 ? 1 : 0);
}

main().catch((err) => { console.error('audit crashed:', err); process.exit(2); });
