import { db } from './db.js';
import {
  tasks,
  projects,
  messages,
  spaces,
  agentActions,
  taskActivity,
  users,
  orgMembers,
} from '@deft/db/schema';
import { eq, and, sql, ilike } from 'drizzle-orm';
import { getIO } from '../socket.js';
import { logAuditEvent } from './audit.js';

async function resolveUser(orgId: string, name: string): Promise<string | null> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(orgMembers, eq(users.id, orgMembers.user_id))
    .where(and(eq(orgMembers.org_id, orgId), ilike(users.name, `%${name}%`)))
    .limit(1);
  return u?.id || null;
}

export async function executeAction(
  actionId: string,
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
): Promise<{ success: boolean; result: any; error?: string }> {
  try {
    switch (action) {
      case 'create_task': {
        const [project] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.org_id, orgId), ilike(projects.name, `%${params.project_name}%`)))
          .limit(1);
        if (!project) return { success: false, result: null, error: 'Project not found' };

        const assigneeId = params.assignee_name
          ? await resolveUser(orgId, params.assignee_name)
          : null;

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
            priority: params.priority || 'p2',
            assignee_id: assigneeId,
            created_by: userId,
            due_date: params.due_date ? new Date(params.due_date) : null,
          })
          .returning();

        await db.insert(taskActivity).values({
          task_id: task!.id,
          user_id: userId,
          action: 'created',
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
          task_id: taskId,
          user_id: userId,
          action: 'status_changed',
          field: 'status',
          old_value: oldStatus,
          new_value: params.new_status,
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

        const newAssigneeId = await resolveUser(orgId, params.assignee_name);
        if (!newAssigneeId) {
          return { success: false, result: null, error: `User "${params.assignee_name}" not found in this org` };
        }

        const oldAssigneeId = existing.assignee_id;

        await db.update(tasks).set({ assignee_id: newAssigneeId }).where(eq(tasks.id, taskId));

        // Resolve names for activity log
        let oldAssigneeName: string | null = null;
        if (oldAssigneeId) {
          const [oldUser] = await db.select({ name: users.name }).from(users)
            .where(eq(users.id, oldAssigneeId)).limit(1);
          oldAssigneeName = oldUser?.name || null;
        }
        const [newUser] = await db.select({ name: users.name }).from(users)
          .where(eq(users.id, newAssigneeId)).limit(1);

        await db.insert(taskActivity).values({
          task_id: taskId,
          user_id: userId,
          action: 'field_changed',
          field: 'assignee',
          old_value: oldAssigneeName,
          new_value: newUser?.name || params.assignee_name,
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
            assignee_name: newUser?.name || params.assignee_name,
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
          metadata: { action_id: actionId, assignee_name: newUser?.name },
        });

        return {
          success: true,
          result: {
            task_id: taskId,
            old_assignee: oldAssigneeName,
            new_assignee: newUser?.name || params.assignee_name,
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

      default:
        return { success: false, result: null, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await db.update(agentActions).set({ error: msg }).where(eq(agentActions.id, actionId));
    return { success: false, result: null, error: msg };
  }
}
