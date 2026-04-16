/**
 * Task 1.1 — unified retrieval gateway.
 *
 * retrieveContext() is the single entry-point for all agent knowledge retrieval.
 * It replaces the 5 separate per-surface queries previously scattered across
 * agent.ts, mcp-tools/memory.ts, and mcp-tools/context.ts.
 *
 * Task 1.2 will layer hybrid vector+FTS ranking on top of this baseline.
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

// ─── Internal branch helpers ──────────────────────────────────────────────────

async function fetchWiki(
  org_id: string,
  forFTS: string,
  agent_employee_id: string | undefined,
  limit: number,
): Promise<ContextResult[]> {
  try {
    if (agent_employee_id) {
      // Two-tier retrieval: employee-tagged pages first (tier 1), then org-wide
      // pages (tier 2). Employee-tagged results receive a +0.1 tier bonus so
      // they win tiebreaks against org-wide pages with identical FTS scores.
      const [tier1Rows, tier2Rows] = await Promise.all([
        // Tier 1: pages explicitly tagged to this agent employee (limit 2).
        db
          .select({
            id: wikiPages.id,
            title: wikiPages.title,
            content: wikiPages.content,
            scope: wikiPages.scope,
            confidence: wikiPages.confidence,
            type: wikiPages.type,
            rawScore: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence}`,
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
          .orderBy(
            sql`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence} DESC`,
          )
          .limit(2),

        // Tier 2: org-wide pages with no employee tag (limit 3).
        db
          .select({
            id: wikiPages.id,
            title: wikiPages.title,
            content: wikiPages.content,
            scope: wikiPages.scope,
            confidence: wikiPages.confidence,
            type: wikiPages.type,
            rawScore: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence}`,
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
          .orderBy(
            sql`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence} DESC`,
          )
          .limit(3),
      ]);

      const out: ContextResult[] = [];
      for (const row of tier1Rows) {
        out.push({
          source_type: 'wiki_page',
          source_id: row.id,
          title: row.title,
          content: row.content,
          // +0.1 tier bonus so employee-tagged pages beat org-wide tiebreaks.
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
      return out;
    }

    // Single-query path when no agent_employee_id is supplied.
    const rows = await db
      .select({
        id: wikiPages.id,
        title: wikiPages.title,
        content: wikiPages.content,
        scope: wikiPages.scope,
        confidence: wikiPages.confidence,
        type: wikiPages.type,
        rawScore: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence}`,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.org_id, org_id),
          eq(wikiPages.is_deleted, false),
          // Exclude 'decision' type here — handled by the decisions branch.
          sql`${wikiPages.type} != 'decision'`,
          sql`search_vector @@ plainto_tsquery('english', ${forFTS})`,
        ),
      )
      .orderBy(
        sql`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence} DESC`,
      )
      .limit(limit);

    return rows.map((row) => ({
      source_type: 'wiki_page',
      source_id: row.id,
      title: row.title,
      content: row.content,
      score: clampScore(row.rawScore ?? 0),
      scope: row.scope,
      confidence: row.confidence,
      metadata: { type: row.type },
    }));
  } catch (err) {
    console.warn('[retrieveContext] wiki branch failed:', (err as Error).message);
    return [];
  }
}

async function fetchDecisions(
  org_id: string,
  forFTS: string,
  limit: number,
): Promise<ContextResult[]> {
  try {
    const rows = await db
      .select({
        id: wikiPages.id,
        title: wikiPages.title,
        content: wikiPages.content,
        scope: wikiPages.scope,
        confidence: wikiPages.confidence,
        rawScore: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence}`,
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
      .orderBy(
        sql`ts_rank(search_vector, plainto_tsquery('english', ${forFTS})) * ${wikiPages.confidence} DESC`,
      )
      .limit(limit);

    return rows.map((row) => ({
      source_type: 'decision' as ContextSource,
      source_id: row.id,
      title: row.title,
      content: row.content,
      score: clampScore(row.rawScore ?? 0),
      scope: row.scope,
      confidence: row.confidence,
    }));
  } catch (err) {
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
  } = params;

  // 1. Clean the query into FTS and ILIKE forms.
  const { forFTS, forIlike, words } = cleanQuery(query);

  // 2. Gate on the aggressively-stripped form — FTS can handle longer inputs
  //    but ILIKE with < 2 chars produces meaningless results.
  if (forIlike.length < 2) {
    return [];
  }

  // 3. Run all requested branches concurrently; each returns its own array.
  const [wikiRows, decisionRows, memRows, noteRows] = await Promise.all([
    types.includes('wiki')
      ? fetchWiki(org_id, forFTS, agent_employee_id, limit)
      : Promise.resolve([]),

    // 4. Decisions branch: queries wikiPages WHERE type='decision'. Forward-
    //    compatible path — Task 2.3 migrates the legacy decisions table here.
    types.includes('decisions')
      ? fetchDecisions(org_id, forFTS, limit)
      : Promise.resolve([]),

    types.includes('memory')
      ? fetchMemory(org_id, user_id, conversation_id, forIlike, words, limit)
      : Promise.resolve([]),

    // 5. Notes are always user-scoped. Skip without user_id to avoid exposing
    //    all users' private notes. Task 5.1 adds org-visibility column.
    types.includes('notes') && user_id
      ? fetchNotes(org_id, user_id, forIlike, words, limit)
      : Promise.resolve([]),
  ]);

  // 6. Merge, sort by score DESC, return top `limit`.
  const results = [...wikiRows, ...decisionRows, ...memRows, ...noteRows];
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
