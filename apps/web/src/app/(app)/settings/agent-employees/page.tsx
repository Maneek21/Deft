'use client';

import { useCallback, useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  AGENT_EMPLOYEE_FLEET_FILTERS,
  countAgentEmployeeFleet,
  filterAndSortAgentEmployeeFleet,
  type AgentEmployeeFleetFilter,
} from '@/lib/agent-employee-fleet';
import { agentConnectionStatus, agentEmployeeLifecycle } from '@/lib/agent-employee-status';

type AgentEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  is_active: boolean;
  is_byoa: boolean;
  trust_level: string;
  max_daily_actions: number;
  daily_action_count: number;
  avatar_url: string | null;
  created_at: string;
  last_heartbeat_at: string | null;
  last_mcp_call_at: string | null;
  last_work_outcome_at: string | null;
  byoa_model_info: string | null;
  heartbeat_enabled: boolean;
  heartbeat_interval_min: number;
  runtime_kind: string;
  wake_mode: string;
  certification_status: string;
  unhealthy: boolean;
  unhealthy_reason: string | null;
  pending_action_count?: number;
  recent_turn_count_24h?: number;
  last_turn_at?: string | null;
  channel_last_seen_at?: string | null;
  channel_status?: string | null;
  installed_skill_count?: number;
  required_workspace_skill_installed?: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  project_manager: 'Project Manager',
  engineering_lead: 'Engineering Lead',
  executive_assistant: 'Executive Assistant',
  product_designer: 'Product Designer',
  qa_engineer: 'QA Engineer',
  customer_success: 'Customer Success',
  community_manager: 'Community Manager',
  cfo: 'CFO',
  superintendent: 'Superintendent',
  custom: 'Custom',
};

const TRUST_LABELS: Record<string, string> = {
  conservative: 'Conservative',
  standard: 'Standard',
  autonomous: 'Autonomous',
};

const isSelfHosted = process.env.NEXT_PUBLIC_DEFT_SELF_HOSTED === 'true';

function runtimeLabel(value: string | null | undefined): string {
  return value ? value.replace(/_/g, ' ') : 'custom MCP';
}

const STATUS_TONES = {
  green: { color: '#10b981', background: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.26)' },
  blue: { color: '#3b82f6', background: 'rgba(59,130,246,0.11)', border: 'rgba(59,130,246,0.24)' },
  amber: { color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)' },
  red: { color: '#ef4444', background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.22)' },
  gray: { color: '#9ca3af', background: 'rgba(156,163,175,0.10)', border: 'rgba(156,163,175,0.22)' },
  purple: { color: '#8b5cf6', background: 'rgba(139,92,246,0.11)', border: 'rgba(139,92,246,0.24)' },
} as const;

function FleetMetric({ icon: Icon, label, value, tone = 'default' }: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone?: 'default' | 'good' | 'warning' | 'danger';
}) {
  const color = tone === 'good' ? 'var(--status-green)'
    : tone === 'warning' ? 'var(--status-amber)'
      : tone === 'danger' ? 'var(--status-red)'
        : 'var(--foreground)';
  return (
    <div className="min-h-[72px] rounded-lg p-3" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--muted)' }}>
        <Icon size={12} strokeWidth={1.8} />
        {label}
      </div>
      <p className="mt-2 text-[23px] font-semibold leading-none" style={{ color }}>{value}</p>
    </div>
  );
}

