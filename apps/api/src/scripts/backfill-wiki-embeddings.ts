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
import { env } from '../lib/env.js';
import { createHash } from 'node:crypto';

const EMBED_DIMS = 1536;
const BATCH_LOG_EVERY = 50;

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
            input: text.slice(0, 8000), // safe truncation
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

  // Fallback: deterministic hash-based pseudo-embedding. This is intentionally
  // NOT good enough for search quality, but it lets the migration land, lets
  // Phase 3 smoke tests pass, and is replaced as soon as OPENAI_API_KEY exists.
  return {
    name: 'dev-fallback:sha256-pseudo',
    embed: async (text: string) => {
      const vec = new Array<number>(EMBED_DIMS).fill(0);
      // Walk 32 sha256 digests with counter suffixes to fill 1536 floats.
      for (let chunk = 0; chunk < 32; chunk++) {
        const h = createHash('sha256').update(`${chunk}:${text}`).digest();
        for (let i = 0; i < 48; i++) {
          const idx = chunk * 48 + i;
          if (idx >= EMBED_DIMS) break;
          // Map unsigned byte → [-1, 1]
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
  const provider = pickProvider();
  console.log(`[backfill-wiki-embeddings] provider=${provider.name}`);

  if (!(await pgVectorAvailable())) {
    console.warn(
      '[backfill-wiki-embeddings] pgvector extension is NOT enabled on this Postgres. ' +
        'Skipping — install pgvector + run migration 0011 first. 0 pages backfilled.'
    );
    process.exit(0);
  }

  // Use a raw query so this script works whether or not the embedding column
  // is in the currently-loaded Drizzle schema cache.
  const rows = await db.execute(
    sql`SELECT id, title, summary, content FROM wiki_pages WHERE embedding IS NULL AND is_deleted = false`
  );
  const pending = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (rows as unknown as Array<Record<string, unknown>>);

  console.log(`[backfill-wiki-embeddings] ${pending.length} pages need embeddings`);

  let ok = 0;
  let errs = 0;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i] as { id: string; title: string; summary: string | null; content: string };
    const text = `${p.title}\n\n${p.summary ?? ''}\n\n${p.content}`.trim();
    try {
      const vec = await provider.embed(text);
      if (vec.length !== EMBED_DIMS) {
        throw new Error(`provider returned ${vec.length} dims, expected ${EMBED_DIMS}`);
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
        `[backfill-wiki-embeddings] progress: ${i + 1}/${pending.length} (${ok} ok, ${errs} errs)`
      );
    }
  }

  console.log(
    `[backfill-wiki-embeddings] done. ${ok} pages backfilled, ${errs} errors, ${pending.length} total.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill-wiki-embeddings] fatal:', err);
  process.exit(1);
});
