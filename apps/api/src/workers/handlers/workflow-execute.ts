// Handler: workflow-execute — runs a single workflow_rule's actions against
// a task. Enqueued by task PATCH when a status change matches a stored
// task.status_changed trigger with matching to_status filter.
//
// v1 action kinds (Task 5.7):
//   - add_comment   { template: string }
//   - assign_to     { user_id: string }   // role-based resolution deferred
//   - add_label     { label_id: string }
//   - notify        { user_id: string, title?: string }
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  workflowRules, workflowRuns,
  tasks, taskComments, taskLabels, labels,
  taskRelationships,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { emitToUser } from '../../socket.js';
import { createNotificationIfAllowed } from '../../lib/notification-policy.js';

interface WorkflowExecuteJobData {
  workflow_id: string;
  task_id: string;
  actor_user_id: string;
}

type WorkflowAction =
  | { kind: 'add_comment'; template: string }
  | { kind: 'assign_to'; user_id: string }
  | { kind: 'add_label'; label_id: string }
  | { kind: 'notify'; user_id: string; title?: string }
  // Block 2.5 — when the triggering task enters `done`, find every task
  // that this one was blocking and notify that task's assignee.
  | { kind: 'unblock_dependents' };

export async function handleWorkflowExecute(job: JobData): Promise<void> {
  const { workflow_id, task_id, actor_user_id } =
    job.data as WorkflowExecuteJobData;
  if (!workflow_id || !task_id) return;

  const [rule] = await db.select().from(workflowRules)
    .where(eq(workflowRules.id, workflow_id)).limit(1);
  if (!rule || !rule.is_active) return;

  const [task] = await db.select().from(tasks)
    .where(and(eq(tasks.id, task_id), eq(tasks.org_id, rule.org_id))).limit(1);
  if (!task) return;

  // Actions are stored either as an array on action_config.actions OR as a
  // single action via action_type + action_config for legacy shape.
  const cfg = (rule.action_config ?? {}) as Record<string, unknown>;
  let actions: WorkflowAction[] = [];
  if (Array.isArray((cfg as any).actions)) {
    actions = (cfg as any).actions as WorkflowAction[];
  } else if (rule.action_type) {
    actions = [{ kind: rule.action_type as any, ...(cfg as any) }];
  }

  const results: Array<{ kind: string; ok: boolean; error?: string }> = [];

  for (const action of actions) {
    try {
      switch (action.kind) {
        case 'add_comment': {
          const content = (action.template || '').trim();
          if (!content) { results.push({ kind: 'add_comment', ok: false, error: 'empty template' }); break; }
          await db.insert(taskComments).values({
            org_id: rule.org_id,
            task_id: task.id,
            user_id: actor_user_id,
            content,
          });
          results.push({ kind: 'add_comment', ok: true });
          break;
        }
        case 'assign_to': {
          if (!action.user_id) { results.push({ kind: 'assign_to', ok: false, error: 'missing user_id' }); break; }
          await db.update(tasks)
            .set({ assignee_id: action.user_id, updated_at: new Date() })
            .where(eq(tasks.id, task.id));
          results.push({ kind: 'assign_to', ok: true });
          break;
        }
        case 'add_label': {
          if (!action.label_id) { results.push({ kind: 'add_label', ok: false, error: 'missing label_id' }); break; }
          // Verify label belongs to the same org
          const [label] = await db.select({ id: labels.id }).from(labels)
            .where(and(eq(labels.id, action.label_id), eq(labels.org_id, rule.org_id)))
            .limit(1);
          if (!label) { results.push({ kind: 'add_label', ok: false, error: 'label not in org' }); break; }
          await db.insert(taskLabels).values({
            task_id: task.id, label_id: action.label_id,
          }).onConflictDoNothing();
          results.push({ kind: 'add_label', ok: true });
          break;
        }
        case 'notify': {
          if (!action.user_id) { results.push({ kind: 'notify', ok: false, error: 'missing user_id' }); break; }
          const title = action.title || `Workflow: ${rule.name}`;
          const notif = await createNotificationIfAllowed({
            org_id: rule.org_id,
            user_id: action.user_id,
            type: 'system',
            title,
            body: task.title,
            link: `/tasks`,
            metadata: { workflow_id, task_id: task.id },
          }, { channel: 'tasks' });
          if (notif) emitToUser(action.user_id, 'notification:new', notif);
          results.push({ kind: 'notify', ok: true });
          break;
        }
        case 'unblock_dependents': {
          // Block 2.5 — find every task that THIS task was blocking
          // (source_task_id = this task, type = 'blocks') and DM that
          // task's assignee that their blocker is done. Skips tasks that
          // have no assignee and tasks that are themselves done/cancelled.
          const edges = await db
            .select({
              dependent_id: taskRelationships.target_task_id,
            })
            .from(taskRelationships)
            .where(and(
              eq(taskRelationships.source_task_id, task.id),
              eq(taskRelationships.type, 'blocks' as any),
            ));
          if (edges.length === 0) {
            results.push({ kind: 'unblock_dependents', ok: true });
            break;
          }
          let notified = 0;
          for (const edge of edges) {
            const [dep] = await db
              .select({
                id: tasks.id, title: tasks.title, status: tasks.status,
                assignee_id: tasks.assignee_id,
              })
              .from(tasks)
              .where(and(eq(tasks.id, edge.dependent_id), eq(tasks.org_id, rule.org_id)))
              .limit(1);
            if (!dep || !dep.assignee_id) continue;
            if (dep.status === 'done' || dep.status === 'cancelled') continue;
            const notif = await createNotificationIfAllowed({
              org_id: rule.org_id,
              user_id: dep.assignee_id,
              type: 'system',
              title: `Unblocked: ${dep.title}`,
              body: `"${task.title}" is done — you can start on this now.`,
              link: `/tasks`,
              metadata: {
                workflow_id,
                task_id: dep.id,
                unblocker_task_id: task.id,
                subtype: 'unblocked',
              },
            }, { channel: 'tasks' });
            if (notif) {
              emitToUser(dep.assignee_id, 'notification:new', notif);
              notified++;
            }
          }
          results.push({ kind: 'unblock_dependents', ok: true, count: notified } as any);
          break;
        }
        default:
          results.push({ kind: (action as any).kind, ok: false, error: 'unknown action kind' });
      }
    } catch (err) {
      results.push({ kind: (action as any).kind, ok: false, error: (err as Error).message });
    }
  }

  const allOk = results.every((r) => r.ok);
  await db.insert(workflowRuns).values({
    rule_id: rule.id,
    triggered_by_message_id: null,
    triggered_by_user_id: actor_user_id,
    result: { task_id: task.id, actions: results },
    status: allOk ? 'success' : 'failed',
  });

  console.log(
    `[workflow-execute] rule=${rule.id} task=${task.id} actions=${results.length} ok=${allOk}`,
  );
}
