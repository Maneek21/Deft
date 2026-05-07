// Handler: wiki-lint — daily health check for wiki pages
// Detects orphaned pages, stale content, low-confidence entries, and contradictions.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { wikiPages, wikiLinks, wikiCitations, wikiOpsLog } from '@deft/db/schema';
import { eq, and, sql, lt, desc } from 'drizzle-orm';
import { llm } from '../../lib/llm.js';

export async function handleWikiLint(job: JobData): Promise<void> {
  console.log('[wiki-lint] Starting daily wiki health check');

  // Run lint for each org that has wiki pages
  const orgIds = await db.selectDistinct({ org_id: wikiPages.org_id })
    .from(wikiPages)
    .where(eq(wikiPages.is_deleted, false));

  let totalOrphaned = 0;
  let totalStale = 0;
  let totalDecayed = 0;
  let totalLowConfidence = 0;
  let totalContradictions = 0;

  for (const { org_id } of orgIds) {
    try {
      const results = await lintOrg(org_id);
      totalOrphaned += results.orphaned;
      totalStale += results.stale;
      totalDecayed += results.decayed;
      totalLowConfidence += results.lowConfidence;
      totalContradictions += results.contradictions;
    } catch (err) {
      console.error(`[wiki-lint] Error linting org ${org_id}:`, (err as Error).message);
    }
  }

  console.log(`[wiki-lint] Complete — orphaned: ${totalOrphaned}, stale: ${totalStale}, decayed: ${totalDecayed}, low-confidence: ${totalLowConfidence}, contradictions: ${totalContradictions}`);
}

