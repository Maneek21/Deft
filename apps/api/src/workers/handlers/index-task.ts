// Handler: generate embeddings for a task and store for vector search
import type { JobData } from '../types.js';

export async function handleIndexTask(job: JobData): Promise<void> {
  const { orgId, taskId, title, description } = job.data as {
    orgId: string;
    taskId: string;
    title: string;
    description?: string;
  };

  console.log(`[index-task] Generating embedding for task ${taskId}`);

  // TODO: Implement vector indexing
  // 1. Combine title + description into indexable text
  // 2. Generate embedding via Anthropic or OpenAI embedding API
  // 3. Store in pgvector column
}
