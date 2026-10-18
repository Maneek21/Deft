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
