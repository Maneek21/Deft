/**
 * Task 1.3 — agent.ts wiki auto-load uses retrieveContext gateway.
 *
 * Run: pnpm --filter @deft/api test -- agent-context-retrieve-context
 *
 * Integration test: seeds wiki pages, seeds a minimal conversation, calls the
 * buildStreamContext-adjacent logic by verifying the system prompt produced
 * by the agent route includes the expected wiki content pulled via
 * retrieveContext.
 *
 * Strategy: rather than calling buildStreamContext directly (it requires a full
 * Hono context and live Anthropic key), we verify the contract at the
 * retrieveContext layer — that the gateway correctly returns wiki pages for a
 * known query, which is what agent.ts now delegates to. We then add a
 * smoke-level check that the agent.ts module no longer contains the inline
 * two-tier SQL queries.
 *
 * Covers:
 *   1. retrieveContext with types:['wiki'] returns wiki pages for a seeded query
 *   2. Two-tier: employee-tagged pages appear in results alongside org-wide pages
 *   3. Empty result set when query has no matches (no wiki section crash)
 *   4. agent.ts no longer contains the inline tier-1/tier-2 SQL blocks
 *      (structural check — fails before the refactor, passes after)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import pg from 'pg';
import { retrieveContext } from '../src/lib/retrieve-context.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'agent-ctx-rc-test-user';
const USER_EMAIL = 'agent-ctx-rc-test@test.local';
const AGENT_EMPLOYEE_ID = `agent-ctx-rc-emp-${Date.now()}`;

const seededIds: { table: string; id: string }[] = [];

// Unique term so only our seeded pages match — no interference from existing data.
const QUERY_TERM = `xyzagentrctest${Date.now()}`;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Agent RC Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    // Agent employee row so FK on wiki_pages is satisfied.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'RC Agent Emp', $4, 'custom', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_EMPLOYEE_ID, ORG_ID, USER_ID, `agent-rc-emp-slug-${Date.now()}`],
    );
    seededIds.push({ table: 'agent_employees', id: AGENT_EMPLOYEE_ID });

    // Employee-tagged wiki page.
    const empPageId = `agent-rc-emp-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, agent_employee_id, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'user', $3, $4, $5, 1.0, $6, false, NOW(), NOW())`,
      [
        empPageId,
        ORG_ID,
        `Employee ${QUERY_TERM} Handbook`,
        `emp-rc-handbook-${Date.now()}`,
        `The ${QUERY_TERM} employee handbook describes onboarding procedures.`,
        AGENT_EMPLOYEE_ID,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: empPageId });

    // Org-wide wiki page (no agent_employee_id).
    const orgPageId = `agent-rc-org-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5, 1.0, false, NOW(), NOW())`,
      [
        orgPageId,
        ORG_ID,
        `Org ${QUERY_TERM} Overview`,
        `org-rc-overview-${Date.now()}`,
        `The ${QUERY_TERM} overview applies across the organisation.`,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: orgPageId });
  });
});

after(async () => {
  await withClient(async (c) => {
    for (const { table, id } of [...seededIds].reverse()) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Task 1.3 — agent wiki auto-load via retrieveContext', () => {
  test('1. retrieveContext with types:[wiki] returns seeded pages for unique query', async () => {
    const results = await retrieveContext({
      query: QUERY_TERM,
      org_id: ORG_ID,
      types: ['wiki'],
      limit: 5,
      hybrid: false,
    });

    assert.ok(results.length >= 1, `Expected at least 1 result, got ${results.length}`);
    for (const r of results) {
      assert.equal(r.source_type, 'wiki_page', `source_type should be wiki_page, got ${r.source_type}`);
      assert.ok(r.title.includes(QUERY_TERM), `title should include query term: ${r.title}`);
    }
  });

  test('2. two-tier: employee page appears when agent_employee_id provided', async () => {
    const results = await retrieveContext({
      query: QUERY_TERM,
      org_id: ORG_ID,
      agent_employee_id: AGENT_EMPLOYEE_ID,
      types: ['wiki'],
      limit: 5,
      hybrid: false,
    });

    assert.ok(results.length >= 2, `Expected at least 2 results (emp+org), got ${results.length}`);

    const empResult = results.find(r => r.metadata?.tier === 'employee');
    const orgResult = results.find(r => r.metadata?.tier === 'org');
    assert.ok(empResult, 'Should have an employee-tier wiki page result');
    assert.ok(orgResult, 'Should have an org-tier wiki page result');

    // Employee tier gets score boost (+0.1) so it should rank at or near top.
    assert.ok(
      empResult!.score >= orgResult!.score,
      `Employee page score (${empResult!.score}) should be >= org page score (${orgResult!.score})`,
    );
  });

  test('3. empty result when query has no matches — no crash', async () => {
    const results = await retrieveContext({
      query: 'zzznosuchtermexistsinthewiki99999',
      org_id: ORG_ID,
      types: ['wiki'],
      limit: 5,
      hybrid: false,
    });

    // No match is fine — should return empty array, not throw.
    assert.ok(Array.isArray(results), 'Should return an array');
    // We cannot assert length === 0 since other wiki pages might incidentally
    // match, but the gateway must not throw.
  });

  test('4. agent.ts no longer contains inline tier-1/tier-2 SQL wiki queries', () => {
    const __filename = fileURLToPath(import.meta.url);
    const agentPath = join(dirname(__filename), '../src/routes/agent.ts');
    const src = readFileSync(agentPath, 'utf8');

    // The old tier-1 block fetched employeePages with a ts_rank + agent_employee_id filter.
    // After refactor these direct SQL calls must be gone.
    assert.ok(
      !src.includes('employeePages'),
      'agent.ts should not contain inline "employeePages" SQL query after refactor',
    );
    assert.ok(
      !src.includes('orgWidePages'),
      'agent.ts should not contain inline "orgWidePages" SQL query after refactor',
    );
    assert.ok(
      !src.includes('allRelevantPages'),
      'agent.ts should not contain inline "allRelevantPages" array after refactor',
    );

    // The gateway call should be present.
    assert.ok(
      src.includes('retrieveContext'),
      'agent.ts should call retrieveContext after refactor',
    );
  });
});
