// One-time migration script: migrate agentMemory, spaceKnowledge, and decisions
// into wiki_pages. Run with: npx tsx apps/api/src/scripts/migrate-to-wiki.ts

import 'dotenv/config';
import { db } from '../lib/db.js';
import { agentMemory, spaceKnowledge, decisions, wikiPages, wikiCitations, wikiOpsLog } from '@deft/db/schema';
import { eq, and, ne } from 'drizzle-orm';

function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Track used slugs per org to avoid collisions within a migration run
const usedSlugs = new Map<string, Set<string>>();

function getUniqueSlug(orgId: string, baseSlug: string): string {
  if (!usedSlugs.has(orgId)) usedSlugs.set(orgId, new Set());
  const orgSlugs = usedSlugs.get(orgId)!;

  let slug = baseSlug || 'untitled';
  let counter = 0;
  while (orgSlugs.has(slug)) {
    counter++;
    slug = `${baseSlug}-${counter}`;
  }
  orgSlugs.add(slug);
  return slug;
}

async function migrateAgentMemory() {
  console.log('\n═══ Migrating agentMemory → wiki_pages ═══');

  // Only migrate org and user scoped memories (skip conversation-scoped — ephemeral)
  const memories = await db.select()
    .from(agentMemory)
    .where(ne(agentMemory.scope, 'conversation'));

  let created = 0;
  let skipped = 0;

  for (const mem of memories) {
    try {
      const isDecision = mem.key.startsWith('decision:');
      const cleanKey = isDecision ? mem.key.replace('decision:', '') : mem.key;
      const title = mem.value.length > 80 ? mem.value.slice(0, 77) + '...' : mem.value;
      const slug = getUniqueSlug(mem.org_id, slugify(cleanKey || title));

      // Determine type
      let pageType: 'decision' | 'preference' | 'fact' = 'fact';
      if (isDecision) pageType = 'decision';
      else if (mem.key.includes('prefer') || mem.key.includes('preference')) pageType = 'preference';

      // Check if slug already exists in DB (from a prior migration run)
      const [existing] = await db.select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, mem.org_id), eq(wikiPages.slug, slug)))
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      await db.insert(wikiPages).values({
        org_id: mem.org_id,
        scope: mem.scope === 'user' ? 'user' : 'org',
        user_id: mem.scope === 'user' ? mem.user_id : null,
        type: pageType,
        title,
        slug,
        summary: mem.value.length > 100 ? mem.value.slice(0, 97) + '...' : mem.value,
        content: mem.value,
        confidence: 0.8, // migrated data, not freshly verified
      });

      created++;
    } catch (err) {
      console.error(`  Failed to migrate memory "${mem.key}":`, (err as Error).message);
    }
  }

  console.log(`  Migrated: ${created} pages created, ${skipped} skipped (already exist)`);
}

async function migrateSpaceKnowledge() {
  console.log('\n═══ Migrating spaceKnowledge → wiki_pages ═══');

  const entries = await db.select()
    .from(spaceKnowledge)
    .where(eq(spaceKnowledge.is_deleted, false));

  let created = 0;
  let skipped = 0;

  // Type mapping
  const typeMap: Record<string, string> = {
    decision: 'decision',
    resource: 'resource',
    action_item: 'procedure',
    note: 'fact',
  };

  for (const entry of entries) {
    try {
      const slug = getUniqueSlug(entry.org_id, slugify(entry.title));
      const pageType = (typeMap[entry.type] || 'fact') as any;

      // Check if already exists
      const [existing] = await db.select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, entry.org_id), eq(wikiPages.slug, slug)))
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      const [page] = await db.insert(wikiPages).values({
        org_id: entry.org_id,
        scope: 'space',
        space_id: entry.space_id,
        type: pageType,
        title: entry.title,
        slug,
        summary: entry.content ? (entry.content.length > 100 ? entry.content.slice(0, 97) + '...' : entry.content) : null,
        content: entry.content || entry.title,
        confidence: 1.0, // human-created
      }).returning();

      // Create citation if source message exists
      if (entry.source_message_id && page) {
        await db.insert(wikiCitations).values({
          page_id: page.id,
          source_type: 'knowledge_entry',
          source_id: entry.id,
          excerpt: entry.content?.slice(0, 200) || null,
        });
      }

      created++;
    } catch (err) {
      console.error(`  Failed to migrate knowledge "${entry.title}":`, (err as Error).message);
    }
  }

  console.log(`  Migrated: ${created} pages created, ${skipped} skipped (already exist)`);
}

