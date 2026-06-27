import { and, eq, sql } from 'drizzle-orm';
import { agentActions, projects, projectSpaces, workIntents } from '@deft/db/schema';
import { db } from './db.js';
import { ensureDeftyEmployee } from './ensure-defty-membership.js';
import { toPlainText, truncatePlainText } from './plain-text.js';
import { resolveAssigneeWithMatches } from './resolve-assignee.js';

type ResolvedProject = { id: string; name: string };

async function resolveProjectForCapture(
  orgId: string,
  spaceId: string,
  projectName?: string | null,
): Promise<ResolvedProject | null> {
  const normalizedProjectName = projectName?.trim();
  if (normalizedProjectName) {
    const [proj] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(
        eq(projects.org_id, orgId),
        eq(projects.name, normalizedProjectName),
        eq(projects.is_archived, false),
        eq(projects.is_deleted, false),
      ))
      .limit(1);
    if (proj) return proj;
  }

  const [linked] = await db
    .select({ id: projectSpaces.project_id, name: projects.name })
    .from(projectSpaces)
    .innerJoin(projects, eq(projectSpaces.project_id, projects.id))
    .where(and(
      eq(projectSpaces.space_id, spaceId),
      eq(projects.org_id, orgId),
      eq(projects.is_archived, false),
      eq(projects.is_deleted, false),
    ))
    .limit(1);
  if (linked) return linked;

  const [anyProj] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(
      eq(projects.org_id, orgId),
      eq(projects.is_archived, false),
      eq(projects.is_deleted, false),
    ))
    .limit(1);
  return anyProj ?? null;
}

function buildFallbackTitle(content: string): string {
  const plainContent = toPlainText(content);
  const explicit = plainContent.match(
    /\b(?:create|add|make|open|track)\b.{0,40}\b(?:task|todo|ticket)\b\s*:?\s*(.+)$/i,
  );
  const candidate = (explicit?.[1]?.trim() || plainContent).replace(/[.!?]+$/g, '');
  return truncatePlainText(candidate.replace(/^please\s+/i, ''), 80) || 'Follow up from chat';
}

export async function queueDeftyCreateTaskCapture(params: {
  orgId: string;
  sourceUserId: string;
  spaceId: string;
  messageId: string;
  content: string;
  title?: string | null;
  description?: string | null;
  priority?: 'p0' | 'p1' | 'p2' | 'p3' | null;
  assigneeName?: string | null;
  projectName?: string | null;
  captureKind: 'task_candidate' | 'blocker_candidate';
  captureReason?: string | null;
  extraction?: 'llm' | 'deterministic' | 'classifier';
}): Promise<{ queued: boolean; actionId?: string; skippedReason?: string }> {
  const {
    orgId,
    sourceUserId,
    spaceId,
    messageId,
    content,
    title,
    description,
    priority,
    assigneeName,
    projectName,
    captureKind,
    captureReason,
    extraction = 'classifier',
  } = params;

  const plainContent = toPlainText(content);
  if (!plainContent) return { queued: false, skippedReason: 'empty_content' };

  const dedupeKey = `defty_capture:${captureKind}:task_create:${messageId}`;
  const legacyDedupeKey = `defty_capture:${captureKind}:create_task:${messageId}`;
  const [existingIntent] = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, orgId),
      eq(workIntents.dedupe_key, dedupeKey),
    ))
    .limit(1);
  if (existingIntent) {
    const [existingAction] = await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'defty_capture'),
        sql`${agentActions.params}->>'work_intent_id' = ${existingIntent.id}`,
      ))
      .limit(1);
    return { queued: false, actionId: existingAction?.id, skippedReason: 'duplicate' };
  }

  const [existing] = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, orgId),
      sql`${agentActions.action} IN ('create_task', 'task_create')`,
      sql`(
        ${agentActions.params}->>'dedupe_key' IN (${dedupeKey}, ${legacyDedupeKey})
        OR (
          ${agentActions.message_id} = ${messageId}
          AND COALESCE(${agentActions.params}->>'capture_kind', '') IN ('', 'task_candidate', 'blocker_candidate')
        )
      )`,
    ))
    .limit(1);
  if (existing) return { queued: false, actionId: existing.id, skippedReason: 'duplicate' };

  const project = await resolveProjectForCapture(orgId, spaceId, projectName);
  if (!project) return { queued: false, skippedReason: 'project_missing' };

  const defty = await ensureDeftyEmployee(orgId);
  const finalTitle = truncatePlainText(title || buildFallbackTitle(content), 80);
  let assigneeId: string | null = null;
  let resolvedAssigneeName = assigneeName || null;
  if (assigneeName?.trim()) {
    const resolved = await resolveAssigneeWithMatches(assigneeName, orgId);
    if (resolved.ok) {
      assigneeId = resolved.value.id;
      resolvedAssigneeName = resolved.value.name;
    }
  }

  const [action] = await db
    .insert(workIntents)
    .values({
      org_id: orgId,
      space_id: spaceId,
      source_message_id: messageId,
      source_user_id: sourceUserId,
      agent_employee_id: defty.employeeId,
      kind: captureKind,
      status: 'proposed',
      title: finalTitle,
      summary: description || plainContent,
      proposed_action: 'task_create',
      proposed_params: {
        title: finalTitle,
        description: description || plainContent,
        priority: priority || 'p2',
        project_id: project.id,
        space_id: spaceId,
        assignee_id: assigneeId,
        assignee_name: resolvedAssigneeName,
        project_name: project.name,
        source_message_id: messageId,
        source_space_id: spaceId,
        source_user_id: sourceUserId,
        capture_kind: captureKind,
        capture_reason: captureReason || null,
        extraction,
      },
      dedupe_key: dedupeKey,
      metadata: {
        extraction,
        legacy_dedupe_key: legacyDedupeKey,
      },
    })
    .onConflictDoNothing({
      target: [workIntents.org_id, workIntents.dedupe_key],
    })
    .returning({ id: workIntents.id });

  const intentId = action?.id;
  if (!intentId) return { queued: false, skippedReason: 'duplicate' };

  const [queuedAction] = await db
    .insert(agentActions)
    .values({
      org_id: orgId,
      user_id: defty.userId,
      agent_employee_id: defty.employeeId,
      conversation_id: spaceId,
      action: 'task_create',
      message_id: messageId,
      params: {
        caller_employee_slug: defty.slug,
        title: finalTitle,
        description: description || plainContent,
        priority: priority || 'p2',
        project_id: project.id,
        space_id: spaceId,
        assignee_id: assigneeId,
        assignee_name: resolvedAssigneeName,
        project_name: project.name,
        source_message_id: messageId,
        source_space_id: spaceId,
        source_user_id: sourceUserId,
        origin_message_id: messageId,
        origin_space_id: spaceId,
        origin_user_id: sourceUserId,
        capture_kind: captureKind,
        capture_reason: captureReason || null,
        policy_reason: captureReason || null,
        dedupe_key: dedupeKey,
        work_intent_id: intentId,
        work_intent_status: 'proposed',
        extraction,
        proposed_by: 'defty',
      } as any,
      approval_tier: 'quick',
      approval_status: 'pending',
      source: 'defty_capture',
    })
    .returning({ id: agentActions.id });

  return { queued: true, actionId: queuedAction?.id };
}
