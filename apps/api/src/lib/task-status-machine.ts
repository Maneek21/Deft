export type StatusId = string;

export type ProjectResolvedConfig = {
  statuses: { id: StatusId; label: string; color: string; order: number }[];
  allowed_transitions: Record<StatusId, StatusId[]> | null;
};

export function isValidTransition(
  from: StatusId,
  to: StatusId,
  projectResolvedConfig: ProjectResolvedConfig,
): boolean {
  const statusIds = new Set(projectResolvedConfig.statuses.map((s) => s.id));

  if (!statusIds.has(to)) {
    return false;
  }

  if (from === to) {
    return true;
  }

  if (projectResolvedConfig.allowed_transitions) {
    const allowed = projectResolvedConfig.allowed_transitions[from];
    if (!allowed) {
      return false;
    }
    return allowed.includes(to);
  }

  return true;
}
