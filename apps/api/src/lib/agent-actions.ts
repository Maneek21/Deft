import { db } from './db.js';
import {
  tasks,
  projects,
  messages,
  spaces,
  agentActions,
  taskActivity,
  users,
  spaceKnowledge,
  wikiPages,
  wikiLinks,
  wikiOpsLog,
  mcpConnections,
} from '@deft/db/schema';
import { eq, and, sql, ilike, desc } from 'drizzle-orm';
import { getIO } from '../socket.js';
import { logAuditEvent } from './audit.js';
import { mcpClientManager } from '@deft/mcp';
import { parseMCPToolName, toConnectionConfig } from './mcp-tools.js';
import { resolveAssigneeWithMatches } from './resolve-assignee.js';

const AGENT_EMAIL = 'deft-agent@system.local';

export async function ensureAgentUser(): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, AGENT_EMAIL))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({ email: AGENT_EMAIL, name: 'Deft', email_verified: true })
    .returning();
  return created!.id;
}

export async function executeAction(
  actionId: string,
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
  options?: {
    /**
     * Task 3.3 — when set, every task_activity row written by this call
     * is attributed back to the specific agent employee that acted.
     */
    agentEmployeeId?: string;
  },
): Promise<{ success: boolean; result: any; error?: string }> {
  const agentEmployeeId = options?.agentEmployeeId ?? null;
  try {
    // MCP tool execution — handle before the native action switch
    if (action.startsWith('mcp__')) {
      const { connectionSlug, toolName } = parseMCPToolName(action);
      const [conn] = await db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.org_id, orgId), eq(mcpConnections.slug, connectionSlug)))
        .limit(1);
      if (!conn) {
        return { success: false, result: null, error: `MCP connection '${connectionSlug}' not found` };
      }
      const config = toConnectionConfig(conn);
      const mcpResult = await mcpClientManager.executeTool(config, toolName, params);
      if (!mcpResult.success) {
        return { success: false, result: null, error: mcpResult.error || 'MCP tool error' };
      }
      // Update the action record with result
      await db.update(agentActions).set({
        executed_at: new Date(),
        result: mcpResult.content as any,
      }).where(eq(agentActions.id, actionId));
      return { success: true, result: mcpResult.content };
    }

    switch (action) {
      case 'create_task': {
        const [project] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.org_id, orgId), ilike(projects.name, `%${params.project_name}%`)))
          .limit(1);
        if (!project) return { success: false, result: null, error: 'Project not found' };

        let assigneeId: string | null = null;
        if (params.assignee_name) {
          const resolved = await resolveAssigneeWithMatches(params.assignee_name, orgId);
          if (!resolved.ok) {
            if (resolved.ambiguous) {
              return {
                success: false,
                result: null,
                error: `Ambiguous name "${params.assignee_name}". Matches: ${resolved.matches.map((m) => m.name).join(', ')}`,
              };
            }
            // Non-ambiguous miss: leave assignee null (matches legacy behavior).
          } else {
            assigneeId = resolved.value.id;
          }
        }

        // Smart priority detection if not explicitly set
        let priority = params.priority || 'p2';
        if (!params.priority) {
          const lowerContent = (params.description || params.title || '').toLowerCase();
          if (lowerContent.match(/\b(urgent|asap|critical|blocker|emergency|p0)\b/)) {
            priority = 'p0';
          } else if (lowerContent.match(/\b(important|high priority|p1|needs attention|blocking)\b/)) {
            priority = 'p1';
          } else if (lowerContent.match(/\b(low priority|nice to have|when possible|p3|minor)\b/)) {
            priority = 'p3';
          }
        }

        const [upd] = await db
          .update(projects)
          .set({ task_counter: sql`${projects.task_counter} + 1` })
          .where(eq(projects.id, project.id))
          .returning({ task_counter: projects.task_counter });

        const [task] = await db
          .insert(tasks)
          .values({
            org_id: orgId,
            project_id: project.id,
            number: upd!.task_counter,
            title: params.title,
            description: params.description || null,
            status: 'backlog',
            priority,
            assignee_id: assigneeId,
            created_by: userId,
            due_date: params.due_date ? new Date(params.due_date) : null,
            // Task 3.2 — if the agent was invoked by a message, link the
            // created task back to it so the UI can show "from chat".
            source_message_id: params.source_message_id || null,
          })
          .returning();

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: task!.id,
          user_id: userId,
          action: 'created',
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: task!.id, number: task!.number, prefix: project.prefix },
            before_state: null,
            after_state: {
              id: task!.id,
              title: task!.title,
              status: task!.status,
              priority: task!.priority,
              assignee_id: task!.assignee_id,
              project_id: task!.project_id,
              number: task!.number,
            },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:created', {
            ...task,
            project_prefix: project.prefix,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'create_task',
          entityType: 'task',
          entityId: task!.id,
          beforeState: null,
          afterState: {
            id: task!.id,
            title: task!.title,
            status: task!.status,
            priority: task!.priority,
            assignee_id: task!.assignee_id,
          },
          metadata: { action_id: actionId, project: project.prefix },
        });

        return {
          success: true,
          result: {
            task_id: task!.id,
            identifier: `${project.prefix}-${task!.number}`,
            title: params.title,
          },
        };
      }

      case 'update_task_status': {
        let taskId = params.task_identifier as string;
        const m = taskId.match(/^([A-Z]+)-(\d+)$/);
        if (m) {
          const [proj] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.org_id, orgId), eq(projects.prefix, m[1]!)))
            .limit(1);
          if (proj) {
            const [f] = await db
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(m[2]!))))
              .limit(1);
            if (f) taskId = f.id;
          }
        }

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
          .limit(1);
        if (!existing) return { success: false, result: null, error: 'Task not found' };

        const oldStatus = existing.status;
        await db.update(tasks).set({ status: params.new_status }).where(eq(tasks.id, taskId));

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'status_changed',
          field: 'status',
          old_value: oldStatus,
          new_value: params.new_status,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId },
            before_state: { status: oldStatus, task_id: taskId },
            after_state: { status: params.new_status, task_id: taskId },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        // Post system message in linked spaces
        try {
          const { projectSpaces, messages: msgTable, users: usersTable } = await import('@deft/db/schema');
          const linkedSpaces = await db.select({ space_id: projectSpaces.space_id })
            .from(projectSpaces)
            .where(eq(projectSpaces.project_id, existing.project_id));

          if (linkedSpaces.length > 0) {
            // Get project prefix
            const [proj] = await db.select({ prefix: projects.prefix }).from(projects)
              .where(eq(projects.id, existing.project_id)).limit(1);
            const [actor] = await db.select({ name: usersTable.name }).from(usersTable)
              .where(eq(usersTable.id, userId)).limit(1);

            const statusLabels: Record<string, string> = {
              backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress',
              in_review: 'In Review', done: 'Done', cancelled: 'Cancelled',
            };
            const content = `\u2713 Deft moved ${proj?.prefix || ''}-${existing.number} to ${statusLabels[params.new_status] || params.new_status}`;

            for (const ls of linkedSpaces) {
              const [msg] = await db.insert(msgTable).values({
                org_id: orgId,
                space_id: ls.space_id,
                user_id: userId,
                content,
              }).returning();

              const io = getIO();
              if (io && msg) {
                io.to(`space:${ls.space_id}`).emit('message:new', {
                  ...msg, user_name: actor?.name || 'Deft', user_avatar: null,
                });
              }
            }
          }
        } catch (err) {
          console.error('Failed to post status change in chat:', err);
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'update_task_status',
          entityType: 'task',
          entityId: taskId,
          beforeState: { status: oldStatus },
          afterState: { status: params.new_status },
          metadata: { action_id: actionId },
        });

        return {
          success: true,
          result: { task_id: taskId, old_status: oldStatus, new_status: params.new_status },
        };
      }

      case 'assign_task': {
        let taskId = params.task_identifier as string;
        const m = taskId.match(/^([A-Z]+)-(\d+)$/);
        if (m) {
          const [proj] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.org_id, orgId), eq(projects.prefix, m[1]!)))
            .limit(1);
          if (proj) {
            const [f] = await db
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(m[2]!))))
              .limit(1);
            if (f) taskId = f.id;
          }
        }

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
          .limit(1);
        if (!existing) return { success: false, result: null, error: 'Task not found' };

        const resolved = await resolveAssigneeWithMatches(params.assignee_name, orgId);
        if (!resolved.ok) {
          if (resolved.ambiguous) {
            return {
              success: false,
              result: null,
              error: `Ambiguous name "${params.assignee_name}". Matches: ${resolved.matches.map((m) => m.name).join(', ')}`,
            };
          }
          return { success: false, result: null, error: `User "${params.assignee_name}" not found in this org` };
        }
        const newAssigneeId = resolved.value.id;
        const newAssigneeName = resolved.value.name;

        const oldAssigneeId = existing.assignee_id;

        await db.update(tasks).set({ assignee_id: newAssigneeId }).where(eq(tasks.id, taskId));

        // Resolve names for activity log
        let oldAssigneeName: string | null = null;
        if (oldAssigneeId) {
          const [oldUser] = await db.select({ name: users.name }).from(users)
            .where(eq(users.id, oldAssigneeId)).limit(1);
          oldAssigneeName = oldUser?.name || null;
        }

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'field_changed',
          field: 'assignee',
          old_value: oldAssigneeName,
          new_value: newAssigneeName,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId, assignee_id: newAssigneeId },
            before_state: { assignee_id: oldAssigneeId, task_id: taskId },
            after_state: { assignee_id: newAssigneeId, task_id: taskId },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: taskId,
            assignee_id: newAssigneeId,
            assignee_name: newAssigneeName,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'assign_task',
          entityType: 'task',
          entityId: taskId,
          beforeState: { assignee_id: oldAssigneeId },
          afterState: { assignee_id: newAssigneeId },
          metadata: { action_id: actionId, assignee_name: newAssigneeName },
        });

        return {
          success: true,
          result: {
            task_id: taskId,
            old_assignee: oldAssigneeName,
            new_assignee: newAssigneeName,
          },
        };
      }

      case 'post_message': {
        const [space] = await db
          .select()
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, params.space_name)))
          .limit(1);
        if (!space) return { success: false, result: null, error: 'Space not found' };

        const [msg] = await db
          .insert(messages)
          .values({
            org_id: orgId,
            space_id: space.id,
            user_id: userId,
            content: params.content,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { message_id: msg!.id, space_id: space.id },
            before_state: null,
            after_state: {
              message_id: msg!.id,
              space_id: space.id,
              content: params.content,
            },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`space:${space.id}`).emit('message:new', {
            ...msg,
            user_name: 'Deft',
            user_avatar: null,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'post_message',
          entityType: 'message',
          entityId: msg!.id,
          beforeState: null,
          afterState: { message_id: msg!.id, space_id: space.id, content: params.content },
          metadata: { action_id: actionId, space_name: space.name },
        });

        return { success: true, result: { message_id: msg!.id, space: space.name } };
      }

      case 'add_knowledge': {
        const [space] = await db
          .select()
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, `%${params.space_name}%`)))
          .limit(1);
        if (!space) return { success: false, result: null, error: `Space "${params.space_name}" not found` };

        const [entry] = await db
          .insert(spaceKnowledge)
          .values({
            org_id: orgId,
            space_id: space.id,
            type: params.type,
            title: params.title,
            content: params.content || null,
            metadata: params.metadata || null,
            created_by: userId,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { knowledge_id: entry!.id, title: params.title, space: space.name },
            before_state: null,
            after_state: { id: entry!.id, type: params.type, title: params.title, space_id: space.id },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'add_knowledge',
          entityType: 'knowledge',
          entityId: entry!.id,
          beforeState: null,
          afterState: { type: params.type, title: params.title, space: space.name },
          metadata: { action_id: actionId },
        });

        return { success: true, result: { knowledge_id: entry!.id, title: params.title, space: space.name } };
      }

      case 'wiki_write': {
        const { slug: existingSlug, title, content, type: pageType, summary, related_slugs } = params;

        if (existingSlug) {
          const [existing] = await db
            .select()
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, existingSlug), eq(wikiPages.is_deleted, false)))
            .limit(1);
          if (!existing) return { success: false, result: null, error: `Wiki page "${existingSlug}" not found` };

          const updates: Record<string, any> = {};
          if (title) updates.title = title;
          if (summary) updates.summary = summary;
          if (pageType) updates.type = pageType;
          if (content && content !== existing.content) {
            updates.content = content;
            updates.previous_content = existing.content;
            updates.version = existing.version + 1;
          }

          if (Object.keys(updates).length > 0) {
            await db.update(wikiPages).set(updates).where(eq(wikiPages.id, existing.id));
          }

          if (related_slugs && related_slugs.length > 0) {
            await db.delete(wikiLinks).where(eq(wikiLinks.source_page_id, existing.id));
            const targets = await db
              .select({ id: wikiPages.id })
              .from(wikiPages)
              .where(and(eq(wikiPages.org_id, orgId), sql`${wikiPages.slug} = ANY(${related_slugs})`));
            for (const t of targets) {
              if (t.id !== existing.id) {
                await db.insert(wikiLinks).values({ org_id: orgId, source_page_id: existing.id, target_page_id: t.id }).onConflictDoNothing();
              }
            }
          }

          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'update',
            page_id: existing.id,
            details: { updated_fields: Object.keys(updates), by_agent: true },
            performed_by: userId,
          });

          await db
            .update(agentActions)
            .set({
              result: { slug: existingSlug, action: 'updated' },
              before_state: { content: existing.content, version: existing.version },
              after_state: { content: content || existing.content, version: (existing.version || 0) + 1 },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'wiki_write',
            entityType: 'wiki_page',
            entityId: existing.id,
            beforeState: { content: existing.content },
            afterState: { content: content || existing.content },
            metadata: { action_id: actionId, slug: existingSlug },
          });

          return { success: true, result: { slug: existingSlug, action: 'updated' } };
        } else {
          if (!title || !content || !pageType) {
            return { success: false, result: null, error: 'title, content, and type are required for new wiki pages' };
          }

          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

          const [page] = await db
            .insert(wikiPages)
            .values({
              org_id: orgId,
              scope: 'org',
              type: pageType,
              title,
              slug,
              summary: summary || null,
              content,
              confidence: 0.7,
              version: 1,
            })
            .returning();

          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'create',
            page_id: page!.id,
            details: { type: pageType, by_agent: true },
            performed_by: userId,
          });

          await db
            .update(agentActions)
            .set({
              result: { slug, page_id: page!.id, action: 'created' },
              before_state: null,
              after_state: { id: page!.id, title, slug, type: pageType },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'wiki_write',
            entityType: 'wiki_page',
            entityId: page!.id,
            beforeState: null,
            afterState: { title, slug, type: pageType },
            metadata: { action_id: actionId },
          });

          return { success: true, result: { slug, page_id: page!.id, action: 'created' } };
        }
      }

      default:
        return { success: false, result: null, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions).set({ error: msg }).where(eq(agentActions.id, actionId));
    return { success: false, result: null, error: msg };
  }
}

