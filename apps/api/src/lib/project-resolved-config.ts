// INTERIM — Task 4.5 replaces this with a real skill-junction resolver.
import type { ProjectResolvedConfig } from './task-status-machine.js';

const ENGINEERING_CONFIG: ProjectResolvedConfig = {
  statuses: [
    { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
    { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
    { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
    { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
    { id: 'done', label: 'Done', color: '#10b981', order: 4 },
    { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
  ],
  allowed_transitions: {
    backlog: ['todo', 'in_progress', 'cancelled'],
    todo: ['in_progress', 'backlog', 'cancelled'],
    in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
    in_review: ['in_progress', 'done', 'cancelled'],
    done: ['in_progress', 'backlog'],
    cancelled: ['backlog'],
  },
};

export async function getProjectResolvedConfig(
  _projectId: string,
): Promise<ProjectResolvedConfig> {
  return ENGINEERING_CONFIG;
}
