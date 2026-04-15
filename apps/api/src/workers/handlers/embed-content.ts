// Handler: embed-content — generates vector embeddings for wiki pages and writes to pgvector column
import { db } from '../../lib/db.js';
import { sql } from 'drizzle-orm';
import type { JobData } from '../types.js';

const EMBED_DIMS = 1536;
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
// ~32k chars ≈ 8k tokens — safe input limit for text-embedding-3-small
const MAX_INPUT_CHARS = 32000;

interface EmbedContentJobData {
  source_type: string;
  source_id: string;
}

/**
 * Call OpenAI embeddings API with the given text.
 * Throws on non-OK response so BullMQ retries the job.
 */
async function embedText(text: string, apiKey: string): Promise<number[]> {
  const response = await globalThis.fetch(OPENAI_EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input: text.slice(0, MAX_INPUT_CHARS),
      dimensions: EMBED_DIMS,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embeddings ${response.status}: ${body}`);
  }

  const json = (await response.json()) as { data: { embedding: number[] }[] };
  const embedding = json.data[0]?.embedding;
  if (!embedding) {
    throw new Error('OpenAI embeddings response missing data[0].embedding');
  }
  if (embedding.length !== EMBED_DIMS) {
    throw new Error(
      `OpenAI returned ${embedding.length} dims, expected ${EMBED_DIMS}`,
    );
  }
  if (embedding.some((v) => !Number.isFinite(v))) {
    throw new Error('OpenAI embedding contains non-finite values');
  }
  return embedding;
}

export async function handleEmbedContent(job: JobData): Promise<void> {
  const data = job.data as Partial<EmbedContentJobData>;
  if (!data.source_type || !data.source_id) {
    console.warn(`[embed-content] job ${job.id} missing source_type or source_id — skipping`);
    return;
  }
  const { source_type, source_id } = data as EmbedContentJobData;

  if (source_type !== 'wiki_page') {
    console.warn(
      `[embed-content] Unknown source_type="${source_type}" (job ${job.id}) — skipping`,
    );
    return;
  }

  // Read OPENAI_API_KEY from process.env at call-time so test stubs work.
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    console.warn(
      `[embed-content] OPENAI_API_KEY is unset — skipping embedding for ${source_type}:${source_id}`,
    );
    return;
  }

  // Fetch the wiki page.
  const rows = await db.execute(
    sql`SELECT id, title, summary, content
        FROM wiki_pages
        WHERE id = ${source_id}
          AND is_deleted = false
        LIMIT 1`,
  );
  const pending = (
    rows as unknown as { rows?: Array<Record<string, unknown>> }
  ).rows ?? (rows as unknown as Array<Record<string, unknown>>);

  if (!pending.length) {
    console.warn(
      `[embed-content] wiki_page ${source_id} not found or deleted — skipping (job ${job.id})`,
    );
    return;
  }

  const page = pending[0] as {
    id: string;
    title: string;
    summary: string | null;
    content: string;
  };

  if (!page.content?.trim() && !page.summary?.trim()) {
    console.warn(`[embed-content] wiki_page ${page.id} has empty content+summary — embedding title only (job ${job.id})`);
  }

  const inputText = `${page.title}\n\n${page.summary ?? ''}\n\n${page.content}`.trim();

  // embedText throws on API error → job retries automatically.
  const embedding = await embedText(inputText, apiKey);

  // Write via raw SQL. Try pgvector first; fall back to BYTEA (dev environments
  // where the pgvector extension is not installed and the column is BYTEA).
  const literal = `[${embedding.join(',')}]`;
  let usedFallback = false;
  try {
    await db.execute(
      sql`UPDATE wiki_pages
          SET embedding = ${literal}::vector
          WHERE id = ${page.id}`,
    );
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? '';
    // Code 42704 = undefined_object (type "vector" does not exist).
    const cause = (err as { cause?: { code?: string } })?.cause;
    const isNoVector =
      msg.includes('type "vector" does not exist') ||
      cause?.code === '42704';
    if (!isNoVector) {
      // Unrelated DB error — let the job queue retry.
      throw err;
    }
    // pgvector not available — store JSON bytes so the row is non-null and
    // the handler is still considered successful. The value will be replaced
    // when migration 0011 is applied in a pgvector-enabled environment.
    usedFallback = true;
    const jsonBytes = Buffer.from(JSON.stringify(embedding));
    await db.execute(
      sql`UPDATE wiki_pages
          SET embedding = ${jsonBytes}
          WHERE id = ${page.id}`,
    );
  }

  console.log(
    `[embed-content] wrote ${EMBED_DIMS}-dim embedding for wiki_page ${page.id} (job ${job.id})${usedFallback ? ' [bytea-fallback: pgvector not available]' : ''}`,
  );
}