/**
 * Create an action record and execute it immediately (for auto-approved actions).
 * Unlike executeAction(), this creates the agentActions row as already approved.
 */
export async function executeActionDirect(
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
  conversationId: string | null,
  approvalTier: 'auto' | 'quick' | 'full',
  options?: {
    agentEmployeeId?: string;
    source?: string;
    mcpConnectionId?: string;
    planId?: string;
    planStepId?: string;
  },
): Promise<{ actionId: string; success: boolean; result: any; error?: string }> {
  const [actionRecord] = await db
    .insert(agentActions)
    .values({
      org_id: orgId,
      user_id: userId,
      conversation_id: conversationId,
      action,
      params,
      approval_tier: approvalTier,
      approval_status: 'approved',
      approved_at: new Date(),
      ...(options?.agentEmployeeId ? { agent_employee_id: options.agentEmployeeId } : {}),
      ...(options?.source ? { source: options.source } : {}),
      ...(options?.mcpConnectionId ? { mcp_connection_id: options.mcpConnectionId } : {}),
      ...(options?.planId ? { plan_id: options.planId } : {}),
      ...(options?.planStepId ? { plan_step_id: options.planStepId } : {}),
    })
    .returning();

  const result = await executeAction(actionRecord!.id, action, params, orgId, userId, {
    agentEmployeeId: options?.agentEmployeeId,
  });

  return { actionId: actionRecord!.id, ...result };
}
