/**
 * embed-content worker unit tests.
 *
 * Run: pnpm --filter @deft/api test -- embed-content
 *
 * Covers:
 *   1. Writes a 1536-dim embedding to the target wiki page when OPENAI_API_KEY is set
 *   2. Returns early without error when OPENAI_API_KEY is unset
 *   3. Warns and skips unknown source_type without throwing
 *   4. Throws (for retry) when the OpenAI API returns a non-OK status
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const MOCK_EMBEDDING = Array(1536).fill(0.1);

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ─── Fetch mock ──────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof mock.fn> | null = null;
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;

  // Set OPENAI_API_KEY for all tests unless explicitly overridden.
  process.env.OPENAI_API_KEY = 'sk-test-mock';

  fetchMock = mock.fn(async (_url: string, _opts?: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => '{}',
    json: async () => ({ data: [{ embedding: MOCK_EMBEDDING }] }),
  }));
  // Replace global fetch with our mock.
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('1. writes a 1536-dim embedding to the target wiki page', async () => {
  // Insert a test wiki page.
  const pageId = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO wiki_pages
        (org_id, slug, title, content, summary, type, scope, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        ORG_ID,
        `test-embed-page-${Date.now()}`,
        'Test embed page',
        'We decided to use Stripe for billing.',
        'Billing decision.',
        'decision',
        'org',
        0.9,
      ],
    );
    return r.rows[0].id as string;
  });

  try {
    const { handleEmbedContent } = await import('../src/workers/handlers/embed-content.js');

    await handleEmbedContent({
      id: 'job-1',
      name: 'embed-content',
      data: { source_type: 'wiki_page', source_id: pageId },
    });

    // Verify the embedding was written.
    await withClient(async (c) => {
      // Check if pgvector is available to know which assertion path to take.
      const extR = await c.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
      );
      const hasPgVector = extR.rowCount !== null && extR.rowCount > 0;

      const r = await c.query(
        `SELECT embedding FROM wiki_pages WHERE id = $1`,
        [pageId],
      );
      assert.equal(r.rows.length, 1, 'row should exist');
      const raw = r.rows[0].embedding;
      assert.ok(raw !== null, 'embedding should not be null after handler runs');

      if (hasPgVector) {
        // pgvector env: column returns a parsed number[] or vector string.
        const parsed: number[] =
          typeof raw === 'string'
            ? JSON.parse(raw.replace(/^\[/, '[').replace(/\]$/, ']'))
            : Array.isArray(raw)
            ? raw
            : Object.values(raw);
        assert.equal(parsed.length, 1536, 'embedding should have 1536 dimensions');
      } else {
        // BYTEA fallback env: column is Buffer containing JSON-encoded float array.
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const parsed: number[] = JSON.parse(buf.toString('utf8'));
        assert.ok(Array.isArray(parsed), 'bytea embedding should deserialize to array');
        assert.equal(parsed.length, 1536, 'bytea embedding should have 1536 dimensions');
      }
    });
  } finally {
    await withClient((c) =>
      c.query(`DELETE FROM wiki_pages WHERE id = $1`, [pageId]),
    );
  }
});

test('2. returns early without error when OPENAI_API_KEY is unset', async () => {
  // Early return happens before any DB access — source_id is irrelevant here.
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  try {
    const { handleEmbedContent } = await import('../src/workers/handlers/embed-content.js');
    // Should resolve, not throw.
    await handleEmbedContent({
      id: 'job-2',
      name: 'embed-content',
      data: { source_type: 'wiki_page', source_id: 'irrelevant-no-api-key' },
    });
  } finally {
    process.env.OPENAI_API_KEY = saved;
  }
});

test('3. warns and skips unknown source_type without throwing', async () => {
  const { handleEmbedContent } = await import('../src/workers/handlers/embed-content.js');
  await handleEmbedContent({
    id: 'job-3',
    name: 'embed-content',
    data: { source_type: 'message', source_id: 'msg-1' },
  });
  // Should resolve without throwing.
});

test('4. throws on non-OK OpenAI response so the queue retries', async () => {
  // Temporarily override fetch to return a 429.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => 'Rate limited',
  }) as unknown as Response;

  try {
    const { handleEmbedContent } = await import('../src/workers/handlers/embed-content.js');

    // Insert a page so the handler doesn't bail out on "page not found".
    const pageId = await withClient(async (c) => {
      const r = await c.query(
        `INSERT INTO wiki_pages
          (org_id, slug, title, content, type, scope, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [ORG_ID, `test-embed-err-${Date.now()}`, 'Err page', 'content', 'decision', 'org', 1.0],
      );
      return r.rows[0].id as string;
    });

    try {
      await assert.rejects(
        () =>
          handleEmbedContent({
            id: 'job-4',
            name: 'embed-content',
            data: { source_type: 'wiki_page', source_id: pageId },
          }),
        /429|Rate limited|OpenAI/i,
      );
    } finally {
      await withClient((c) =>
        c.query(`DELETE FROM wiki_pages WHERE id = $1`, [pageId]),
      );
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});
