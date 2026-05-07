/**
 * Task 3.8 — Backfill pgvector embeddings for tasks rows where embedding IS NULL.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/backfill-task-embeddings.ts
 *
 * Mirrors backfill-wiki-embeddings.ts. Providers, in precedence order:
 *   1. OPENAI_API_KEY → OpenAI text-embedding-3-small (1536 dims — matches schema)
 *   2. Fallback: deterministic hash-based pseudo-embedding (dev only)
 *
 * The script exits 0 on completion, logs progress every 50 rows, and never
 * aborts on per-row errors (logs + continues). Accepts `--dry-run` to preview
 * what would be embedded without writing.
 *
 * Rate-limit handling: the OpenAI tier limits are generous enough that a simple
 * sequential walk with per-row await suffices. Add a small delay between calls
 * only if you see 429s in the logs.
 */
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';
import { embed, EMBED_DIMS } from '../lib/embed.js';

const BATCH_LOG_EVERY = 50;
const INTER_REQUEST_DELAY_MS = 0; // bump to e.g. 1000 if you see 429s

async function pgVectorAvailable(): Promise<boolean> {
  try {
    const rows = await db.execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
    );
    return (rows as unknown as { rowCount?: number }).rowCount
      ? ((rows as unknown as { rowCount: number }).rowCount ?? 0) > 0
      : Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log('[backfill-task-embeddings] DRY RUN MODE — no changes will be written');
  }

  console.log('[backfill-task-embeddings] provider=org-config (lib/embed.ts) — falls back to env OPENAI_API_KEY');

  if (!(await pgVectorAvailable())) {
    console.warn(
      '[backfill-task-embeddings] pgvector extension is NOT enabled. ' +
        'Skipping — install pgvector + run migration 0033 first. 0 tasks backfilled.',
    );
    process.exit(0);
  }

  // Per-org count of tasks needing embeddings.
  const orgCountResult = await db.execute(sql`
    SELECT org_id, COUNT(*)::int AS null_count
    FROM tasks
    WHERE embedding IS NULL AND is_deleted = false
    GROUP BY org_id
  `);
  const orgCountRows = (orgCountResult as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (orgCountResult as unknown as Array<Record<string, unknown>>);
  for (const row of orgCountRows) {
    console.log(`[backfill-task-embeddings] org=${row['org_id']}: ${row['null_count']} tasks need embeddings`);
  }

  // Use a raw query so this script works whether or not the embedding column
  // is in the currently-loaded Drizzle schema cache.
  const rows = await db.execute(
    sql`SELECT id, org_id, title, description FROM tasks WHERE embedding IS NULL AND is_deleted = false`,
  );
  const pending = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (rows as unknown as Array<Record<string, unknown>>);

  console.log(`[backfill-task-embeddings] ${pending.length} tasks need embeddings`);

  let ok = 0;
  let errs = 0;
  let skipped = 0;
  for (let i = 0; i < pending.length; i++) {
    const t = pending[i] as { id: string; org_id: string; title: string; description: string | null };

    if (isDryRun) {
      console.log(`[backfill-task-embeddings-dry] would embed task ${t.id}`);
      ok++;
      if ((i + 1) % BATCH_LOG_EVERY === 0) {
        console.log(`[backfill-task-embeddings-dry] progress: ${i + 1}/${pending.length}`);
      }
      continue;
    }

    const text = `${t.title}\n${t.description ?? ''}`.trim();
    if (!text) {
      // Skip empty rows — embedding a blank string is meaningless.
      continue;
    }

    try {
      const vec = await embed(text, t.org_id);
      if (!vec) {
        skipped++;
        continue;
      }
      const literal = `[${vec.join(',')}]`;
      await db.execute(
        sql`UPDATE tasks SET embedding = ${literal}::vector WHERE id = ${t.id}`,
      );
      ok++;
    } catch (err) {
      errs++;
      console.error(
        `[backfill-task-embeddings] task ${t.id} failed: ${(err as Error).message}`,
      );
    }

    if (INTER_REQUEST_DELAY_MS > 0) await sleep(INTER_REQUEST_DELAY_MS);

    if ((i + 1) % BATCH_LOG_EVERY === 0) {
      console.log(
        `[backfill-task-embeddings] progress: ${i + 1}/${pending.length} (${ok} ok, ${errs} errs, ${skipped} skipped)`,
      );
    }
  }

  if (isDryRun) {
    const orgCount = orgCountRows.length;
    console.log(
      `[backfill-task-embeddings] DRY RUN — would have embedded ${pending.length} tasks across ${orgCount} orgs (no changes made)`,
    );
  } else {
    console.log(
      `[backfill-task-embeddings] done. ${ok} tasks backfilled, ${errs} errors, ${pending.length} total.`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-task-embeddings] fatal:', err);
  process.exit(1);
});
