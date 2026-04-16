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
import { env } from '../lib/env.js';
import { createHash } from 'node:crypto';

const EMBED_DIMS = 1536;
const BATCH_LOG_EVERY = 50;
const INTER_REQUEST_DELAY_MS = 0; // bump to e.g. 1000 if you see 429s

type EmbedFn = (text: string) => Promise<number[]>;

function pickProvider(): { name: string; embed: EmbedFn } {
  if (env.OPENAI_API_KEY) {
    return {
      name: 'openai:text-embedding-3-small',
      embed: async (text: string) => {
        const r = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: text.slice(0, 32000),
            dimensions: EMBED_DIMS,
          }),
        });
        if (!r.ok) {
          throw new Error(`OpenAI embeddings ${r.status}: ${await r.text()}`);
        }
        const json = (await r.json()) as { data: { embedding: number[] }[] };
        const embedding = json.data[0]?.embedding;
        if (!embedding) throw new Error('OpenAI response missing data[0].embedding');
        return embedding;
      },
    };
  }

  // Fallback: deterministic hash-based pseudo-embedding. Not good enough for
  // search quality, but lets the migration land and smoke tests pass until
  // OPENAI_API_KEY is wired up in prod.
  return {
    name: 'dev-fallback:sha256-pseudo',
    embed: async (text: string) => {
      const vec = new Array<number>(EMBED_DIMS).fill(0);
      for (let chunk = 0; chunk < 32; chunk++) {
        const h = createHash('sha256').update(`${chunk}:${text}`).digest();
        for (let i = 0; i < 48; i++) {
          const idx = chunk * 48 + i;
          if (idx >= EMBED_DIMS) break;
          vec[idx] = ((h[i % h.length] ?? 0) / 127.5) - 1;
        }
      }
      return vec;
    },
  };
}

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

  const provider = pickProvider();
  console.log(`[backfill-task-embeddings] provider=${provider.name}`);

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
    sql`SELECT id, title, description FROM tasks WHERE embedding IS NULL AND is_deleted = false`,
  );
  const pending = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (rows as unknown as Array<Record<string, unknown>>);

  console.log(`[backfill-task-embeddings] ${pending.length} tasks need embeddings`);

  let ok = 0;
  let errs = 0;
  for (let i = 0; i < pending.length; i++) {
    const t = pending[i] as { id: string; title: string; description: string | null };

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
      const vec = await provider.embed(text);
      if (vec.length !== EMBED_DIMS) {
        throw new Error(`provider returned ${vec.length} dims, expected ${EMBED_DIMS}`);
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
        `[backfill-task-embeddings] progress: ${i + 1}/${pending.length} (${ok} ok, ${errs} errs)`,
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
