// Handler: task-extract — uses Claude Haiku to extract task fields from a message
// and sends a suggestion notification to the message author.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { notifications, spaces, projectSpaces, projects } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { env } from '../../lib/env.js';
import { emitToUser } from '../../socket.js';

interface TaskExtractJobData {
  messageId: string;
  spaceId: string;
  content: string;
  orgId: string;
  userId: string;
  classification: {
    intent: string;
    confidence: number;
    entities: {
      assignee?: string;
      project?: string;
      due_date?: string;
    };
  };
}

interface ExtractedTask {
  title: string;
  description?: string;
  priority?: string;
  assignee_name?: string;
  project_name?: string;
  skip?: boolean;
}

const EXTRACTION_PROMPT = `You are a task extraction assistant. Extract a task from the user's chat message.
Return JSON only, no markdown fences.

Fields:
- title: A concise task title (under 80 chars)
- description: Optional longer description if the message has details
- priority: "p0" (urgent), "p1" (high), "p2" (medium/default), "p3" (low)
- assignee_name: Name of the person assigned (if mentioned), or null
- project_name: Name of the project (if mentioned), or null
- skip: true if the message is NOT a clear task or actionable item

Rules:
- If the message is clearly asking to do something, extract it as a task
- If the message is vague or just discussion, set skip: true
- Priority defaults to "p2" unless urgency is indicated
- Return ONLY valid JSON`;

export async function handleTaskExtract(job: JobData): Promise<void> {
  const { messageId, spaceId, content, orgId, userId, classification } = job.data as TaskExtractJobData;

  // Only process task_create or actionable intents
  if (classification.intent !== 'task_create' && classification.intent !== 'actionable') {
    return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    console.warn('[task-extract] No ANTHROPIC_API_KEY configured, skipping extraction');
    return;
  }

  try {
    const { llm } = await import('../../lib/llm.js');

    // Strip HTML for the LLM
    const plainContent = content.replace(/<[^>]+>/g, '');

    const response = await llm({
      task: 'extract',
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Message: ${plainContent}`,
        },
      ],
      maxTokens: 256,
    });

    const text = response.text;

    let extracted: ExtractedTask;
    try {
      extracted = JSON.parse(text);
    } catch {
      console.error('[task-extract] Failed to parse LLM response:', text);
      return;
    }

    if (extracted.skip) {
      console.log(`[task-extract] Skipped message ${messageId} — not a clear task`);
      return;
    }

    // Try to resolve a default project for the space
    let projectId: string | null = null;
    let projectName = extracted.project_name || null;

    if (projectName) {
      // Try to find by name
      const [proj] = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.org_id, orgId), eq(projects.name, projectName)))
        .limit(1);
      if (proj) projectId = proj.id;
    }

    if (!projectId) {
      // Fall back to the first project linked to this space
      const [linked] = await db
        .select({ project_id: projectSpaces.project_id, project_name: projects.name })
        .from(projectSpaces)
        .innerJoin(projects, eq(projectSpaces.project_id, projects.id))
        .where(eq(projectSpaces.space_id, spaceId))
        .limit(1);
      if (linked) {
        projectId = linked.project_id;
        projectName = linked.project_name;
      }
    }

    if (!projectId) {
      // Fall back to any project in the org
      const [anyProj] = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.org_id, orgId))
        .limit(1);
      if (anyProj) {
        projectId = anyProj.id;
        projectName = anyProj.name;
      }
    }

    if (!projectId) {
      console.warn('[task-extract] No project found for org', orgId);
      return;
    }

    const suggestion = {
      title: extracted.title,
      description: extracted.description || null,
      priority: extracted.priority || 'p2',
      assignee_name: extracted.assignee_name || classification.entities.assignee || null,
      project_id: projectId,
      project_name: projectName,
    };

    // Create a notification for the message author
    const [notification] = await db.insert(notifications).values({
      org_id: orgId,
      user_id: userId,
      type: 'agent_suggestion',
      title: `Create task: ${suggestion.title}?`,
      body: JSON.stringify(suggestion),
      link: `/chat?space=${spaceId}&message=${messageId}`,
      metadata: { action: 'create_task', ...suggestion },
    }).returning();

    // Emit real-time event
    emitToUser(userId, 'notification:new', notification);
    emitToUser(userId, 'agent:task_suggestion', {
      messageId,
      spaceId,
      suggestion,
    });

    console.log(`[task-extract] Suggested task "${suggestion.title}" for message ${messageId}`);
  } catch (err) {
    console.error('[task-extract] Extraction failed:', (err as Error).message);
  }
}
