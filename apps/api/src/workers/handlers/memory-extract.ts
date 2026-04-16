// Handler: memory-extract — extracts memorable facts and decisions from classified messages
// and stores them as wiki pages (LLM Wiki pattern).
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { wikiPages, wikiLinks, wikiCitations, wikiOpsLog, wikiPageVersions } from '@deft/db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { llm } from '../../lib/llm.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';

interface MemoryExtractJobData {
  messageId: string;
  spaceId: string;
  content: string;
  orgId: string;
  userId: string;
  facts: string[];
  decision: string | null;
}

interface WikiIngestResult {
  action: 'create' | 'update';
  slug?: string;        // for update: which page to update
  title?: string;       // for create: new page title
  type?: string;        // for create: page type
  content?: string;     // page content (full for create, appended text for update)
  summary?: string;     // one-liner summary
  related_slugs?: string[];
}

/**
 * Return true if the fact text looks like a commitment/pledge.
 * Uses a lightweight keyword heuristic — fast, no LLM round-trip needed.
 */
function isCommitmentFact(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\bwill\s+(do|fix|handle|address|look|follow|check|send|get|make|finish|complete|review|update|reach)\b/.test(lower) ||
    /\bcommitt?ed?\s+to\b/.test(lower) ||
    /\bagreed?\s+to\b/.test(lower) ||
    /\bpromised?\s+to\b/.test(lower) ||
    /\btaking\s+ownership\b/.test(lower) ||
    /\baction\s+item\b/.test(lower) ||
    /\bfollowing?\s+up\b/.test(lower) ||
    /\bresponsible\s+for\b/.test(lower) ||
    /\bowing\s+to\b/.test(lower)
  );
}

/**
 * Generate a kebab-case slug from a title.
 */
function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Ask Haiku whether to create a new wiki page or update an existing one.
 */
async function decideWikiAction(
  fact: string,
  isDecision: boolean,
  existingPages: { title: string; slug: string; summary: string | null; type: string }[],
): Promise<WikiIngestResult> {
  const pageList = existingPages.length > 0
    ? existingPages.map(p => `- "${p.title}" (slug: ${p.slug}, type: ${p.type})${p.summary ? ': ' + p.summary : ''}`).join('\n')
    : '(no existing pages)';

  const prompt = `You are a wiki knowledge manager. Given a new ${isDecision ? 'decision' : 'fact'} extracted from a team chat message, decide whether to UPDATE an existing wiki page or CREATE a new one.

New ${isDecision ? 'decision' : 'fact'}: "${fact}"

Existing wiki pages:
${pageList}

Rules:
- UPDATE if an existing page covers the same topic, entity, or concept. Return the slug of that page and the text to APPEND to it.
- CREATE if this is a genuinely new topic. Return a title, slug, type, full content, and summary.
- For type, choose from: concept, entity, decision, resource, procedure, preference, fact
- ${isDecision ? 'Decisions should use type "decision".' : 'Choose the most specific type that fits.'}
- For related_slugs, list slugs of existing pages that are related to this fact (0-3 max).
- Keep content concise but informative. Use markdown.
- Summary should be one sentence max.

Return ONLY valid JSON (no markdown fencing):
For UPDATE: {"action":"update","slug":"existing-slug","content":"Text to append","related_slugs":["slug1"]}
For CREATE: {"action":"create","title":"Page Title","slug":"page-slug","type":"fact","content":"Full content","summary":"One-liner","related_slugs":["slug1"]}`;

  try {
    const response = await llm({
      task: 'extract',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
    });

    // Parse JSON from response
    const text = response.text.trim();
    // Try to extract JSON even if wrapped in code fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[memory-extract] LLM returned non-JSON, falling back to create:', text.slice(0, 100));
      return fallbackCreate(fact, isDecision);
    }

    const result = JSON.parse(jsonMatch[0]) as WikiIngestResult;

    // Validate required fields
    if (result.action === 'create' && (!result.title || !result.content)) {
      return fallbackCreate(fact, isDecision);
    }
    if (result.action === 'update' && (!result.slug || !result.content)) {
      return fallbackCreate(fact, isDecision);
    }

    return result;
  } catch (err) {
    console.error('[memory-extract] LLM call failed, using fallback:', (err as Error).message);
    return fallbackCreate(fact, isDecision);
  }
}

/**
 * Fallback: create a simple wiki page without LLM assistance.
 */
function fallbackCreate(fact: string, isDecision: boolean): WikiIngestResult {
  const title = fact.length > 60 ? fact.slice(0, 57) + '...' : fact;
  return {
    action: 'create',
    title,
    slug: slugify(title),
    type: isDecision ? 'decision' : 'fact',
    content: fact,
    summary: fact.length > 100 ? fact.slice(0, 97) + '...' : fact,
    related_slugs: [],
  };
}

/**
 * Execute the wiki ingest: create or update a page based on the LLM decision.
 */
