export type ConfirmedAction = {
  action: string;
  params?: unknown;
  result?: unknown;
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function titleFrom(params: Record<string, any>, result: Record<string, any>) {
  return typeof result.title === 'string' ? result.title : typeof params.title === 'string' ? params.title : '';
}

function humanize(value: unknown) {
  return typeof value === 'string' ? value.replace(/_/g, ' ') : String(value ?? '');
}

export function summarizeConfirmedAction(action: ConfirmedAction) {
  const params = record(action.params);
  const result = record(action.result);
  const title = titleFrom(params, result);

  switch (action.action) {
    case 'create_task': {
      const identifier = typeof result.identifier === 'string'
        ? result.identifier
        : typeof result.prefix === 'string' && typeof result.number === 'number'
          ? `${result.prefix}-${result.number}`
          : 'the task';
      const subtasks = Array.isArray(result.subtasks) ? result.subtasks.length : 0;
      return `Created ${identifier}${title ? `: ${title}` : ''}${subtasks ? ` with ${subtasks} subtasks` : ''}.`;
    }
    case 'update_task_status':
      return `${params.task_identifier ?? result.task_identifier ?? 'The task'} is now ${humanize(result.new_status ?? params.new_status)}.`;
    case 'assign_task':
      return `Assigned ${params.task_identifier ?? 'the task'}${params.assignee_name ? ` to ${params.assignee_name}` : ''}.`;
    case 'comment_on_task':
      return `Added a comment to ${params.task_identifier ?? 'the task'}.`;
    case 'set_due_date':
      return `Set ${params.task_identifier ?? 'the task'} due date to ${params.due_date ?? result.due_date ?? 'the requested date'}.`;
    case 'post_message':
      return `Posted the message in #${String(result.space ?? params.space_name ?? 'the selected space').replace(/^#/, '')}.`;
    case 'post_thread_reply':
      return 'Posted the reply in the selected thread.';
    case 'wiki_write': {
      const verb = result.action === 'updated' ? 'Updated' : 'Created';
      return `${verb} wiki page${title ? ` "${title}"` : result.slug ? ` "${result.slug}"` : ''}.`;
    }
    case 'add_knowledge':
      return `Saved${title ? ` "${title}"` : ' the item'} to knowledge.`;
    case 'create_note':
      return `Created note${title ? ` "${title}"` : ''}.`;
    case 'note_to_wiki':
      return `Promoted${title ? ` "${title}"` : ' the note'} to wiki.`;
    case 'write_canvas':
      return `Updated the canvas for #${String(params.space_name ?? result.space_name ?? 'the selected space').replace(/^#/, '')}.`;
    case 'create_reminder':
      return `Set the reminder${params.remind_at ? ` for ${params.remind_at}` : ''}.`;
    case 'link_decision_to_tasks': {
      const count = Array.isArray(params.task_ids) ? params.task_ids.length : Number(result.linked_count ?? 0);
      return `Linked the decision to ${count || 'the selected'} task${count === 1 ? '' : 's'}.`;
    }
    case 'mark_decision_implemented':
      return 'Marked the decision as implemented.';
    case 'add_dependency':
      return `Linked ${params.source_task_identifier ?? 'the source task'} to ${params.target_task_identifier ?? 'the target task'}.`;
    default:
      return `Completed ${humanize(action.action)}.`;
  }
}

export function formatApprovalConfirmation(actions: ConfirmedAction[]) {
  const summaries = actions.map(summarizeConfirmedAction);
  if (summaries.length === 0) return '';
  if (summaries.length === 1) return `Done - ${summaries[0]}`;
  return [
    `Done - completed ${summaries.length} approved actions.`,
    ...summaries.map((summary) => `- ${summary}`),
  ].join('\n');
}
