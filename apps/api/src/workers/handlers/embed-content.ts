import { logId } from '../../lib/log-metadata.js';
// Handler: embed-content — generates vector embeddings for wiki pages and tasks
// and writes to the pgvector column. Routes through lib/embed.ts so the
// provider is BYO-configurable per org.
import { db } from '../../lib/db.js';
import { sql } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { embed, EMBED_DIMS } from '../../lib/embed.js';

interface EmbedContentJobData {
  source_type: string;
  source_id: string;
}

export async function handleEmbedContent(job: JobData): Promise<void> {
  const data = job.data as Partial<EmbedContentJobData>;
  if (!data.source_type || !data.source_id) {
    console.warn(`[embed-content] job ${logId(job.id)} missing source_type or source_id — skipping`);
    return;
  }
  const { source_type, source_id } = data as EmbedContentJobData;

  if (source_type !== 'wiki_page' && source_type !== 'task') {
    console.warn(`[embed-content] Unknown source_type="<redacted>" (job ${logId(job.id)}) — skipping`
    );
    return;
  }

  if (source_type === 'task') {
    await embedTask(job, source_id);
    return;
  }

  // Fetch the wiki page (with org_id so embed() can pick the right provider).
  const rows = await db.execute(
    sql`SELECT id, org_id, title, summary, content
        FROM wiki_pages
        WHERE id = ${source_id}
          AND is_deleted = false
        LIMIT 1`,
  );
  const pending = (
    rows as unknown as { rows?: Array<Record<string, unknown>> }
  ).rows ?? (rows as unknown as Array<Record<string, unknown>>);

  if (!pending.length) {
    console.warn(`[embed-content] wiki_page ${logId(source_id)} not found or deleted — skipping (job ${logId(job.id)})`
    );
    return;
  }

  const page = pending[0] as {
    id: string;
    org_id: string;
    title: string;
    summary: string | null;
    content: string;
  };

  if (!page.content?.trim() && !page.summary?.trim()) {
    console.warn(`[embed-content] wiki_page ${logId(page.id)} has empty content+summary — embedding title only (job ${logId(job.id)})`);
  }

  const inputText = `${page.title}\n\n${page.summary ?? ''}\n\n${page.content}`.trim();

  // embed() throws on provider error → job retries automatically.
  // Returns null when the org has disabled embeddings or no key is set;
  // skip silently in that case.
  const embedding = await embed(inputText, page.org_id);
  if (!embedding) {
    console.warn(`[embed-content] embedding provider unavailable for org ${logId(page.org_id)} — skipping wiki_page ${logId(page.id)}`);
    return;
  }

  await writeEmbedding('wiki_pages', page.id, embedding);

  console.log(`[embed-content] wrote <redacted>-dim embedding for wiki_page ${logId(page.id)} (job ${logId(job.id)})`
  );
}

async function embedTask(job: JobData, source_id: string): Promise<void> {
  const rows = await db.execute(
    sql`SELECT id, org_id, title, description
        FROM tasks
        WHERE id = ${source_id}
          AND is_deleted = false
        LIMIT 1`,
  );
  const pending = (
    rows as unknown as { rows?: Array<Record<string, unknown>> }
  ).rows ?? (rows as unknown as Array<Record<string, unknown>>);

  if (!pending.length) {
    console.warn(`[embed-content] task ${logId(source_id)} not found or deleted — skipping (job ${logId(job.id)})`
    );
    return;
  }

  const task = pending[0] as {
    id: string;
    org_id: string;
    title: string;
    description: string | null;
  };

  if (!task.title?.trim() && !task.description?.trim()) {
    console.warn(`[embed-content] task ${logId(task.id)} has empty title+description — skipping (job ${logId(job.id)})`);
    return;
  }

  const inputText = `${task.title}\n${task.description ?? ''}`.trim();
  const embedding = await embed(inputText, task.org_id);
  if (!embedding) {
    console.warn(`[embed-content] embedding provider unavailable for org ${logId(task.org_id)} — skipping task ${logId(task.id)}`);
    return;
  }

  await writeEmbedding('tasks', task.id, embedding);

  console.log(`[embed-content] wrote <redacted>-dim embedding for task ${logId(task.id)} (job ${logId(job.id)})`
  );
}

// Write to a vector column, falling back to JSON BYTEA when the pgvector
// extension is not installed (dev environments + the test harness).
async function writeEmbedding(table: 'wiki_pages' | 'tasks', id: string, embedding: number[]): Promise<void> {
  const literal = `[${embedding.join(',')}]`;
  try {
    if (table === 'wiki_pages') {
      await db.execute(sql`UPDATE wiki_pages SET embedding = ${literal}::vector WHERE id = ${id}`);
    } else {
      await db.execute(sql`UPDATE tasks SET embedding = ${literal}::vector WHERE id = ${id}`);
    }
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? '';
    const cause = (err as { cause?: { code?: string } })?.cause;
    const isNoVector =
      msg.includes('type "vector" does not exist') || cause?.code === '42704';
    if (!isNoVector) throw err;

    const jsonBytes = Buffer.from(JSON.stringify(embedding));
    if (table === 'wiki_pages') {
      await db.execute(sql`UPDATE wiki_pages SET embedding = ${jsonBytes} WHERE id = ${id}`);
    } else {
      await db.execute(sql`UPDATE tasks SET embedding = ${jsonBytes} WHERE id = ${id}`);
    }
    console.warn("[embed-content] pgvector unavailable — wrote BYTEA fallback for <redacted>:<redacted>");
  }
}