async function migrateDecisions() {
  console.log('\n═══ Migrating decisions → wiki_pages ═══');

  const allDecisions = await db.select().from(decisions);

  let created = 0;
  let merged = 0;
  let skipped = 0;

  for (const dec of allDecisions) {
    try {
      const title = dec.is_reversed
        ? `REVERSED: ${dec.decision_text.slice(0, 70)}`
        : dec.decision_text.length > 80
          ? dec.decision_text.slice(0, 77) + '...'
          : dec.decision_text;

      const slug = slugify(title);

      // Check if a wiki page already exists with similar slug (from agentMemory migration)
      const [existing] = await db.select()
        .from(wikiPages)
        .where(and(eq(wikiPages.org_id, dec.org_id), eq(wikiPages.slug, slug)))
        .limit(1);

      if (existing) {
        // Merge: append context to existing page
        if (dec.context && !existing.content.includes(dec.context.slice(0, 50))) {
          const updatedContent = existing.content + '\n\n**Context:** ' + dec.context;
          await db.update(wikiPages).set({
            content: updatedContent,
            previous_content: existing.content,
            version: existing.version + 1,
          }).where(eq(wikiPages.id, existing.id));
          merged++;
        } else {
          skipped++;
        }
        continue;
      }

      const uniqueSlug = getUniqueSlug(dec.org_id, slug);

      let content = dec.decision_text;
      if (dec.context) {
        content += '\n\n**Context:** ' + dec.context;
      }
      if (dec.is_reversed) {
        content = '> **This decision has been reversed.**\n\n' + content;
      }

      const [page] = await db.insert(wikiPages).values({
        org_id: dec.org_id,
        scope: dec.space_id ? 'space' : 'org',
        space_id: dec.space_id || null,
        type: 'decision',
        title,
        slug: uniqueSlug,
        summary: dec.decision_text.length > 100 ? dec.decision_text.slice(0, 97) + '...' : dec.decision_text,
        content,
        confidence: dec.is_reversed ? 0.2 : 0.9,
      }).returning();

      // Citation back to message
      if (dec.message_id && page) {
        await db.insert(wikiCitations).values({
          page_id: page.id,
          source_type: 'message',
          source_id: dec.message_id,
          excerpt: dec.decision_text.slice(0, 200),
        });
      }

      created++;
    } catch (err) {
      console.error(`  Failed to migrate decision:`, (err as Error).message);
    }
  }

  console.log(`  Migrated: ${created} created, ${merged} merged into existing, ${skipped} skipped`);
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Deft: Wiki Migration Script          ║');
  console.log('╚════════════════════════════════════════╝');

  await migrateAgentMemory();
  await migrateSpaceKnowledge();
  await migrateDecisions();

  // Log the migration in wiki_ops_log
  // We need at least one org_id — get all unique orgs
  const orgPages = await db.select({ org_id: wikiPages.org_id })
    .from(wikiPages)
    .groupBy(wikiPages.org_id);

  for (const { org_id } of orgPages) {
    await db.insert(wikiOpsLog).values({
      org_id,
      operation: 'merge',
      details: { migration: 'legacy-to-wiki', source_tables: ['agent_memory', 'space_knowledge', 'decisions'] },
      performed_by: 'system',
    });
  }

  console.log('\n✓ Migration complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
