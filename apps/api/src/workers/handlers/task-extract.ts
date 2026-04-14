// Handler: task-extract — uses Claude Haiku to extract task fields from a message
// and sends a suggestion notification to the message author.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentEmployees,
  notifications,
  spaces,
  projectSpaces,
  projects,
} from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { env } from '../../lib/env.js';
import { emitToUser } from '../../socket.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { TriggerInvocation } from './employee-trigger.js';

const TASK_EXTRACT_TRIGGER_KIND = 'event:task-extract';

async function findTaskExtractEmployee(orgId: string) {
  const [row] = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        sql`${TASK_EXTRACT_TRIGGER_KIND} = ANY(${agentEmployees.trigger_subscriptions})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

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

  // Phase 6 branch: if an employee subscribes to `event:task-extract`,
  // hand the extraction off. The employee owns deciding whether to
  // suggest + with what fields via its own tool calls. The native
  // suggestion path below stays as the fallback for unsubscribed orgs.
  const subscribed = await findTaskExtractEmployee(orgId);
  if (subscribed) {
    const invocation: TriggerInvocation = {
      employee_id: subscribed.id,
      trigger_kind: TASK_EXTRACT_TRIGGER_KIND,
      context: {
        message_id: messageId,
        space_id: spaceId,
        author_user_id: userId,
        classification,
        message_preview: content.replace(/<[^>]+>/g, '').slice(0, 500),
      },
      goal:
        'A new message looks actionable. Inspect it, decide whether to create a task, ' +
        'and call task_create (or suggest the user create one). Reference the message id in context.',
      target_space_id: spaceId,
    };
    await enqueue(
      QUEUE_NAMES.AGENT_JOBS,
      'employee-trigger',
      invocation as unknown as Record<string, unknown>,
    );
    console.log(
      `[task-extract] Routed event:task-extract to ${subscribed.slug} for message ${messageId}`,
    );
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
