export type TaskPermissionUser = {
  id: string;
};

export type TaskPermissionTask = {
  created_by: string;
  assignee_id: string | null;
};

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest' | null | undefined;

export function canDeleteTask(
  user: TaskPermissionUser,
  task: TaskPermissionTask,
  orgRole: OrgRole,
): boolean {
  if (task.created_by === user.id) return true;
  if (task.assignee_id && task.assignee_id === user.id) return true;
  if (orgRole === 'owner' || orgRole === 'admin') return true;
  return false;
}