async function lintOrg(orgId: string): Promise<{
  orphaned: number;
  stale: number;
  decayed: number;
  lowConfidence: number;
  contradictions: number;
}> {
  let orphaned = 0;
  let stale = 0;
  let decayed = 0;
  let lowConfidence = 0;
  let contradictions = 0;

  // 1. Find orphaned pages — no inbound or outbound links
  const orphanedPages = await db.execute(sql`
    SELECT wp.id, wp.title, wp.slug
    FROM wiki_pages wp
    WHERE wp.org_id = ${orgId}
      AND wp.is_deleted = false
      AND NOT EXISTS (
        SELECT 1 FROM wiki_links wl
        WHERE wl.source_page_id = wp.id OR wl.target_page_id = wp.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM wiki_citations wc
        WHERE wc.page_id = wp.id
      )
  `);

  const orphanRows = (orphanedPages as any).rows ?? orphanedPages;
  if (Array.isArray(orphanRows) && orphanRows.length > 0) {
    orphaned = orphanRows.length;
    // Log each orphaned page
    for (const page of orphanRows) {
      await db.insert(wikiOpsLog).values({
        org_id: orgId,
        operation: 'lint',
        page_id: page.id,
        details: { issue: 'orphaned', message: `Page "${page.title}" has no links to or from other pages` },
        performed_by: 'system',
      });
    }
  }

  // 2. Find stale pages — not updated in 90+ days AND confidence < 0.7
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const stalePages = await db.select({ id: wikiPages.id, title: wikiPages.title, confidence: wikiPages.confidence })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.is_deleted, false),
      lt(wikiPages.updated_at, ninetyDaysAgo),
      lt(wikiPages.confidence, 0.7),
    ));

  for (const page of stalePages) {
    stale++;
    // Reduce confidence by 0.1
    const newConfidence = Math.max(0, page.confidence - 0.1);
    await db.update(wikiPages)
      .set({ confidence: newConfidence })
      .where(eq(wikiPages.id, page.id));

    await db.insert(wikiOpsLog).values({
      org_id: orgId,
      operation: 'lint',
      page_id: page.id,
      details: {
        issue: 'stale',
        message: `Page "${page.title}" is stale (90+ days, confidence ${page.confidence} → ${newConfidence})`,
      },
      performed_by: 'system',
    });
  }

  // 3. Decay — soft-delete pages with confidence < 0.3
  const decayedPages = await db.select({ id: wikiPages.id, title: wikiPages.title })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.is_deleted, false),
      lt(wikiPages.confidence, 0.3),
    ));

  for (const page of decayedPages) {
    decayed++;
    await db.update(wikiPages)
      .set({ is_deleted: true })
      .where(eq(wikiPages.id, page.id));

    await db.insert(wikiOpsLog).values({
      org_id: orgId,
      operation: 'lint',
      page_id: page.id,
      details: {
        issue: 'decayed',
        message: `Page "${page.title}" soft-deleted due to confidence below 0.3`,
      },
      performed_by: 'system',
    });
  }

  // 4. Flag low-confidence pages (0.3 - 0.5) for review
  const lowConfPages = await db.select({ id: wikiPages.id, title: wikiPages.title, confidence: wikiPages.confidence })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.is_deleted, false),
      lt(wikiPages.confidence, 0.5),
      sql`${wikiPages.confidence} >= 0.3`,
    ));

  for (const page of lowConfPages) {
    lowConfidence++;
    await db.insert(wikiOpsLog).values({
      org_id: orgId,
      operation: 'lint',
      page_id: page.id,
      details: {
        issue: 'low_confidence',
        message: `Page "${page.title}" has low confidence (${page.confidence}) — consider reviewing`,
      },
      performed_by: 'system',
    });
  }

  // 5. Contradiction detection — compare linked pages for conflicting claims
  try {
    // Get pages that are linked to each other
    const linkedPairs = await db.execute(sql`
      SELECT
        wp1.id as page1_id, wp1.title as page1_title, wp1.slug as page1_slug,
        wp1.content as page1_content,
        wp2.id as page2_id, wp2.title as page2_title, wp2.slug as page2_slug,
        wp2.content as page2_content
      FROM wiki_links wl
      JOIN wiki_pages wp1 ON wl.source_page_id = wp1.id AND wp1.is_deleted = false
      JOIN wiki_pages wp2 ON wl.target_page_id = wp2.id AND wp2.is_deleted = false
      WHERE wl.org_id = ${orgId}
      LIMIT 20
    `);

    const pairs = ((linkedPairs as any).rows ?? linkedPairs) as any[];
    if (Array.isArray(pairs) && pairs.length > 0) {
      // Batch pairs into groups of 5 for a single LLM call
      const batchSize = Math.min(pairs.length, 5);
      const batch = pairs.slice(0, batchSize);

      const pairDescriptions = batch.map((p: any, i: number) =>
        `Pair ${i + 1}:\n  Page A: "${p.page1_title}" — ${(p.page1_content as string).slice(0, 300)}\n  Page B: "${p.page2_title}" — ${(p.page2_content as string).slice(0, 300)}`
      ).join('\n\n');

      const prompt = `You are a wiki consistency checker. Review these linked wiki page pairs and identify any CONTRADICTIONS — where one page makes a claim that conflicts with another.

${pairDescriptions}

Rules:
- Only flag genuine contradictions (one says X, another says not-X or something incompatible).
- Differences in scope or detail are NOT contradictions.
- Return ONLY valid JSON array (no markdown fencing).
- Each item: {"pair": 1, "page_a": "slug", "page_b": "slug", "description": "what contradicts"}
- Return [] if no contradictions found.`;

      const response = await llm({
        task: 'extract',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 400,
      });

      const text = response.text.trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const found: { pair: number; page_a: string; page_b: string; description: string }[] = JSON.parse(jsonMatch[0]);
        for (const c of found) {
          const pair = batch[c.pair - 1];
          if (!pair) continue;
          contradictions++;
          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'contradiction',
            page_id: pair.page1_id,
            details: {
              issue: 'contradiction',
              page_a: { id: pair.page1_id, title: pair.page1_title, slug: pair.page1_slug },
              page_b: { id: pair.page2_id, title: pair.page2_title, slug: pair.page2_slug },
              description: c.description,
            },
            performed_by: 'system',
          });
        }
      }
    }
  } catch (err) {
    console.warn('[wiki-lint] Contradiction detection failed:', (err as Error).message);
  }

  return { orphaned, stale, decayed, lowConfidence, contradictions };
}
