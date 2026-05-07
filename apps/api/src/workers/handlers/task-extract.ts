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
  tasks,
  taskComments,
} from '@deft/db/schema';
import { eq, and, sql, gte } from 'drizzle-orm';
import { getOrgAIConfig, hasAnyAIProvider } from '../../lib/org-ai-config.js';
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

  // BYOK — fall back to env when org hasn't configured a key, but require at
  // least one provider somewhere before we do real LLM work.
  if (!(await hasAnyAIProvider(orgId))) {
    console.warn('[task-extract] No AI provider configured (org or env), skipping extraction');
    return;
  }

  try {
    const { llm } = await import('../../lib/llm.js');
    const orgConfig = await getOrgAIConfig(orgId);

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
      orgConfig,
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

    // Task 3.11 — if the suggestion is auto-accepted (future: autonomous
    // trust level), the created task should carry an agent-authored
    // comment explaining which message it came from. Auto-accept is not
    // wired yet (trust-level gating lands later), so this branch is
    // guarded behind `autoAccepted` which is always false today. When
    // the autonomous-trust code path lands, it should set this flag and
    // pass the new task's id in via `createdTaskId`.
    const autoAccepted = false;
    const createdTaskId: string | null = null;
    if (autoAccepted && createdTaskId) {
      await postAutoAcceptedExtractComment({
        orgId,
        taskId: createdTaskId,
        messageId,
        spaceId,
      });
      console.log(
        `[task-extract] Auto-accepted task created from message ${messageId}`,
      );
      return;
    }

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

// Task 3.11 — when an extraction is auto-accepted (autonomous trust path,
// not yet wired up), drop a proactive agent-authored comment on the new
// task explaining which chat message it came from. Uses the first active
// `event:task-extract` employee in the org as the author (their shadow
// user_id); silently no-ops if no such employee exists. Dedups within 7d
// on the (task_id, agent_user_id) pair so replayed jobs do not spam.
const AUTO_ACCEPT_COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function postAutoAcceptedExtractComment(params: {
  orgId: string;
  taskId: string;
  messageId: string;
  spaceId: string;
}): Promise<void> {
  const { orgId, taskId, messageId, spaceId } = params;
  try {
    const employee = await findTaskExtractEmployee(orgId);
    if (!employee) return;

    // Confirm the task exists + belongs to the org (defense in depth —
    // taskComments.task_id FK would catch ghosts but we want a clear log).
    const [taskRow] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
      .limit(1);
    if (!taskRow) return;

    const since = new Date(Date.now() - AUTO_ACCEPT_COMMENT_WINDOW_MS);
    const existing = await db
      .select({ id: taskComments.id })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.task_id, taskId),
          eq(taskComments.user_id, employee.user_id),
          eq(taskComments.is_deleted, false),
          gte(taskComments.created_at, since),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    const body =
      `Auto-created this task from a message in #${spaceId} ` +
      `(message id ${messageId}). Review and adjust if I got the details wrong.`;

    await db.insert(taskComments).values({
      org_id: orgId,
      task_id: taskId,
      user_id: employee.user_id,
      content: body,
    });
  } catch (err) {
    console.error(
      `[task-extract] Failed to post auto-accept comment on task ${params.taskId}:`,
      (err as Error).message,
    );
  }
}
