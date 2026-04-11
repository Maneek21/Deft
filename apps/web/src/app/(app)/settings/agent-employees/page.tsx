'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Trash2, X, Plus, ExternalLink } from 'lucide-react';

type AgentEmployee = {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
  trust_level: string;
  max_daily_actions: number;
  daily_actions_used: number;
  avatar_url: string | null;
  created_at: string;
  heartbeat_enabled: boolean;
  heartbeat_interval_min: number;
};

const ROLE_LABELS: Record<string, string> = {
  project_manager: 'Project Manager',
  engineering_lead: 'Engineering Lead',
  executive_assistant: 'Executive Assistant',
  custom: 'Custom',
};

const TRUST_LABELS: Record<string, string> = {
  conservative: 'Conservative',
  standard: 'Standard',
  autonomous: 'Autonomous',
};

const isSelfHosted = process.env.NEXT_PUBLIC_DEFT_SELF_HOSTED === 'true';

export default function AgentEmployeesPage() {
  const [employees, setEmployees] = useState<AgentEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchEmployees = async () => {
    try {
      const res = await api.get('/api/agent-employees');
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
          {employees.map((emp) => (
            <div
              key={emp.id}
              className="flex items-center gap-3 px-4 py-3 rounded-lg"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
            >
              {/* Avatar */}
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white flex-shrink-0"
                style={{ background: 'var(--accent)' }}
              >
                {emp.name.charAt(0).toUpperCase()}
              </div>

              {/* Name & role */}
              <div className="flex-1 min-w-0">
                <p
                  className="text-[14px] font-medium truncate"
                  style={{ color: 'var(--foreground)' }}
                >
                  {emp.name}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
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
                </div>
              </div>

              {/* Daily actions */}
              <div className="text-right flex-shrink-0 mr-1">
                <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  {emp.daily_actions_used ?? 0}/{emp.max_daily_actions} actions
                </p>
              </div>

              {/* Status indicator */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: emp.is_active ? '#10b981' : '#9ca3af' }}
                />
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  {emp.is_active ? 'Active' : 'Paused'}
                </span>
                {emp.heartbeat_enabled && (
                  <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '8px' }}>
                    &#9829; every {emp.heartbeat_interval_min}m
                  </span>
                )}
              </div>

              {/* Toggle switch */}
              <button
                onClick={() => handleToggleActive(emp)}
                disabled={togglingId === emp.id}
                className="relative flex-shrink-0"
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
                <div className="flex items-center gap-1 flex-shrink-0">
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
                  className="p-1 rounded flex-shrink-0"
                  style={{ color: 'var(--muted)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
                  title="Delete agent"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
