import { stripHtml } from './strip-html';

type Action = { action: string; params: any; approval_status: string; executed_at: string | null; error: string | null; result?: any };

export function agentActivityCopy(action: Action): string {
  const p = action.params ?? {};
  const failed = Boolean(action.error || action.result?.error || action.result?.success === false
    || ['failed', 'error'].includes(action.result?.status));
  const completed = action.approval_status === 'approved' && Boolean(action.executed_at) && !failed;
  if (completed) {
    switch (action.action) {
      case 'create_task': case 'task_create': return `Created task “${stripHtml(p.title)}” in ${p.project_name ?? 'project'}`;
      case 'update_task_status': return `Moved ${p.task_identifier} to ${(p.new_status || '').replace(/_/g, ' ')}`;
      case 'assign_task': return `Assigned ${p.task_identifier} to ${p.assignee_name}`;
      case 'post_message': return `Posted in #${p.space_name}`;
      case 'add_knowledge': return `Added ${p.type}: “${p.title}”`;
      case 'wiki_write': return `Updated wiki: ${p.title || p.slug}`;
      default: return action.action.replace(/_/g, ' ');
    }
  }
  const subject = ['create_task', 'task_create'].includes(action.action)
    ? `task “${stripHtml(p.title)}” in ${p.project_name ?? 'project'}`
    : action.action === 'wiki_write' ? `wiki update: ${p.title || p.slug}` : action.action.replace(/_/g, ' ');
  if (failed) return `Failed action: ${subject}`;
  if (action.approval_status === 'pending') return `Proposed ${subject}`;
  if (action.approval_status === 'rejected') return `Rejected proposal: ${subject}`;
  if (action.approval_status === 'expired') return `Expired proposal: ${subject}`;
  if (action.approval_status === 'approved') return `Approved, awaiting execution: ${subject}`;
  return `Action proposal: ${subject}`;
}
