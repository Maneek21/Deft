// Handler: generate embeddings for a message and store for vector search
import type { JobData } from '../types.js';

export async function handleIndexMessage(job: JobData): Promise<void> {
  const { orgId, messageId, content } = job.data as {
    orgId: string;
    messageId: string;
    content: string;
  };

  console.log(`[index-message] Generating embedding for message ${messageId}`);

  // TODO: Implement vector indexing
  // 1. Generate embedding via Anthropic or OpenAI embedding API
  // 2. Store in pgvector column on messages table (or a separate embeddings table)
}
