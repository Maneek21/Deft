/**
 * Backfill pgvector embeddings for wiki_pages rows where embedding IS NULL.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/backfill-wiki-embeddings.ts
 *
 * Providers (in precedence order):
 *   1. OPENAI_API_KEY → OpenAI text-embedding-3-small (1536 dims — matches schema)
 *   2. VOYAGE_API_KEY → voyage-3-lite (1024 dims → padded to 1536)
 *   3. Fallback: deterministic hash-based pseudo-embedding (dev only)
 *
 * Anthropic does not ship an embeddings API as of the 2026-04 cutoff, which is
 * why embed-content.ts is a stub in the codebase. Phase 3 should wire a real
 * provider once an OPENAI_API_KEY is available in .env.
 *
 * The script exits 0 on completion, logs progress every 50 rows, and never
 * aborts on per-row errors (logs + continues).
 */
import { db } from '../lib/db.js';
import { wikiPages } from '@deft/db/schema';
import { sql, isNull, eq } from 'drizzle-orm';
import { embed, EMBED_DIMS } from '../lib/embed.js';

const BATCH_LOG_EVERY = 50;

async function pgVectorAvailable(): Promise<boolean> {
  try {
    const rows = await db.execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    );
    return (rows as unknown as { rowCount?: number }).rowCount
      ? ((rows as unknown as { rowCount: number }).rowCount ?? 0) > 0
      : Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log('[backfill] DRY RUN MODE — no changes will be written');
  }

  console.log('[backfill-wiki-embeddings] provider=org-config (lib/embed.ts) — falls back to env OPENAI_API_KEY');

  if (!(await pgVectorAvailable())) {
    console.warn(
      '[backfill-wiki-embeddings] pgvector extension is NOT enabled on this Postgres. ' +
        'Skipping — install pgvector + run migration 0011 first. 0 pages backfilled.'
    );
    process.exit(0);
  }

  // Per-org count of pages needing embeddings — shown in both dry-run and real-run.
  const orgCountResult = await db.execute(sql`
    SELECT org_id, COUNT(*)::int AS null_count
    FROM wiki_pages
    WHERE embedding IS NULL AND is_deleted = false
    GROUP BY org_id
  `);
  const orgCountRows = (orgCountResult as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (orgCountResult as unknown as Array<Record<string, unknown>>);
  for (const row of orgCountRows) {
    console.log(`[backfill] org=${row['org_id']}: ${row['null_count']} pages need embeddings`);
  }

  // Use a raw query so this script works whether or not the embedding column
  // is in the currently-loaded Drizzle schema cache.
  const rows = await db.execute(
    sql`SELECT id, org_id, title, summary, content FROM wiki_pages WHERE embedding IS NULL AND is_deleted = false`
  );
  const pending = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (rows as unknown as Array<Record<string, unknown>>);

  console.log(`[backfill-wiki-embeddings] ${pending.length} pages need embeddings`);

  let ok = 0;
  let errs = 0;
  let skipped = 0;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i] as { id: string; org_id: string; title: string; summary: string | null; content: string };

    if (isDryRun) {
      console.log(`[backfill-dry] would embed wiki_page ${p.id}`);
      ok++;
      if ((i + 1) % BATCH_LOG_EVERY === 0) {
        console.log(`[backfill-dry] progress: ${i + 1}/${pending.length}`);
      }
      continue;
    }

    const text = `${p.title}\n\n${p.summary ?? ''}\n\n${p.content}`.trim();
    try {
      const vec = await embed(text, p.org_id);
      if (!vec) {
        skipped++;
        if (skipped === 1) {
          console.warn(`[backfill-wiki-embeddings] org ${p.org_id} has no embedding provider configured — skipping its pages`);
        }
        continue;
      }
      const literal = `[${vec.join(',')}]`;
      await db.execute(
        sql`UPDATE wiki_pages SET embedding = ${literal}::vector WHERE id = ${p.id}`
      );
      ok++;
    } catch (err) {
      errs++;
      console.error(
        `[backfill-wiki-embeddings] page ${p.id} failed: ${(err as Error).message}`
      );
    }
    if ((i + 1) % BATCH_LOG_EVERY === 0) {
      console.log(
        `[backfill-wiki-embeddings] progress: ${i + 1}/${pending.length} (${ok} ok, ${errs} errs, ${skipped} skipped)`
      );
    }
  }

  if (isDryRun) {
    const orgCount = orgCountRows.length;
    console.log(
      `[backfill] DRY RUN — would have embedded ${pending.length} pages across ${orgCount} orgs (no changes made)`
    );
  } else {
    console.log(
      `[backfill-wiki-embeddings] done. ${ok} pages backfilled, ${skipped} skipped (no provider), ${errs} errors, ${pending.length} total.`
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-wiki-embeddings] fatal:', err);
  process.exit(1);
});
