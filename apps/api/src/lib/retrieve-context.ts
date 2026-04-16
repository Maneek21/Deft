/**
 * Task 1.1 — unified retrieval gateway.
 * Task 1.2 — hybrid FTS + pgvector ranking.
 *
 * retrieveContext() is the single entry-point for all agent knowledge retrieval.
 * It replaces the 5 separate per-surface queries previously scattered across
 * agent.ts, mcp-tools/memory.ts, and mcp-tools/context.ts.
 *
 * Tasks 1.3–1.5 will swap the existing call sites over to this gateway.
 */

import { eq, and, or, sql } from 'drizzle-orm';
import { db } from './db.js';
import { wikiPages, agentMemory, notes } from '@deft/db/schema';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ContextSource = 'wiki_page' | 'agent_memory' | 'note' | 'decision';

export interface ContextResult {
  source_type: ContextSource;
  source_id: string;
  title: string;
  content: string;
  score: number;
  scope?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface RetrieveContextParams {
  query: string;
  org_id: string;
  user_id?: string;
  conversation_id?: string;
  agent_employee_id?: string;
  types?: Array<'wiki' | 'memory' | 'notes' | 'decisions'>;
  limit?: number;
  /**
   * When true (default), combine FTS score with cosine similarity when an
   * embedding can be generated for the query. Set to false to force FTS-only
   * ranking (useful for testing or when vector search is not desired).
   */
  hybrid?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns two cleaned forms of the query:
 * - forFTS: whitespace-normalised only — safe for plainto_tsquery (preserves
 *   Unicode so non-English terms survive Postgres tokenisation).
 * - forIlike: aggressively stripped to ASCII alphanumerics + spaces, used for
 *   ILIKE patterns in memory/notes branches.
 * - words: lower-cased word list derived from forIlike, used by ilikeScore.
 *
 * The short-query gate should be applied to forIlike (the aggressive strip)
 * because forFTS may be longer due to punctuation and that's fine for Postgres
 * FTS.
 */
function cleanQuery(raw: string): { forFTS: string; forIlike: string; words: string[] } {
  const forFTS = raw.replace(/\s+/g, ' ').trim();
  const forIlike = forFTS.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = forIlike.toLowerCase().split(' ').filter(Boolean);
  return { forFTS, forIlike, words };
}

/**
 * Clamp a raw score to [0, 1]. Known limitation: ts_rank * confidence can
 * exceed 1.0 if a wiki_pages row has confidence > 1.0 (schema allows it; no
 * CHECK constraint). Such rows will sort identically at the top. Task 1.2
 * replaces this with proper hybrid-ranking normalisation.
 */
function clampScore(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Heuristic score for ilike-based matches: fraction of query words found
 * in the text, with a 0.5 floor so that any match is always relevant.
 */
function ilikeScore(text: string, queryWords: string[]): number {
  if (queryWords.length === 0) return 0.5;
  const lower = text.toLowerCase();
  const matched = queryWords.filter((w) => lower.includes(w)).length;
  return clampScore(0.5 + 0.5 * (matched / queryWords.length));
}

// ─── Hybrid vector helpers ────────────────────────────────────────────────────

const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;

// Warn only once per process when the <=> operator is unavailable (BYTEA env).
let _byteFallbackWarned = false;

/**
 * Walk the error cause chain and check whether any level indicates that the
 * pgvector extension or <=> operator is unavailable (BYTEA/no-pgvector environment).
 *
 * Handles two cases:
 *   - PG code 42704 / message "type "vector" does not exist" — extension not installed
 *   - PG code 42883 / message "operator does not exist" — extension installed but wrong type
 */
function isVectorOperatorError(err: unknown): boolean {
  let node: unknown = err;
  while (node != null && typeof node === 'object') {
    const e = node as { message?: string; code?: string; cause?: unknown };
    if (typeof e.message === 'string') {
      if (
        e.message.includes('operator does not exist') ||
        e.message.includes('type "vector" does not exist')
      ) {
        return true;
      }
    }
    if (e.code === '42883' || e.code === '42704') {
      return true;
    }
    node = e.cause ?? null;
  }
  return false;
}

/**
 * Generate a query embedding via OpenAI text-embedding-3-small.
 * Returns null on any failure (missing key, API error, malformed response)
 * so callers can gracefully fall back to FTS-only ranking.
 */
async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    return null;
  }

  try {
    const response = await globalThis.fetch(OPENAI_EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_EMBED_MODEL,
        input: query.slice(0, 32000),
        dimensions: EMBED_DIMS,
      }),
    });

    if (!response.ok) {
      console.warn(`[retrieveContext] OpenAI embeddings returned ${response.status} — falling back to FTS`);
      return null;
    }

    const json = (await response.json()) as { data?: { embedding?: number[] }[] };
    const embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBED_DIMS) {
      console.warn('[retrieveContext] OpenAI embeddings response malformed — falling back to FTS');
      return null;
    }
    // Guard against NaN/Infinity that would corrupt the SQL literal.
    if (embedding.some((v) => !Number.isFinite(v))) {
      console.warn('[retrieveContext] OpenAI embedding contains non-finite values — falling back to FTS');
      return null;
    }

    return embedding;
  } catch (err) {
    console.warn('[retrieveContext] generateQueryEmbedding failed:', (err as Error).message, '— falling back to FTS');
    return null;
  }
}

