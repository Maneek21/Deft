// Handler: embed-content — generates vector embeddings for messages and tasks
import type { JobData } from '../types.js';

export async function handleEmbedContent(job: JobData): Promise<void> {
  console.log(`[embed-content] Generating embeddings (job ${job.id})`, job.data);
  // TODO: Generate vector embedding via API, upsert into pgvector
}
