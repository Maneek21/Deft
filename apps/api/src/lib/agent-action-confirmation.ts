export type ConfirmedAction = {
  action: string;
  params?: unknown;
  result?: unknown;
  /** Set when the approved action failed to execute. */
  error?: string | null;
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

/** ` [Open it](/d/<id>)` for the document a result names, else nothing: the page checks access. */
function documentLink(result: Record<string, any>): string {
  const id = [result.document_id, result.canvas_document_id, result.note_id]
    .find((value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value));
  return id ? ` [Open it](/d/${id})` : '';
}

/** The note and canvas aliases and create_document: their outcomes never name the document (fix round 5). */
const DRAFT_TOOL_FAILURES: Readonly<Record<string, string>> = {
  create_document: 'Create document did not complete.',
  create_note: 'Create note did not complete.',
  write_canvas: 'Write canvas did not complete.',
};

export function summarizeConfirmedAction(action: ConfirmedAction) {
  const params = record(action.params);
  const result = record(action.result);
  const title = titleFrom(params, result);

  switch (action.action) {
    case 'create_task':
    case 'task_create': {
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
    // M7: posted in the chat, so none of these names the document (rule C4,
    // fix round 5 for the note and canvas aliases): the link opens it only for
    // the people who can, and its title is theirs to read there.
    case 'create_note':
    case 'create_document':
      return `Created a document.${documentLink(result)}`;
    case 'edit_document':
      return result.status === 'partially_accepted' ? 'Applied part of the suggested edit.' : 'Applied the suggested edit.';
    case 'note_to_wiki':
      return `Promoted${title ? ` "${title}"` : ' the note'} to wiki.`;
    case 'write_canvas':
      return `Updated the canvas.${documentLink(result)}`;
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

/** Plain label for an approved action that did not complete. */
export function summarizeFailedAction(action: ConfirmedAction) {
  const params = record(action.params);
  // M7: a document's title is never posted in the chat (rule C4; the note and canvas aliases since fix round 5).
  if (Object.hasOwn(DRAFT_TOOL_FAILURES, action.action)) return DRAFT_TOOL_FAILURES[action.action]!;
  if (action.action === 'edit_document') return 'Edit document did not complete.';
  const target = typeof params.title === 'string' && params.title.trim()
    ? params.title.trim()
    : typeof params.task_identifier === 'string' && params.task_identifier.trim()
      ? params.task_identifier.trim()
      : '';
  const label = humanize(action.action);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}${target ? ` "${target}"` : ''} did not complete.`;
}

export function formatApprovalConfirmation(actions: ConfirmedAction[]) {
  const succeeded = actions.filter((action) => !action.error).map(summarizeConfirmedAction);
  const failed = actions.filter((action) => action.error).map(summarizeFailedAction);
  const lines: string[] = [];
  if (succeeded.length === 1) {
    lines.push(`Done - ${succeeded[0]}`);
  } else if (succeeded.length > 1) {
    lines.push(`Done - completed ${succeeded.length} approved actions.`, ...succeeded.map((summary) => `- ${summary}`));
  }
  if (failed.length === 1) {
    lines.push(`Failed - ${failed[0]}`);
  } else if (failed.length > 1) {
    lines.push(`Failed - ${failed.length} approved actions did not complete.`, ...failed.map((summary) => `- ${summary}`));
  }
  return lines.join('\n');
}