async function executeWikiIngest(
  result: WikiIngestResult,
  orgId: string,
  userId: string,
  messageId: string,
  extraTags: string[] = [],
  referencedUserIds: string[] = [],
): Promise<void> {
  if (result.action === 'update' && result.slug) {
    // Find the existing page
    const [existing] = await db.select()
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, result.slug), eq(wikiPages.is_deleted, false)))
      .limit(1);

    if (!existing) {
      // Page not found — fall back to create
      console.warn(`[memory-extract] Page "${result.slug}" not found for update, creating instead`);
      result.action = 'create';
      result.title = result.title || result.slug.replace(/-/g, ' ');
      result.type = result.type || 'fact';
      // Fall through to create logic below
    } else {
      // Append new content to existing page
      const updatedContent = existing.content + '\n\n' + result.content;
      await db.update(wikiPages).set({
        content: updatedContent,
        previous_content: existing.content,
        version: existing.version + 1,
      }).where(eq(wikiPages.id, existing.id));

      // Add citation
      await db.insert(wikiCitations).values({
        page_id: existing.id,
        source_type: 'message',
        source_id: messageId,
        excerpt: result.content!.slice(0, 200),
      });

      // Add new links
      if (result.related_slugs && result.related_slugs.length > 0) {
        await createLinksForPage(existing.id, orgId, result.related_slugs);
      }

      // Log
      await db.insert(wikiOpsLog).values({
        org_id: orgId,
        operation: 'update',
        page_id: existing.id,
        details: { source_message_id: messageId, appended_text: result.content!.slice(0, 200) },
        performed_by: 'system',
      });

      console.log(`[memory-extract] Updated wiki page "${existing.slug}" (v${existing.version + 1})`);

      // Enqueue embedding regeneration for the updated page.
      try {
        await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', { source_type: 'wiki_page', source_id: existing.id });
      } catch (err) {
        console.warn(`[memory-extract] failed to enqueue embed-content for wiki_page ${existing.id} (message ${messageId})`, err);
      }

      return;
    }
  }

  // CREATE a new page
  if (result.action === 'create') {
    let slug = result.slug || slugify(result.title || 'untitled');

    // Ensure unique slug
    const [existingSlug] = await db.select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug)))
      .limit(1);

    if (existingSlug) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    const validTypes = ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'] as const;
    const pageType = validTypes.includes(result.type as any) ? (result.type as typeof validTypes[number]) : 'fact';

    const [page] = await db.insert(wikiPages).values({
      org_id: orgId,
      scope: 'org',
      type: pageType,
      title: result.title || slug.replace(/-/g, ' '),
      slug,
      summary: result.summary || null,
      content: result.content || '',
      confidence: 0.9, // auto-extracted, slightly below human-created (1.0)
      tags: extraTags.length > 0 ? extraTags : [],
      referenced_user_ids: referencedUserIds.length > 0 ? referencedUserIds : [],
    }).returning();

    // Add citation
    await db.insert(wikiCitations).values({
      page_id: page!.id,
      source_type: 'message',
      source_id: messageId,
      excerpt: result.content!.slice(0, 200),
    });

    // Add links
    if (result.related_slugs && result.related_slugs.length > 0) {
      await createLinksForPage(page!.id, orgId, result.related_slugs);
    }

    // Log
    await db.insert(wikiOpsLog).values({
      org_id: orgId,
      operation: 'create',
      page_id: page!.id,
      details: { source_message_id: messageId, title: result.title, type: pageType },
      performed_by: 'system',
    });

    console.log(`[memory-extract] Created wiki page "${slug}" (type: ${pageType})`);

    // Enqueue embedding generation for the new page.
    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', { source_type: 'wiki_page', source_id: page!.id });
    } catch (err) {
      console.warn(`[memory-extract] failed to enqueue embed-content for wiki_page ${page!.id} (message ${messageId})`, err);
    }
  }
}

/**
 * Create wiki_links from a page to other pages by their slugs.
 */
async function createLinksForPage(pageId: string, orgId: string, slugs: string[]): Promise<void> {
  if (slugs.length === 0) return;

  const targetPages = await db.select({ id: wikiPages.id, slug: wikiPages.slug })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.is_deleted, false),
      inArray(wikiPages.slug, slugs),
    ));

  for (const target of targetPages) {
    if (target.id === pageId) continue; // no self-links
    await db.insert(wikiLinks).values({
      org_id: orgId,
      source_page_id: pageId,
      target_page_id: target.id,
    }).onConflictDoNothing();
  }
}

/**
 * Cascade ingest: after a wiki page is created/updated, find related pages
 * and update them to stay consistent. Uses full-text search to pre-filter,
 * then Haiku to decide what to update. (Karpathy LLM Wiki pattern)
 */
