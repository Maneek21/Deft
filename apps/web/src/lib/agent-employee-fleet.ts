import { agentEmployeeLifecycle, type AgentEmployeeHealth } from './agent-employee-status';

export type AgentEmployeeFleetFilter = 'all' | 'attention' | 'active' | 'offline' | 'setup' | 'paused';

export type AgentEmployeeFleetRecord = AgentEmployeeHealth & {
  name: string;
  role?: string | null;
  runtime_kind?: string | null;
  wake_mode?: string | null;
};

export const AGENT_EMPLOYEE_FLEET_FILTERS: Array<{ id: AgentEmployeeFleetFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'active', label: 'Active' },
  { id: 'offline', label: 'Offline' },
  { id: 'setup', label: 'Setup' },
  { id: 'paused', label: 'Paused' },
];

export type AgentEmployeeFleetBucket = Exclude<AgentEmployeeFleetFilter, 'all'>;

const SORT_RANK: Record<string, number> = {
  'Needs attention': 0,
  'Approval waiting': 1,
  'Setup incomplete': 2,
  Certifying: 3,
  'Ready to connect': 4,
  Draft: 5,
  Working: 6,
  Online: 7,
  Idle: 8,
  Offline: 9,
  Paused: 10,
};

export function agentEmployeeFleetBucket(
  employee: AgentEmployeeFleetRecord,
  now = Date.now(),
): AgentEmployeeFleetBucket {
  const lifecycle = agentEmployeeLifecycle(employee, now);
  if (lifecycle.label === 'Needs attention' || lifecycle.label === 'Approval waiting') return 'attention';
  if (lifecycle.label === 'Working' || lifecycle.label === 'Online' || lifecycle.label === 'Idle') return 'active';
  if (lifecycle.label === 'Offline') return 'offline';
  if (lifecycle.label === 'Paused') return 'paused';
  return 'setup';
}

export function countAgentEmployeeFleet(
  employees: AgentEmployeeFleetRecord[],
  now = Date.now(),
): Record<AgentEmployeeFleetBucket, number> {
  const counts: Record<AgentEmployeeFleetBucket, number> = {
    attention: 0,
    active: 0,
    offline: 0,
    setup: 0,
    paused: 0,
  };
  for (const employee of employees) counts[agentEmployeeFleetBucket(employee, now)] += 1;
  return counts;
}

export function filterAndSortAgentEmployeeFleet<T extends AgentEmployeeFleetRecord>(
  employees: T[],
  filter: AgentEmployeeFleetFilter,
  search: string,
  now = Date.now(),
): T[] {
  const query = search.trim().toLowerCase();

  return [...employees]
    .filter((employee) => filter === 'all' || agentEmployeeFleetBucket(employee, now) === filter)
    .filter((employee) => {
      if (!query) return true;
      const lifecycle = agentEmployeeLifecycle(employee, now);
      return [
        employee.name,
        employee.role,
        employee.runtime_kind,
        employee.wake_mode,
        employee.unhealthy_reason,
        lifecycle.label,
        lifecycle.detail,
      ].some((value) => value?.toLowerCase().includes(query));
    })
    .sort((a, b) => {
      const lifecycleA = agentEmployeeLifecycle(a, now).label;
      const lifecycleB = agentEmployeeLifecycle(b, now).label;
      const rank = (SORT_RANK[lifecycleA] ?? 99) - (SORT_RANK[lifecycleB] ?? 99);
      return rank || a.name.localeCompare(b.name);
    });
}
