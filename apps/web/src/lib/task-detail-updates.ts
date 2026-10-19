export async function saveSubtaskStatus(
  request: () => Promise<Response>,
): Promise<string> {
  const response = await request();
  if (!response.ok) throw new Error('Subtask status was not saved. Choose an allowed status and try again.');
  const saved: unknown = await response.json();
  if (!saved || typeof saved !== 'object' || !('status' in saved) || typeof saved.status !== 'string') {
    throw new Error('Subtask status could not be confirmed. Refresh before trying again.');
  }
  return saved.status;
}

export function taskActivitySummary(action: string | undefined, field: string | null | undefined): string | null {
  if (field) return null;
  return action === 'created' ? 'created this task' : (action ?? 'updated this task').replaceAll('_', ' ');
}

export function hasUnsavedDescription(pending: string | undefined, saving: boolean): boolean {
  return pending !== undefined || saving;
}

export type TaskCommentIdentity = { taskId: string; sessionScope: string | null };
export function taskCommentIdentity(previous: TaskCommentIdentity | null, taskId: string, sessionScope: string | null): TaskCommentIdentity {
  return previous?.taskId === taskId && previous.sessionScope === sessionScope ? previous : { taskId, sessionScope };
}
export async function loadScopedTaskComments<T>(identity: TaskCommentIdentity, current: () => TaskCommentIdentity | null, request: () => Promise<Response>, commit: (rows: T[]) => void): Promise<'loaded' | 'stale' | 'error'> {
  try {
    if (current() !== identity) return 'stale';
    const response = await request();
    if (current() !== identity) return 'stale';
    if (!response.ok) return 'error';
    const rows: unknown = await response.json();
    if (current() !== identity) return 'stale';
    if (!Array.isArray(rows)) return 'error';
    commit(rows as T[]);
    return 'loaded';
  } catch { return current() === identity ? 'error' : 'stale'; }
}

export function taskCommentsNeedRefresh(previousIdentity: TaskCommentIdentity | null, previousTab: string | null, identity: TaskCommentIdentity, tab: string): boolean {
  return previousIdentity !== identity || (tab === 'comments' && previousTab !== 'comments');
}
