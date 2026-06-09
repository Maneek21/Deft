'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Trash2, X, Plus, ExternalLink } from 'lucide-react';

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

function connectionStatus(lastHeartbeatAt: string | null): { label: string; color: string } {
  if (!lastHeartbeatAt) return { label: 'Never connected', color: '#9ca3af' };
  const elapsedMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
  if (elapsedMinutes < 5) return { label: 'Connected', color: '#10b981' };
  if (elapsedMinutes < 60) return { label: `Last seen ${elapsedMinutes}m ago`, color: '#f59e0b' };
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return { label: `Last seen ${elapsedHours}h ago`, color: '#f59e0b' };
  return { label: `Last seen ${Math.floor(elapsedHours / 24)}d ago`, color: '#ef4444' };
}

function runtimeLabel(value: string | null | undefined): string {
  return value ? value.replace(/_/g, ' ') : 'custom MCP';
}

export default function AgentEmployeesPage() {
  const [employees, setEmployees] = useState<AgentEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchEmployees = async () => {
    try {
      const res = await api.get('/api/agent-employees?expand=stats');
      if (res.ok) {
        setEmployees(await res.json());
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEmployees();
  }, []);

  const handleToggleActive = async (emp: AgentEmployee) => {
    setTogglingId(emp.id);
    try {
      const endpoint = emp.is_active
        ? `/api/agent-employees/${emp.id}/pause`
        : `/api/agent-employees/${emp.id}/resume`;
      const res = await api.post(endpoint);
      if (res.ok) {
        setEmployees((prev) =>
          prev.map((e) => (e.id === emp.id ? { ...e, is_active: !e.is_active } : e))
        );
      }
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await api.delete(`/api/agent-employees/${id}`);
    if (res.ok) {
      setEmployees((prev) => prev.filter((e) => e.id !== id));
    }
    setConfirmDelete(null);
  };

  return (
    <div className="h-full overflow-y-auto">
    <div className="p-6 max-w-[600px]">
      <div className="flex items-center justify-between mb-4">
        <h2
          className="text-[18px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Agent Employees
        </h2>
        {isSelfHosted ? (
          <Link
            href="/settings/agent-employees/create"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{
              background: 'var(--accent)',
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{
              background: 'var(--accent)',
              color: 'white',
              fontFamily: 'var(--font-heading)',
            }}
          >
            <Plus size={13} />
            Create Agent
          </Link>
        )}
      </div>

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
          {employees.map((emp) => {
            const conn = connectionStatus(emp.last_mcp_call_at ?? emp.last_heartbeat_at);
            return (
            <div
              key={emp.id}
              className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 px-4 py-3 rounded-lg cursor-pointer"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
            >
              {/* Clickable area: avatar + name/role + secondary metadata */}
              <Link
                href={`/settings/agent-employees/${emp.id}/developer`}
                className="flex items-center gap-3 flex-1 min-w-0"
              >
                {/* Avatar */}
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white flex-shrink-0"
                  style={{ background: 'var(--accent)' }}
                >
                  {emp.name.charAt(0).toUpperCase()}
                </div>

                {/* Name, role, and secondary metadata stacked */}
                <div className="flex-1 min-w-0">
                  <p
                    className="text-[14px] font-medium truncate"
                    style={{ color: 'var(--foreground)' }}
                  >
                    {emp.name}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'var(--surface)',
                        color: 'var(--foreground-secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {ROLE_LABELS[emp.role] || emp.role}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {TRUST_LABELS[emp.trust_level] || emp.trust_level}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {emp.daily_action_count ?? 0}/{emp.max_daily_actions} actions
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {runtimeLabel(emp.runtime_kind)} / {emp.wake_mode}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {emp.pending_action_count ?? 0} pending
                    </span>
                    <span
                      className="text-[11px]"
                      style={{ color: emp.certification_status === 'verified' ? '#10b981' : 'var(--muted)' }}
                    >
                      {emp.certification_status}
                    </span>
                    <div className="flex items-center gap-1">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ background: emp.is_active ? '#10b981' : '#9ca3af' }}
                      />
                      <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                        {emp.is_active ? 'Active' : 'Paused'}
                      </span>
                      {emp.heartbeat_enabled && (
                        <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '4px' }}>
                          &#9829; every {emp.heartbeat_interval_min}m
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ background: conn.color }}
                      />
                      <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                        {conn.label}
                      </span>
                    </div>
                    {emp.unhealthy && (
                      <span className="text-[11px]" style={{ color: 'var(--danger)' }}>
                        Unhealthy: {emp.unhealthy_reason || 'needs attention'}
                      </span>
                    )}
                  </div>
                </div>
              </Link>

              {/* Controls row — inline on md+, drops below on mobile */}
              <div className="flex items-center gap-3 flex-shrink-0 ml-12 md:ml-0">
                {/* Toggle switch */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleActive(emp); }}
                  disabled={togglingId === emp.id}
                  className="relative"
                  style={{ width: 36, height: 20 }}
                  title={emp.is_active ? 'Pause agent' : 'Resume agent'}
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
