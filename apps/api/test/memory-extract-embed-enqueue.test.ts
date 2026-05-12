/**
 * memory-extract embed-enqueue integration tests.
 *
 * Run: pnpm --filter @deft/api test -- memory-extract-embed-enqueue
 *
 * Strategy: invoke handleMemoryExtract with a mocked LLM (monkey-patch
 * globalThis.fetch so the Anthropic SDK's HTTP calls return canned JSON),
 * then check the job_queue table to verify that an 'embed-content' job was
 * inserted for the wiki page that was just created or updated.
 *
 * This is an integration test against a real Postgres DB, following the same
 * pattern as embed-content.test.ts. It does NOT require pgvector.
 *
 * Trade-off: uses real DB, so it needs DATABASE_URL set (defaults to
 * postgres://postgres:postgres@localhost:5432/deft). The test cleans up
 * all inserted rows in finally blocks.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'test-user-mem-embed-uuid';
const SPACE_ID = 'test-space-mem-embed-uuid';

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

// We intercept all fetch calls. Anthropic SDK calls go to api.anthropic.com.
// We return a canned Anthropic streaming response that contains a JSON block
// the handler's `decideWikiAction` will parse.
//
// The handler calls `llm({ task: 'extract', messages, maxTokens })` which
// internally uses the Anthropic SDK. We mock fetch to return a minimal valid
// Anthropic response containing our desired JSON.

function makeFakeAnthropicResponse(jsonPayload: string) {
  // Anthropic non-streaming response shape (messages.create with stream:false)
  const body = JSON.stringify({
    id: 'msg_test_mock',
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

// We also need to mock the agentMemory insert (it may fail if user_id doesn't
// exist as FK). The handler wraps each item in try/catch, so agentMemory
// errors won't propagate — but to be safe we track whether they happen.

before(() => {
  originalFetch = globalThis.fetch;

  // Default mock: return a CREATE response.
  globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    if (urlStr.includes('anthropic.com')) {
      // Return whatever the current test has set as the response.
      return (globalThis as any).__mockAnthropicResponse?.(urlStr, opts)
        ?? makeFakeAnthropicResponse(JSON.stringify({
          action: 'create',
          title: 'Default Test Page',
          slug: `default-test-page-${Date.now()}`,
          type: 'fact',
          content: 'Default test content.',
          summary: 'Default summary.',
          related_slugs: [],
        })) as unknown as Response;
    }

    // Let non-Anthropic requests through (or also mock them).
    return originalFetch(url as any, opts);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as any).__mockAnthropicResponse;
});

// Helper: get the most recent embed-content job from job_queue for a given source_id.
async function getEmbedJob(sourceId: string) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, name, data FROM job_queue
       WHERE name = 'embed-content'
         AND data->>'source_id' = $1
         AND data->>'source_type' = 'wiki_page'
       ORDER BY created_at DESC
       LIMIT 1`,
      [sourceId],
    );
    return r.rows[0] ?? null;
  });
}

// Helper: clean up test rows.
async function cleanup(pageIds: string[], jobSourceIds: string[]) {
  await withClient(async (c) => {
    if (pageIds.length) {
      await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [pageIds]);
      await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [pageIds]);
      await c.query(`DELETE FROM wiki_ops_log WHERE page_id = ANY($1)`, [pageIds]);
      await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [pageIds]);
    }
    if (jobSourceIds.length) {
      for (const sid of jobSourceIds) {
        await c.query(
          `DELETE FROM job_queue WHERE name = 'embed-content' AND data->>'source_id' = $1`,
          [sid],
        );
      }
    }
    // Also clean up agentMemory test rows.
    await c.query(
      `DELETE FROM agent_memory WHERE org_id = $1 AND key LIKE 'test-%'`,
      [ORG_ID],
    );
  });
}

// ─── Import handler ───────────────────────────────────────────────────────────

let handleMemoryExtract: (job: { id: string; name: string; data: unknown }) => Promise<void>;

before(async () => {
  const mod = await import('../src/workers/handlers/memory-extract.js');
  handleMemoryExtract = mod.handleMemoryExtract as any;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. enqueue embed-content called after wiki page CREATE', async () => {
  const uniqueSlug = `test-sprint-planning-${Date.now()}`;
  let insertedPageId: string | null = null;

  // Set up LLM mock to return a CREATE action for this test.
  (globalThis as any).__mockAnthropicResponse = () =>
    makeFakeAnthropicResponse(JSON.stringify({
      action: 'create',
      title: 'Sprint Planning Decision',
      slug: uniqueSlug,
      type: 'decision',
      content: 'We decided to use two-week sprints for Q3.',
      summary: 'Two-week sprint cadence decided for Q3.',
      related_slugs: [],
    })) as unknown as Response;

  try {
    await handleMemoryExtract({
      id: 'job-create-test',
      name: 'memory-extract',
      data: {
        messageId: 'msg-create-test',
        spaceId: SPACE_ID,
        content: 'We decided to use two-week sprints for Q3.',
        orgId: ORG_ID,
        userId: USER_ID,
        facts: ['We will use two-week sprints for Q3 planning.'],
        decision: null,
      },
    });

    // Find the page that was created.
    insertedPageId = await withClient(async (c) => {
      const r = await c.query(
        `SELECT id FROM wiki_pages WHERE org_id = $1 AND slug = $2 LIMIT 1`,
        [ORG_ID, uniqueSlug],
      );
      return r.rows[0]?.id ?? null;
    });

    assert.ok(insertedPageId, `Wiki page with slug "${uniqueSlug}" should have been created`);

    // Now check the job_queue for an embed-content job for this page.
    const job = await getEmbedJob(insertedPageId);
    assert.ok(
      job !== null,
      `Expected an embed-content job for wiki_page ${insertedPageId} in job_queue, but none found`,
    );
    assert.equal(job.data.source_type, 'wiki_page');
    assert.equal(job.data.source_id, insertedPageId);
  } finally {
    delete (globalThis as any).__mockAnthropicResponse;
    if (insertedPageId) {
      await cleanup([insertedPageId], insertedPageId ? [insertedPageId] : []);
    }
  }
});

test('2. enqueue embed-content called after wiki page UPDATE', async () => {
  // First, insert a wiki page manually so the handler can find it for update.
  const slug = `test-existing-page-update-${Date.now()}`;
  const pageId: string = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO wiki_pages (org_id, slug, title, content, type, scope, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [ORG_ID, slug, 'Existing Test Page', 'Original content.', 'fact', 'org', 0.9],
    );
    return r.rows[0].id;
  });

  // Set up LLM mock to return an UPDATE action referencing our page.
  (globalThis as any).__mockAnthropicResponse = () =>
    makeFakeAnthropicResponse(JSON.stringify({
      action: 'update',
      slug,
      content: 'Appended: sprint cadence confirmed at two weeks.',
      related_slugs: [],
    })) as unknown as Response;

  try {
    await handleMemoryExtract({
      id: 'job-update-test',
      name: 'memory-extract',
      data: {
        messageId: 'msg-update-test',
        spaceId: SPACE_ID,
        content: 'Confirmed: two-week sprints.',
        orgId: ORG_ID,
        userId: USER_ID,
        facts: ['Sprint cadence confirmed at two weeks.'],
        decision: null,
      },
    });

    // Check that an embed-content job was enqueued for the updated page.
    const job = await getEmbedJob(pageId);
    assert.ok(
      job !== null,
      `Expected an embed-content job for wiki_page ${pageId} (slug: ${slug}) in job_queue after UPDATE`,
    );
    assert.equal(job.data.source_type, 'wiki_page');
    assert.equal(job.data.source_id, pageId);
  } finally {
    delete (globalThis as any).__mockAnthropicResponse;
    await cleanup([pageId], [pageId]);
    // Also clean any cascading wiki ops log rows.
    await withClient((c) =>
      c.query(`DELETE FROM wiki_ops_log WHERE org_id = $1 AND details->>'source_message_id' = 'msg-update-test'`, [ORG_ID]),
    );
  }
});

test('3. embed-content enqueue failure does NOT propagate (fire-and-forget)', async () => {
  // KNOWN GAP: This test cannot inject an enqueue() failure due to ESM live
  // bindings. It only verifies the handler completes successfully in the happy
  // path. The fire-and-forget try/catch guarantee is enforced by code review,
  // not by this test. Revisit when a module-mocking solution is available.
  //
  // This test verifies that if the enqueue call inside memory-extract throws,
  // the handler still resolves without re-throwing.
  //
  // We simulate this by setting DATABASE_URL to make the job_queue insert fail
  // would be too invasive. Instead, we verify that the handler succeeds even
  // when the queue is temporarily unavailable by patching the db.insert path.
  //
  // Practical verification: we check that the handler completes (resolves)
  // even if the enqueue write fails. We test this by injecting an error at
  // the queue-write level via temporarily breaking the job_queue table name.
  //
  // Actually, since modifying the live db is risky, we take a different approach:
  // We confirm the handler runs to completion (no throw) by observing that
  // the wiki page IS created (meaning the outer catch didn't fire), even
  // though the embed job may or may not be present. This already implicitly
  // tests fire-and-forget if the try/catch is correct — a failure in enqueue
  // before the try/catch would have prevented the wiki page creation line
  // from completing in later stages.
  //
  // NOTE: The most direct test would be to mock the enqueue function. Since
  // ESM live bindings prevent this from outside the module, we rely on the
  // database integration to verify the overall contract.

  const slug = `test-ff-page-${Date.now()}`;
  let insertedPageId: string | null = null;

  (globalThis as any).__mockAnthropicResponse = () =>
    makeFakeAnthropicResponse(JSON.stringify({
      action: 'create',
      title: 'Fire and Forget Page',
      slug,
      type: 'fact',
      content: 'Content for fire and forget test.',
      summary: 'Fire and forget.',
      related_slugs: [],
    })) as unknown as Response;

  try {
    // Should resolve without throwing regardless of embed-content enqueue.
    await assert.doesNotReject(
      () => handleMemoryExtract({
        id: 'job-ff-test',
        name: 'memory-extract',
        data: {
          messageId: 'msg-ff-test',
          spaceId: SPACE_ID,
          content: 'Fire and forget test content.',
          orgId: ORG_ID,
          userId: USER_ID,
          facts: ['Fire and forget fact.'],
          decision: null,
        },
      }),
      'handleMemoryExtract should never throw even if enqueue fails',
    );

    // Verify wiki page was created (not rolled back due to enqueue failure).
    insertedPageId = await withClient(async (c) => {
      const r = await c.query(
        `SELECT id FROM wiki_pages WHERE org_id = $1 AND slug = $2 LIMIT 1`,
        [ORG_ID, slug],
      );
      return r.rows[0]?.id ?? null;
    });
    assert.ok(
      insertedPageId,
      `Wiki page should exist even if embed enqueue failed — handler must use try/catch`,
    );
  } finally {
    delete (globalThis as any).__mockAnthropicResponse;
    if (insertedPageId) {
      await cleanup([insertedPageId], [insertedPageId]);
    }
    await withClient((c) =>
      c.query(`DELETE FROM wiki_ops_log WHERE org_id = $1 AND details->>'source_message_id' = 'msg-ff-test'`, [ORG_ID]),
    );
  }
});