async function cascadeIngest(
  triggerPageSlug: string,
  newContent: string,
  orgId: string,
  messageId: string,
): Promise<void> {
  try {
    // Pre-filter: find top 20 candidate pages via full-text search
    const searchQuery = newContent.replace(/[^a-zA-Z0-9\s]/g, '').slice(0, 500);
    if (searchQuery.trim().length < 3) return;

    const candidates = await db.select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      summary: wikiPages.summary,
      content: wikiPages.content,
      version: wikiPages.version,
    })
      .from(wikiPages)
      .where(and(
        eq(wikiPages.org_id, orgId),
        eq(wikiPages.is_deleted, false),
        sql`${wikiPages.slug} != ${triggerPageSlug}`,
        sql`search_vector @@ plainto_tsquery('english', ${searchQuery})`,
      ))
      .orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${searchQuery})) DESC`)
      .limit(20);

    if (candidates.length === 0) return;

    // Ask Haiku which pages need updating
    const candidateList = candidates.map(p =>
      `- "${p.title}" (slug: ${p.slug}): ${p.summary || p.content.slice(0, 100)}`
    ).join('\n');

    const prompt = `You are a wiki knowledge manager performing cascade updates. A wiki page was just updated with new information. Your job: identify which OTHER existing pages should be updated to stay consistent.

New information added to "${triggerPageSlug}":
"${newContent.slice(0, 1000)}"

Candidate pages that might need updating:
${candidateList}

Rules:
- Only select pages that NEED updating to stay consistent with the new information.
- For each page, provide the TEXT TO APPEND (not a full rewrite).
- If no pages need updating, return an empty array.
- Be conservative — only update pages where the new info is clearly relevant.
- Max 3 pages per cascade.

Return ONLY valid JSON (no markdown fencing):
[{"slug":"page-slug","append_text":"Text to append to the page."}]
Return [] if no updates needed.`;

    const response = await llm({
      task: 'extract',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 600,
    });

    const text = response.text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const updates: { slug: string; append_text: string }[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(updates) || updates.length === 0) return;

    // Apply cascade updates (max 3)
    for (const update of updates.slice(0, 3)) {
      const page = candidates.find(c => c.slug === update.slug);
      if (!page || !update.append_text) continue;

      // Snapshot version before update
      await db.insert(wikiPageVersions).values({
        page_id: page.id,
        version: page.version,
        title: page.title,
        content: page.content,
        summary: page.summary,
        edited_by: 'system',
      }).onConflictDoNothing();

      // Append content
      await db.update(wikiPages).set({
        content: page.content + '\n\n' + update.append_text,
        previous_content: page.content,
        version: page.version + 1,
      }).where(eq(wikiPages.id, page.id));

      // Log the cascade
      await db.insert(wikiOpsLog).values({
        org_id: orgId,
        operation: 'cascade_update',
        page_id: page.id,
        details: { triggered_by: triggerPageSlug, appended_text: update.append_text.slice(0, 200) },
        performed_by: 'system',
      });

      console.log(`[cascade-ingest] Updated "${page.slug}" (triggered by "${triggerPageSlug}")`);

      // Enqueue embedding regeneration for the cascade-updated page.
      try {
        await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', { source_type: 'wiki_page', source_id: page.id });
      } catch (err) {
        console.warn(`[cascade-ingest] failed to enqueue embed-content for wiki_page ${page.id} (message ${messageId})`, err);
      }
    }
  } catch (err) {
    // Non-critical: cascade failure shouldn't block the main ingest
    console.warn('[cascade-ingest] Failed:', (err as Error).message);
  }
}

export async function handleMemoryExtract(job: JobData): Promise<void> {
  const { messageId, spaceId, content, orgId, userId, facts, decision } =
    job.data as MemoryExtractJobData;

  // Fetch existing wiki pages for context (lightweight: title, slug, summary, type)
  const existingPages = await db.select({
    title: wikiPages.title,
    slug: wikiPages.slug,
    summary: wikiPages.summary,
    type: wikiPages.type,
  })
    .from(wikiPages)
    .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.is_deleted, false)))
    .orderBy(desc(wikiPages.updated_at))
    .limit(50);

  // Process each fact through the wiki ingest pipeline
  const allItems: { text: string; isDecision: boolean }[] = [
    ...facts.map(f => ({ text: f, isDecision: false })),
  ];
  if (decision) {
    allItems.push({ text: decision, isDecision: true });
  }

  for (const item of allItems) {
    try {
      // LLM-powered wiki ingest
      const result = await decideWikiAction(item.text, item.isDecision, existingPages);

      // Determine tags and referenced_user_ids for commitment facts.
      const extraTags: string[] = isCommitmentFact(item.text) ? ['commitment'] : [];
      const referencedUserIds: string[] = isCommitmentFact(item.text) ? [userId] : [];

      await executeWikiIngest(result, orgId, userId, messageId, extraTags, referencedUserIds);

      // Cascade ingest: update related pages (Karpathy pattern)
      const triggerSlug = result.slug || (result.title ? slugify(result.title) : null);
      if (triggerSlug && result.content) {
        await cascadeIngest(triggerSlug, result.content, orgId, messageId);
      }

    } catch (err) {
      console.error(`[memory-extract] Failed to process "${item.text.slice(0, 50)}":`, (err as Error).message);
    }
  }

}