/**
 * Build the hybrid score SELECT expression when a query embedding is available.
 * Formula: (0.4 * ts_rank + 0.6 * cosine_similarity) * confidence
 * where cosine_similarity = coalesce(1 - (embedding <=> vectorLiteral), 0)
 * (NULL embedding rows get cosine_similarity = 0, so FTS alone drives their score).
 */
function hybridScoreExpr(forFTS: string, vectorLiteral: string) {
  return sql<number>`(0.4 * ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) + 0.6 * coalesce(1 - (embedding <=> ${vectorLiteral}::vector), 0)) * ${wikiPages.confidence}`;
}

function ftsScoreExpr(forFTS: string) {
  return sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence}`;
}

// ─── Internal branch helpers ──────────────────────────────────────────────────

/**
 * Execute the wiki SELECT query with the given score expression.
 * Extracted so we can retry with FTS-only on BYTEA/operator-not-found errors.
 */
async function runWikiQuery(
  org_id: string,
  forFTS: string,
  agent_employee_id: string | undefined,
  limit: number,
  scoreExpr: ReturnType<typeof hybridScoreExpr> | ReturnType<typeof ftsScoreExpr>,
  orderExpr: ReturnType<typeof hybridScoreExpr> | ReturnType<typeof ftsScoreExpr>,
) {
  if (agent_employee_id) {
    const [tier1Rows, tier2Rows] = await Promise.all([
      db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          content: wikiPages.content,
          scope: wikiPages.scope,
          confidence: wikiPages.confidence,
          type: wikiPages.type,
          rawScore: scoreExpr,
        })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.org_id, org_id),
            eq(wikiPages.is_deleted, false),
            sql`${wikiPages.type} != 'decision'`,
            eq(wikiPages.agent_employee_id, agent_employee_id),
            sql`search_vector @@ plainto_tsquery('english', ${forFTS})`,
          ),
        )
        .orderBy(sql`${orderExpr} DESC`)
        .limit(2),

      db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          content: wikiPages.content,
          scope: wikiPages.scope,
          confidence: wikiPages.confidence,
          type: wikiPages.type,
          rawScore: scoreExpr,
        })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.org_id, org_id),
            eq(wikiPages.is_deleted, false),
            sql`${wikiPages.type} != 'decision'`,
            sql`${wikiPages.agent_employee_id} IS NULL`,
            sql`search_vector @@ plainto_tsquery('english', ${forFTS})`,
          ),
        )
        .orderBy(sql`${orderExpr} DESC`)
        .limit(3),
    ]);
    return { tier1Rows, tier2Rows, singleRows: null };
  }

  const singleRows = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      content: wikiPages.content,
      scope: wikiPages.scope,
      confidence: wikiPages.confidence,
      type: wikiPages.type,
      rawScore: scoreExpr,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.org_id, org_id),
        eq(wikiPages.is_deleted, false),
        sql`${wikiPages.type} != 'decision'`,
        sql`search_vector @@ plainto_tsquery('english', ${forFTS})`,
      ),
    )
    .orderBy(sql`${orderExpr} DESC`)
    .limit(limit);
  return { tier1Rows: null, tier2Rows: null, singleRows };
}

function mapWikiRows(
  tier1Rows: Array<{ id: string; title: string; content: string; scope: string | null; confidence: number; type: string; rawScore: number }> | null,
  tier2Rows: Array<{ id: string; title: string; content: string; scope: string | null; confidence: number; type: string; rawScore: number }> | null,
  singleRows: Array<{ id: string; title: string; content: string; scope: string | null; confidence: number; type: string; rawScore: number }> | null,
): ContextResult[] {
  const out: ContextResult[] = [];
  if (tier1Rows && tier2Rows) {
    for (const row of tier1Rows) {
      out.push({
        source_type: 'wiki_page',
        source_id: row.id,
        title: row.title,
        content: row.content,
        score: clampScore((row.rawScore ?? 0) + 0.1),
        scope: row.scope,
        confidence: row.confidence,
        metadata: { type: row.type, tier: 'employee' },
      });
    }
    for (const row of tier2Rows) {
      out.push({
        source_type: 'wiki_page',
        source_id: row.id,
        title: row.title,
        content: row.content,
        score: clampScore(row.rawScore ?? 0),
        scope: row.scope,
        confidence: row.confidence,
        metadata: { type: row.type, tier: 'org' },
      });
    }
  } else if (singleRows) {
    for (const row of singleRows) {
      out.push({
        source_type: 'wiki_page',
        source_id: row.id,
        title: row.title,
        content: row.content,
        score: clampScore(row.rawScore ?? 0),
        scope: row.scope,
        confidence: row.confidence,
        metadata: { type: row.type },
      });
    }
  }
  return out;
}

async function fetchWiki(
  org_id: string,
  forFTS: string,
  agent_employee_id: string | undefined,
  limit: number,
  queryEmbedding: number[] | null,
  hybrid: boolean,
): Promise<ContextResult[]> {
  // Determine whether to use hybrid scoring.
  const useHybrid = hybrid && queryEmbedding !== null;
  const vectorLiteral = useHybrid ? `[${queryEmbedding!.join(',')}]` : '';

  const scoreExpr = useHybrid ? hybridScoreExpr(forFTS, vectorLiteral) : ftsScoreExpr(forFTS);
  const orderExpr = useHybrid ? hybridScoreExpr(forFTS, vectorLiteral) : ftsScoreExpr(forFTS);

  try {
    const { tier1Rows, tier2Rows, singleRows } = await runWikiQuery(
      org_id, forFTS, agent_employee_id, limit, scoreExpr, orderExpr,
    );
    return mapWikiRows(tier1Rows, tier2Rows, singleRows);
  } catch (err) {
    if (useHybrid && isVectorOperatorError(err)) {
      // BYTEA fallback: pgvector <=> operator not available — retry with FTS only.
      if (!_byteFallbackWarned) {
        _byteFallbackWarned = true;
        console.warn('[retrieveContext] pgvector <=> operator unavailable (BYTEA column?) — falling back to FTS-only for wiki queries');
      }
      try {
        const ftsSE = ftsScoreExpr(forFTS);
        const { tier1Rows: t1, tier2Rows: t2, singleRows: sr } = await runWikiQuery(
          org_id, forFTS, agent_employee_id, limit, ftsSE, ftsSE,
        );
        return mapWikiRows(t1, t2, sr);
      } catch (ftsErr) {
        console.warn('[retrieveContext] wiki branch failed (FTS fallback):', (ftsErr as Error).message);
        return [];
      }
    }

    console.warn('[retrieveContext] wiki branch failed:', (err as Error).message);
    return [];
  }
}

async function fetchDecisions(
  org_id: string,
  forFTS: string,
  limit: number,
  queryEmbedding: number[] | null,
  hybrid: boolean,
): Promise<ContextResult[]> {
  const useHybrid = hybrid && queryEmbedding !== null;
  const vectorLiteral = useHybrid ? `[${queryEmbedding!.join(',')}]` : '';

  const buildQuery = (scoreExpr: ReturnType<typeof hybridScoreExpr> | ReturnType<typeof ftsScoreExpr>) =>
    db
      .select({
        id: wikiPages.id,
        title: wikiPages.title,
        content: wikiPages.content,
        scope: wikiPages.scope,
        confidence: wikiPages.confidence,
        rawScore: scoreExpr,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.org_id, org_id),
          eq(wikiPages.is_deleted, false),
          eq(wikiPages.type, 'decision'),
          sql`search_vector @@ plainto_tsquery('english', ${forFTS})`,
        ),
      )
      .orderBy(sql`${scoreExpr} DESC`)
      .limit(limit);

  const mapRows = (rows: Array<{ id: string; title: string; content: string; scope: string | null; confidence: number; rawScore: number }>) =>
    rows.map((row) => ({
      source_type: 'decision' as ContextSource,
      source_id: row.id,
      title: row.title,
      content: row.content,
      score: clampScore(row.rawScore ?? 0),
      scope: row.scope,
      confidence: row.confidence,
    }));

  try {
    const scoreExpr = useHybrid ? hybridScoreExpr(forFTS, vectorLiteral) : ftsScoreExpr(forFTS);
    const rows = await buildQuery(scoreExpr);
    return mapRows(rows);
  } catch (err) {
    if (useHybrid && isVectorOperatorError(err)) {
      // BYTEA fallback: retry with FTS only.
      if (!_byteFallbackWarned) {
        _byteFallbackWarned = true;
        console.warn('[retrieveContext] pgvector <=> operator unavailable (BYTEA column?) — falling back to FTS-only for decisions queries');
      }
      try {
        const rows = await buildQuery(ftsScoreExpr(forFTS));
        return mapRows(rows);
      } catch (ftsErr) {
        console.warn('[retrieveContext] decisions branch failed (FTS fallback):', (ftsErr as Error).message);
        return [];
      }
    }

    console.warn('[retrieveContext] decisions branch failed:', (err as Error).message);
    return [];
  }
}

async function fetchMemory(
  org_id: string,
  user_id: string | undefined,
  conversation_id: string | undefined,
  forIlike: string,
  words: string[],
  limit: number,
): Promise<ContextResult[]> {
  try {
    // Build scope conditions.
    // Always include org-level memories for this org.
    //
    // PERF HAZARD: agent_memory has no index on (org_id, scope), so org-scope
    // reads are full-table scans. Acceptable while the table is small, but a
    // partial index on (org_id, scope) should land before this code is under
    // production load. Task 2.2 will retire most org-scope reads by migrating
    // commitments to wikiPages.
    const scopeClauses = [
      and(
        eq(agentMemory.scope, 'org'),
        eq(agentMemory.org_id, org_id),
      ),
    ];

    if (user_id) {
      scopeClauses.push(
        and(
          eq(agentMemory.scope, 'user'),
          eq(agentMemory.user_id, user_id),
          eq(agentMemory.org_id, org_id),
        ),
      );
    }

    if (conversation_id) {
      scopeClauses.push(
        and(
          eq(agentMemory.scope, 'conversation'),
          // conversation_id can be null on rows; sql coalesce guard.
          sql`${agentMemory.conversation_id} = ${conversation_id}`,
          eq(agentMemory.org_id, org_id),
        ),
      );
    }

    // NOTE: trigram index (pg_trgm) on agent_memory.value is planned (Task 1.4)
    // to avoid sequential scans on ILIKE. Until then this will scan.
    const rows = await db
      .select({
        id: agentMemory.id,
        key: agentMemory.key,
        value: agentMemory.value,
        scope: agentMemory.scope,
      })
      .from(agentMemory)
      .where(
        and(
          or(...scopeClauses),
          sql`${agentMemory.value} ILIKE ${`%${forIlike}%`}`,
        ),
      )
      .limit(limit);

    return rows.map((row) => ({
      source_type: 'agent_memory' as ContextSource,
      source_id: row.id,
      title: row.key,
      content: row.value,
      score: ilikeScore(row.value, words),
      scope: row.scope,
    }));
  } catch (err) {
    console.warn('[retrieveContext] memory branch failed:', (err as Error).message);
    return [];
  }
}

async function fetchNotes(
  org_id: string,
  user_id: string,
  forIlike: string,
  words: string[],
  limit: number,
): Promise<ContextResult[]> {
  try {
    // NOTE: trigram index (pg_trgm) on notes.content is planned (Task 1.4)
    // to avoid sequential scans on ILIKE. Until then this will scan.
    const rows = await db
      .select({
        id: notes.id,
        title: notes.title,
        content: notes.content,
      })
      .from(notes)
      .where(
        and(
          eq(notes.org_id, org_id),
          eq(notes.user_id, user_id),
          eq(notes.is_deleted, false),
          sql`${notes.content} ILIKE ${`%${forIlike}%`}`,
        ),
      )
      .limit(limit);

    return rows.map((row) => {
      const text = row.content ?? '';
      return {
        source_type: 'note' as ContextSource,
        source_id: row.id,
        title: row.title,
        content: text,
        score: ilikeScore(text, words),
      };
    });
  } catch (err) {
    console.warn('[retrieveContext] notes branch failed:', (err as Error).message);
    return [];
  }
}

// ─── Main gateway ─────────────────────────────────────────────────────────────

export async function retrieveContext(
  params: RetrieveContextParams,
): Promise<ContextResult[]> {
  const {
    query,
    org_id,
    user_id,
    conversation_id,
    agent_employee_id,
    types = ['wiki', 'memory', 'notes', 'decisions'],
    limit = 10,
    hybrid = true,
  } = params;

  // 1. Clean the query into FTS and ILIKE forms.
  const { forFTS, forIlike, words } = cleanQuery(query);

  // 2. Gate on the aggressively-stripped form — FTS can handle longer inputs
  //    but ILIKE with < 2 chars produces meaningless results.
  if (forIlike.length < 2) {
    return [];
  }

  // 3. Generate query embedding once — reused by wiki and decisions branches.
  //    Returns null when OPENAI_API_KEY is unset or the API call fails, which
  //    causes both branches to fall back to FTS-only ranking transparently.
  const needsEmbedding =
    hybrid && (types.includes('wiki') || types.includes('decisions'));
  const queryEmbedding = needsEmbedding
    ? await generateQueryEmbedding(forFTS)
    : null;

  // 4. Run all requested branches concurrently; each returns its own array.
  const [wikiRows, decisionRows, memRows, noteRows] = await Promise.all([
    types.includes('wiki')
      ? fetchWiki(org_id, forFTS, agent_employee_id, limit, queryEmbedding, hybrid)
      : Promise.resolve([]),

    // 5. Decisions branch: queries wikiPages WHERE type='decision'. Forward-
    //    compatible path — Task 2.3 migrates the legacy decisions table here.
    types.includes('decisions')
      ? fetchDecisions(org_id, forFTS, limit, queryEmbedding, hybrid)
      : Promise.resolve([]),

    types.includes('memory')
      ? fetchMemory(org_id, user_id, conversation_id, forIlike, words, limit)
      : Promise.resolve([]),

    // 6. Notes are always user-scoped. Skip without user_id to avoid exposing
    //    all users' private notes. Task 5.1 adds org-visibility column.
    types.includes('notes') && user_id
      ? fetchNotes(org_id, user_id, forIlike, words, limit)
      : Promise.resolve([]),
  ]);

  // 7. Merge, sort by score DESC, return top `limit`.
  const results = [...wikiRows, ...decisionRows, ...memRows, ...noteRows];
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
