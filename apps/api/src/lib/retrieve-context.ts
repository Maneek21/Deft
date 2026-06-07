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

import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { db } from './db.js';
import { wikiPages, agentMemory, notes, tasks, spaceMembers, projects } from '@deft/db/schema';
import { embedQuiet, EMBED_DIMS } from './embed.js';
import { unrestrictedTaskCondition, visibleTaskCondition } from './task-visibility.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ContextSource = 'wiki_page' | 'agent_memory' | 'note' | 'decision' | 'task';

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
  types?: Array<'wiki' | 'memory' | 'notes' | 'decisions' | 'tasks'>;
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
 * Generate a query embedding for hybrid ranking. Routes through the BYO
 * provider abstraction in lib/embed.ts so the same per-org config that drives
 * write-side embedding (`embed-content` worker) governs read-side query
 * vectors. Returns null on any failure so callers fall back to FTS-only.
 */
async function generateQueryEmbedding(query: string, org_id: string): Promise<number[] | null> {
  return embedQuiet(query.slice(0, 32_000), org_id);
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
          slug: wikiPages.slug,
          summary: wikiPages.summary,
          content: wikiPages.content,
          scope: wikiPages.scope,
          confidence: wikiPages.confidence,
          type: wikiPages.type,
          agent_employee_id: wikiPages.agent_employee_id,
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
          slug: wikiPages.slug,
          summary: wikiPages.summary,
          content: wikiPages.content,
          scope: wikiPages.scope,
          confidence: wikiPages.confidence,
          type: wikiPages.type,
          agent_employee_id: wikiPages.agent_employee_id,
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
      slug: wikiPages.slug,
      summary: wikiPages.summary,
      content: wikiPages.content,
      scope: wikiPages.scope,
      confidence: wikiPages.confidence,
      type: wikiPages.type,
      agent_employee_id: wikiPages.agent_employee_id,
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

type WikiRow = {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  content: string;
  scope: string | null;
  confidence: number;
  type: string;
  agent_employee_id: string | null;
  rawScore: number;
};

function mapWikiRows(
  tier1Rows: WikiRow[] | null,
  tier2Rows: WikiRow[] | null,
  singleRows: WikiRow[] | null,
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
        scope: row.scope ?? undefined,
        confidence: row.confidence,
        metadata: {
          type: row.type,
          tier: 'employee',
          slug: row.slug,
          summary: row.summary ?? null,
          agent_employee_id: row.agent_employee_id ?? null,
        },
      });
    }
    for (const row of tier2Rows) {
      out.push({
        source_type: 'wiki_page',
        source_id: row.id,
        title: row.title,
        content: row.content,
        score: clampScore(row.rawScore ?? 0),
        scope: row.scope ?? undefined,
        confidence: row.confidence,
        metadata: {
          type: row.type,
          tier: 'org',
          slug: row.slug,
          summary: row.summary ?? null,
          agent_employee_id: row.agent_employee_id ?? null,
        },
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
        scope: row.scope ?? undefined,
        confidence: row.confidence,
        metadata: {
          type: row.type,
          slug: row.slug,
          summary: row.summary ?? null,
          agent_employee_id: row.agent_employee_id ?? null,
        },
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
      scope: row.scope ?? undefined,
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
  user_id: string | undefined,
  forIlike: string,
  words: string[],
  limit: number,
): Promise<ContextResult[]> {
  try {
    // NOTE: trigram index (pg_trgm) on notes.content is planned (Task 1.4)
    // to avoid sequential scans on ILIKE. Until then this will scan.
    //
    // Task 5.2: include org-visible notes for all callers. When user_id is
    // present we return the user's own notes (any visibility), org-visible
    // notes from other users, and space-visible notes only for spaces the user
    // belongs to. When user_id is absent (system queries) we return only
    // org-visible notes so private/space notes are never leaked.
    const visibleSpaceIds = user_id
      ? db.select({ space_id: spaceMembers.space_id })
        .from(spaceMembers)
        .where(eq(spaceMembers.user_id, user_id))
      : undefined;

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
          eq(notes.is_deleted, false),
          or(
            user_id ? eq(notes.user_id, user_id) : undefined,
            eq(notes.visibility, 'org'),
            user_id && visibleSpaceIds
              ? and(
                  eq(notes.visibility, 'space'),
                  inArray(notes.visibility_space_id, visibleSpaceIds),
                )
              : undefined,
          ),
          or(
            sql`${notes.title} ILIKE ${`%${forIlike}%`}`,
            sql`${notes.content} ILIKE ${`%${forIlike}%`}`,
          ),
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

async function fetchTasks(
  org_id: string,
  user_id: string | undefined,
  forFTS: string,
  limit: number,
  queryEmbedding: number[] | null,
  hybrid: boolean,
): Promise<ContextResult[]> {
  // Task 3.8 — hybrid FTS + pgvector ranking over tasks.title + tasks.description.
  // Mirrors fetchDecisions. search_vector is a GENERATED STORED tsvector column
  // added in migration 0033; we reference it via sql literal since Drizzle
  // doesn't have a first-class generated-column type.
  const useHybrid = hybrid && queryEmbedding !== null;
  const vectorLiteral = useHybrid ? `[${queryEmbedding!.join(',')}]` : '';

  // Score expressions (taskwise — no confidence column, so plain ts_rank).
  const taskFtsScore = (fts: string) =>
    sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${fts}))`;
  const taskHybridScore = (fts: string, vec: string) =>
    sql<number>`0.4 * ts_rank(search_vector, plainto_tsquery('english', ${fts})) + 0.6 * coalesce(1 - (embedding <=> ${vec}::vector), 0)`;

  const buildQuery = (scoreExpr: ReturnType<typeof taskFtsScore> | ReturnType<typeof taskHybridScore>) =>
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        assignee_id: tasks.assignee_id,
        project_id: tasks.project_id,
        rawScore: scoreExpr,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.org_id, org_id),
          eq(tasks.is_deleted, false),
          user_id ? visibleTaskCondition(user_id) : unrestrictedTaskCondition(),
          sql`search_vector @@ plainto_tsquery('english', ${forFTS})`,
        ),
      )
      .orderBy(sql`${scoreExpr} DESC`)
      .limit(limit);

  const mapRows = (
    rows: Array<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      assignee_id: string | null;
      project_id: string;
      rawScore: number;
    }>,
  ) =>
    rows.map((row) => ({
      source_type: 'task' as ContextSource,
      source_id: row.id,
      title: row.title,
      content: row.description ?? '',
      score: clampScore(row.rawScore ?? 0),
      metadata: {
        status: row.status,
        priority: row.priority,
        assignee_id: row.assignee_id ?? null,
        project_id: row.project_id,
      },
    }));

  try {
    const scoreExpr = useHybrid
      ? taskHybridScore(forFTS, vectorLiteral)
      : taskFtsScore(forFTS);
    const rows = await buildQuery(scoreExpr);
    return mapRows(rows);
  } catch (err) {
    if (useHybrid && isVectorOperatorError(err)) {
      if (!_byteFallbackWarned) {
        _byteFallbackWarned = true;
        console.warn('[retrieveContext] pgvector <=> operator unavailable (BYTEA column?) — falling back to FTS-only for tasks queries');
      }
      try {
        const rows = await buildQuery(taskFtsScore(forFTS));
        return mapRows(rows);
      } catch (ftsErr) {
        console.warn('[retrieveContext] tasks branch failed (FTS fallback):', (ftsErr as Error).message);
        return [];
      }
    }

    console.warn('[retrieveContext] tasks branch failed:', (err as Error).message);
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
    types = ['wiki', 'memory', 'notes', 'decisions', 'tasks'],
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
    hybrid && (types.includes('wiki') || types.includes('decisions') || types.includes('tasks'));
  const queryEmbedding = needsEmbedding
    ? await generateQueryEmbedding(forFTS, org_id)
    : null;

  // 4. Run all requested branches concurrently; each returns its own array.
  const [wikiRows, decisionRows, memRows, noteRows, taskRows] = await Promise.all([
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

    // 6. Notes branch respects visibility (Task 5.2). When user_id is present,
    //    returns the user's own notes plus org-visible notes. When user_id is
    //    absent (system queries), returns only org-visible notes — private notes
    //    are never leaked.
    types.includes('notes')
      ? fetchNotes(org_id, user_id, forIlike, words, limit)
      : Promise.resolve([]),

    // 7. Tasks branch (Task 3.8): hybrid FTS + pgvector over title + description,
    //    filtered by org_id + is_deleted. Backing store is tasks.search_vector
    //    (generated tsvector) + tasks.embedding (pgvector).
    types.includes('tasks')
      ? fetchTasks(org_id, user_id, forFTS, limit, queryEmbedding, hybrid)
      : Promise.resolve([]),
  ]);

  // 8. Merge, sort by score DESC, return top `limit`.
  const results = [...wikiRows, ...decisionRows, ...memRows, ...noteRows, ...taskRows];
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
