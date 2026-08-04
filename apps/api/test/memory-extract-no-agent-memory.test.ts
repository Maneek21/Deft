/**
 * memory-extract no-agentMemory integration test.
 *
 * Run: pnpm --filter @deft/api test -- memory-extract-no-agent-memory
 *
 * Verifies that handleMemoryExtract does NOT write to the agent_memory table
 * (the legacy dual-write COMPAT block has been removed), while still writing
 * to wiki_pages as expected.
 *
 * Uses a real Postgres DB (defaults to postgres://postgres:postgres@localhost:5432/deft).
 * All inserted rows are cleaned up in finally blocks.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
// Use Alex PM's real user_id — agent_memory has a FK to users.id, so we need
// a real user to avoid a FK violation that would silently suppress the dual-write.
const USER_ID = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // Alex PM
const SPACE_ID = 'test-space-no-agmem-uuid';
const MESSAGE_ID = 'msg-no-agmem-test';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ─── Fetch mock for Anthropic LLM calls ───────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

function makeFakeAnthropicResponse(jsonPayload: string) {
  const body = JSON.stringify({
    id: 'msg_test_mock_no_agmem',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: jsonPayload }],
    model: 'claude-haiku-20240307',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const requestUrl = new URL(urlStr);
    if (requestUrl.hostname === 'api.anthropic.com') {
      return (globalThis as any).__mockAnthropicResponseNoAgMem?.(urlStr, opts)
        ?? makeFakeAnthropicResponse(JSON.stringify({
          action: 'create',
          title: 'No AgentMemory Test Page',
          slug: `no-agent-mem-default-${Date.now()}`,
          type: 'fact',
          content: 'Default test content for no-agentMemory test.',
          summary: 'Default summary.',
          related_slugs: [],
        })) as unknown as Response;
    }
    throw new Error(`Unexpected fetch in memory-extract test: ${requestUrl.origin}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as any).__mockAnthropicResponseNoAgMem;
});

// ─── Import handler ───────────────────────────────────────────────────────────

let handleMemoryExtract: (job: { id: string; name: string; data: unknown }) => Promise<void>;

before(async () => {
  const mod = await import('../src/workers/handlers/memory-extract.js');
  handleMemoryExtract = mod.handleMemoryExtract as any;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function countAgentMemoryRows(orgId: string, userId: string): Promise<number> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT COUNT(*)::int AS cnt FROM agent_memory WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    return r.rows[0].cnt as number;
  });
}

async function cleanupTest(slugPrefix: string) {
  await withClient(async (c) => {
    // Remove wiki rows created by the test
    const pages = await c.query(
      `SELECT id FROM wiki_pages WHERE org_id = $1 AND slug LIKE $2`,
      [ORG_ID, `${slugPrefix}%`],
    );
    const ids: string[] = pages.rows.map((r: any) => r.id);
    if (ids.length) {
      await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [ids]);
      await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [ids]);
      await c.query(`DELETE FROM wiki_ops_log WHERE page_id = ANY($1)`, [ids]);
      await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [ids]);
      // Also clean up any embed jobs
      for (const id of ids) {
        await c.query(
          `DELETE FROM job_queue WHERE name = 'embed-content' AND data->>'source_id' = $1`,
          [id],
        );
      }
    }
    // Clean up any decision-typed wiki_pages created from this message
    // (legacy `decisions` table was retired 2026-05-12; decisions now live on
    // wiki_pages where type='decision', linked to messages via wiki_citations).
    const decisionPages = await c.query(
      `SELECT wp.id
         FROM wiki_pages wp
         JOIN wiki_citations wc ON wc.page_id = wp.id
        WHERE wp.org_id = $1
          AND wp.type = 'decision'
          AND wc.source_type = 'message'
          AND wc.source_id = $2`,
      [ORG_ID, MESSAGE_ID],
    );
    const decisionIds: string[] = decisionPages.rows.map((r: any) => r.id);
    if (decisionIds.length) {
      await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [decisionIds]);
      await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [decisionIds]);
      await c.query(`DELETE FROM wiki_ops_log WHERE page_id = ANY($1)`, [decisionIds]);
      await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [decisionIds]);
    }
    // Remove any stray agent_memory rows for the test user (should be zero, but clean anyway)
    await c.query(
      `DELETE FROM agent_memory WHERE org_id = $1 AND user_id = $2`,
      [ORG_ID, userId],
    );
  });
}

// userId alias for cleanup helper (uses outer USER_ID)
const userId = USER_ID;

// ─── Tests ────────────────────────────────────────────────────────────────────

test('handleMemoryExtract does NOT write to agent_memory', async () => {
  const slug = `no-agent-mem-test-${Date.now()}`;

  (globalThis as any).__mockAnthropicResponseNoAgMem = () =>
    makeFakeAnthropicResponse(JSON.stringify({
      action: 'create',
      title: 'No AgentMemory Fact Page',
      slug,
      type: 'fact',
      content: 'Test fact: the team decided to skip standups on Fridays.',
      summary: 'No standups on Fridays.',
      related_slugs: [],
    })) as unknown as Response;

  const countBefore = await countAgentMemoryRows(ORG_ID, USER_ID);

  try {
    await handleMemoryExtract({
      id: 'job-no-agmem-test',
      name: 'memory-extract',
      data: {
        messageId: MESSAGE_ID,
        spaceId: SPACE_ID,
        content: 'The team decided to skip standups on Fridays.',
        orgId: ORG_ID,
        userId: USER_ID,
        facts: ['Test fact: the team decided to skip standups on Fridays.'],
        decision: null,
      },
    });

    const countAfter = await countAgentMemoryRows(ORG_ID, USER_ID);

    assert.equal(
      countAfter,
      countBefore,
      `agent_memory should have ${countBefore} rows (unchanged) after handleMemoryExtract, but got ${countAfter}`,
    );
  } finally {
    delete (globalThis as any).__mockAnthropicResponseNoAgMem;
    await cleanupTest('no-agent-mem-test-');
  }
});

test('handleMemoryExtract still writes to wiki_pages after removing dual-write', async () => {
  const slug = `no-agent-mem-wiki-check-${Date.now()}`;

  (globalThis as any).__mockAnthropicResponseNoAgMem = () =>
    makeFakeAnthropicResponse(JSON.stringify({
      action: 'create',
      title: 'Wiki Check Page',
      slug,
      type: 'fact',
      content: 'Wiki write is still working after removing dual-write.',
      summary: 'Wiki write check.',
      related_slugs: [],
    })) as unknown as Response;

  try {
    await handleMemoryExtract({
      id: 'job-no-agmem-wiki-check',
      name: 'memory-extract',
      data: {
        messageId: `${MESSAGE_ID}-wiki-check`,
        spaceId: SPACE_ID,
        content: 'Wiki write should still work after dual-write removal.',
        orgId: ORG_ID,
        userId: USER_ID,
        facts: ['Wiki write is still working after removing dual-write.'],
        decision: null,
      },
    });

    const pageId = await withClient(async (c) => {
      const r = await c.query(
        `SELECT id FROM wiki_pages WHERE org_id = $1 AND slug = $2 LIMIT 1`,
        [ORG_ID, slug],
      );
      return r.rows[0]?.id ?? null;
    });

    assert.ok(pageId, `wiki_pages should have a new row with slug "${slug}" after handleMemoryExtract`);
  } finally {
    delete (globalThis as any).__mockAnthropicResponseNoAgMem;
    await cleanupTest('no-agent-mem-wiki-check-');
    // Also clean up any decision-typed wiki_pages cited from the wiki-check message
    await withClient(async (c) => {
      const r = await c.query(
        `SELECT wp.id
           FROM wiki_pages wp
           JOIN wiki_citations wc ON wc.page_id = wp.id
          WHERE wp.org_id = $1
            AND wp.type = 'decision'
            AND wc.source_type = 'message'
            AND wc.source_id = $2`,
        [ORG_ID, `${MESSAGE_ID}-wiki-check`],
      );
      const ids: string[] = r.rows.map((row: any) => row.id);
      if (ids.length) {
        await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [ids]);
        await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [ids]);
        await c.query(`DELETE FROM wiki_ops_log WHERE page_id = ANY($1)`, [ids]);
        await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [ids]);
      }
    });
  }
});