export default function AgentEmployeesPage() {
  const [employees, setEmployees] = useState<AgentEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [fleetFilter, setFleetFilter] = useState<AgentEmployeeFleetFilter>('all');

  const fetchEmployees = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get('/api/agent-employees?expand=stats');
      if (!res.ok) throw new Error(`Could not load agent employees (${res.status})`);
      setEmployees(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agent employees.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEmployees();
    const timer = window.setInterval(() => { void fetchEmployees(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [fetchEmployees]);

  const fleetCounts = useMemo(() => countAgentEmployeeFleet(employees), [employees]);
  const visibleEmployees = useMemo(
    () => filterAndSortAgentEmployeeFleet(employees, fleetFilter, search),
    [employees, fleetFilter, search],
  );

  const handleToggleActive = async (emp: AgentEmployee) => {
    setError(null);
    setTogglingId(emp.id);
    try {
      const endpoint = emp.is_active
        ? `/api/agent-employees/${emp.id}/pause`
        : `/api/agent-employees/${emp.id}/resume`;
      const res = await api.post(endpoint);
      if (!res.ok) throw new Error(`Could not ${emp.is_active ? 'pause' : 'resume'} ${emp.name} (${res.status})`);
      setEmployees((prev) =>
        prev.map((e) => (e.id === emp.id ? { ...e, is_active: !e.is_active } : e))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the agent.');
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      const res = await api.delete(`/api/agent-employees/${id}`);
      if (!res.ok) throw new Error(`Could not delete the agent (${res.status})`);
      setEmployees((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the agent.');
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-[980px] p-4 md:p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            className="text-[20px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Agent Employees
          </h2>
          <p className="mt-1 max-w-[620px] text-[13px]" style={{ color: 'var(--muted)' }}>
            See who is working, who needs review, and which runtimes still need setup.
          </p>
        </div>
        {isSelfHosted ? (
          <Link
            href="/settings/agent-employees/create"
            className="deft-pill self-start"
            data-active={true}
            style={{
              color: 'white',
              fontFamily: 'var(--font-heading)',
            }}
          >
            <ExternalLink size={13} />
            Connect External Agent
          </Link>
        ) : (
          <Link
            href="/settings/agent-employees/create"
            className="deft-pill self-start"
            data-active={true}
            style={{
              color: 'white',
              fontFamily: 'var(--font-heading)',
            }}
          >
            <Plus size={13} />
            Create Agent
          </Link>
        )}
      </div>

      {error && (
        <div
          className="mb-4 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[12px]"
          style={{ color: 'var(--status-red)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)' }}
          role="alert"
        >
          <span>{error}</span>
          <button type="button" className="deft-pill" onClick={() => void fetchEmployees()}>Retry</button>
        </div>
      )}

      {!loading && employees.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            <FleetMetric icon={Users} label="Total" value={employees.length} />
            <FleetMetric icon={CheckCircle2} label="Active" value={fleetCounts.active} tone="good" />
            <FleetMetric icon={AlertTriangle} label="Attention" value={fleetCounts.attention} tone="danger" />
            <FleetMetric icon={Clock3} label="Setup" value={fleetCounts.setup} tone="warning" />
          </div>
          <div
            className="mb-4 rounded-lg p-3"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
          >
            <label className="relative block">
              <Search
                size={15}
                strokeWidth={1.7}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--muted)' }}
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search agents, roles, runtimes..."
                aria-label="Search agent employees"
                className="h-10 w-full rounded-full border bg-transparent pl-9 pr-3 text-[13px] outline-none"
                style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}
              />
            </label>
            <div className="mt-3 flex gap-1.5 overflow-x-auto whitespace-nowrap" aria-label="Filter agent employees">
              {AGENT_EMPLOYEE_FLEET_FILTERS.map((filter) => {
                const count = filter.id === 'all' ? employees.length : fleetCounts[filter.id];
                return (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => setFleetFilter(filter.id)}
                    className="deft-pill"
                    data-active={fleetFilter === filter.id}
                    aria-pressed={fleetFilter === filter.id}
                  >
                    {filter.label} <span style={{ color: 'var(--muted)' }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {loading ? (
        <div className="py-12 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          Loading...
        </div>
      ) : employees.length === 0 ? (
        <div
          className="py-12 text-center rounded-xl"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        >
          <p className="text-[13px] mb-1" style={{ color: 'var(--muted)' }}>
            No agent employees yet.
          </p>
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Create your first AI teammate.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleEmployees.length === 0 && (
            <div className="rounded-lg border border-dashed px-4 py-10 text-center text-[13px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              No agent employees match this view.
            </div>
          )}
          {visibleEmployees.map((emp) => {
            const connection = agentConnectionStatus(emp);
            const lifecycle = agentEmployeeLifecycle(emp);
            const lifecycleTone = STATUS_TONES[lifecycle.tone];
            const connectionTone = STATUS_TONES[connection.tone];
            return (
            <div
              key={emp.id}
              className="flex flex-col gap-2 rounded-lg px-3 py-2.5 md:flex-row md:items-center md:gap-3"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
            >
              {/* Clickable area: avatar + name/role + secondary metadata */}
              <Link
                href={`/settings/agent-employees/${emp.id}/developer`}
                className="flex min-w-0 flex-1 items-start gap-2.5"
              >
                {/* Avatar */}
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full text-[12px] font-medium text-white"
                  style={{ background: 'var(--accent)' }}
                >
                  {emp.avatar_url ? (
                    <img src={emp.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Bot size={16} strokeWidth={1.8} />
                  )}
                </div>

                {/* Name, role, and secondary metadata stacked */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p
                      className="max-w-full truncate text-[14px] font-medium"
                      style={{ color: 'var(--foreground)' }}
                    >
                      {emp.name}
                    </p>
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded"
                      style={{
                        color: lifecycleTone.color,
                        background: lifecycleTone.background,
                        border: `1px solid ${lifecycleTone.border}`,
                      }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: lifecycleTone.color }} />
                      {lifecycle.label}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {lifecycle.detail}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] font-medium" style={{ color: 'var(--foreground-secondary)' }}>
                      {ROLE_LABELS[emp.role] || emp.role}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {TRUST_LABELS[emp.trust_level] || emp.trust_level}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {runtimeLabel(emp.runtime_kind)} / {emp.wake_mode}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {emp.installed_skill_count ?? 0} skill{emp.installed_skill_count === 1 ? '' : 's'}
                    </span>
                    <div className="flex items-center gap-1">
                      {emp.heartbeat_enabled && (
                        <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '4px' }}>
                          &#9829; every {emp.heartbeat_interval_min}m
                        </span>
                      )}
                    </div>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {emp.daily_action_count ?? 0}/{emp.max_daily_actions} actions today
                    </span>
                    <div className="flex items-center gap-1">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ background: connectionTone.color }}
                      />
                      <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                        {connection.label}
                      </span>
                    </div>
                    {emp.unhealthy && (
                      <span className="sr-only">Unhealthy: {emp.unhealthy_reason || 'needs attention'}</span>
                    )}
                  </div>
                </div>
              </Link>

              {/* Controls stay aligned on desktop and wrap below the identity on mobile. */}
              <div className="ml-11 flex flex-shrink-0 items-center gap-3 md:ml-0">
                {/* Toggle switch */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleActive(emp); }}
                  disabled={togglingId === emp.id}
                  className="relative"
                  style={{ width: 36, height: 20 }}
                  title={emp.is_active ? 'Pause agent' : 'Resume agent'}
                  aria-label={emp.is_active ? `Pause ${emp.name}` : `Resume ${emp.name}`}
                >
                  <div
                    className="absolute inset-0 rounded-full transition-colors"
                    style={{
                      background: emp.is_active ? 'var(--accent)' : 'var(--border)',
                    }}
                  />
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full transition-transform bg-white"
                    style={{
                      left: 2,
                      transform: emp.is_active ? 'translateX(16px)' : 'translateX(0)',
                    }}
                  />
                </button>

                {/* Delete */}
                {confirmDelete === emp.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDelete(emp.id)}
                      className="text-[11px] px-2 py-0.5 rounded"
                      style={{ background: 'var(--error)', color: 'white' }}
                    >
                      Confirm
                    </button>
                    <button onClick={() => setConfirmDelete(null)}>
                      <X size={12} style={{ color: 'var(--muted)' }} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(emp.id)}
                    className="p-1 rounded"
                    style={{ color: 'var(--muted)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
                    title="Delete agent"
                    aria-label={`Delete ${emp.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
    </div>
  );
}
