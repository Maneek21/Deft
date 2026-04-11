// Handler: extract actionable tasks from messages
import type { JobData } from '../types.js';

export async function handleExtractTasks(job: JobData): Promise<void> {
  const { orgId, messageId, content } = job.data as {
    orgId: string;
    messageId: string;
    content: string;
  };

  console.log(`[extract-tasks] Analyzing message ${messageId} for actionable tasks`);

  // TODO: Implement task extraction
  // 1. Classify message with Haiku (actionable? entities? urgency?)
  // 2. If actionable, extract task title/description/assignee
  // 3. Create agent action for approval (quick-approve tier)
}
