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

import { eq, and, or, ilike, sql } from 'drizzle-orm';
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
 * Strip non-alphanumerics (except spaces), collapse whitespace, and trim.
 * Returns the cleaned string; callers should check length >= 2.
 */
function cleanQuery(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cap a raw score to [0, 1].  Task 1.2 will replace this with proper
 * normalisation once vector scores are in play.
 */
function cap(score: number): number {
  return Math.min(Math.max(score, 0), 1);
}

/**
 * Heuristic score for ilike-based matches: fraction of query words found
 * in the text, with a 0.5 floor so that any match is always relevant.
 */
function ilikeScore(text: string, queryWords: string[]): number {
  if (queryWords.length === 0) return 0.5;
  const lower = text.toLowerCase();
  const matched = queryWords.filter((w) => lower.includes(w)).length;
  return cap(0.5 + 0.5 * (matched / queryWords.length));
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
    types = ['wiki', 'memory', 'notes', 'decisions'],
    limit = 10,
  } = params;

  // 1. Clean the query.
  const cleaned = cleanQuery(query);
  if (cleaned.length < 2) {
    return [];
  }

  const queryWords = cleaned.toLowerCase().split(' ').filter(Boolean);
  const results: ContextResult[] = [];

  // Run branches concurrently for performance.
  const promises: Promise<void>[] = [];

  // ── wiki ──────────────────────────────────────────────────────────────────
  if (types.includes('wiki')) {
    promises.push(
      (async () => {
        try {
          const rows = await db
            .select({
              id: wikiPages.id,
              title: wikiPages.title,
              content: wikiPages.content,
              scope: wikiPages.scope,
              confidence: wikiPages.confidence,
              type: wikiPages.type,
              rawScore: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${cleaned})) * ${wikiPages.confidence}`,
            })
            .from(wikiPages)
            .where(
              and(
                eq(wikiPages.org_id, org_id),
                eq(wikiPages.is_deleted, false),
                // Exclude 'decision' type here — handled by the decisions branch.
                sql`${wikiPages.type} != 'decision'`,
                sql`search_vector @@ plainto_tsquery('english', ${cleaned})`,
              ),
            )
            .orderBy(
              sql`ts_rank(search_vector, plainto_tsquery('english', ${cleaned})) * ${wikiPages.confidence} DESC`,
            )
            .limit(limit);

          for (const row of rows) {
            results.push({
              source_type: 'wiki_page',
              source_id: row.id,
              title: row.title,
              content: row.content,
              score: cap(row.rawScore ?? 0),
              scope: row.scope,
              confidence: row.confidence,
              metadata: { type: row.type },
            });
          }
        } catch (err) {
          console.warn('[retrieveContext] wiki branch failed:', (err as Error).message);
        }
      })(),
    );
  }

  // ── memory ────────────────────────────────────────────────────────────────
  if (types.includes('memory')) {
    promises.push(
      (async () => {
        try {
          // Build scope conditions.
          // Always include org-level memories for this org.
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
                ilike(agentMemory.value, `%${cleaned}%`),
              ),
            )
            .limit(limit);

          for (const row of rows) {
            results.push({
              source_type: 'agent_memory',
              source_id: row.id,
              title: row.key,
              content: row.value,
              score: ilikeScore(row.value, queryWords),
              scope: row.scope,
            });
          }
        } catch (err) {
          console.warn('[retrieveContext] memory branch failed:', (err as Error).message);
        }
      })(),
    );
  }

  // ── notes ─────────────────────────────────────────────────────────────────
  if (types.includes('notes')) {
    // Notes are always user-scoped. Without user_id we cannot safely retrieve
    // them (we'd expose all users' private notes). Skip this branch silently.
    if (!user_id) {
      // No-op — see Task 5.1 which will add a visibility column.
    } else {
      promises.push(
        (async () => {
          try {
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
                  ilike(notes.content, `%${cleaned}%`),
                ),
              )
              .limit(limit);

            for (const row of rows) {
              const text = row.content ?? '';
              results.push({
                source_type: 'note',
                source_id: row.id,
                title: row.title,
                content: text,
                score: ilikeScore(text, queryWords),
              });
            }
          } catch (err) {
            console.warn('[retrieveContext] notes branch failed:', (err as Error).message);
          }
        })(),
      );
    }
  }

  // ── decisions ─────────────────────────────────────────────────────────────
  // Queries wikiPages WHERE type='decision'.  This is the forward-compatible
  // path: Task 2.3 migrates the legacy decisions table to wikiPages, and this
  // branch already targets the destination schema.
  if (types.includes('decisions')) {
    promises.push(
      (async () => {
        try {
          const rows = await db
            .select({
              id: wikiPages.id,
              title: wikiPages.title,
              content: wikiPages.content,
              scope: wikiPages.scope,
              confidence: wikiPages.confidence,
              rawScore: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${cleaned})) * ${wikiPages.confidence}`,
            })
            .from(wikiPages)
            .where(
              and(
                eq(wikiPages.org_id, org_id),
                eq(wikiPages.is_deleted, false),
                eq(wikiPages.type, 'decision'),
                sql`search_vector @@ plainto_tsquery('english', ${cleaned})`,
              ),
            )
            .orderBy(
              sql`ts_rank(search_vector, plainto_tsquery('english', ${cleaned})) * ${wikiPages.confidence} DESC`,
            )
            .limit(limit);

          for (const row of rows) {
            results.push({
              source_type: 'decision',
              source_id: row.id,
              title: row.title,
              content: row.content,
              score: cap(row.rawScore ?? 0),
              scope: row.scope,
              confidence: row.confidence,
            });
          }
        } catch (err) {
          console.warn('[retrieveContext] decisions branch failed:', (err as Error).message);
        }
      })(),
    );
  }

  // Wait for all concurrent branches.
  await Promise.all(promises);

  // 6. Sort by score DESC, take top `limit`.
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
