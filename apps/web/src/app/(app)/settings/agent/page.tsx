'use client';
import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';

type Action = {
  id: string;
  action: string;
  params: any;
  approval_status: string;
  created_at: string;
  user_id: string;
  agent_employee_id?: string | null;
  source?: string | null;
  error?: string | null;
};

type Employee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  kind?: 'native' | 'openclaw' | 'claude_sdk' | 'custom_mcp';
  trust_level: string;
  is_active: boolean;
  avatar_url?: string | null;
  connection_status?: 'pending' | 'connected' | 'error' | 'revoked';
  connection_url?: string | null;
  template_slug?: string | null;
  template_version?: string | null;
  trigger_subscriptions?: string[] | null;
  provider_hint?: string | null;
  last_heartbeat_at?: string | null;
  pending_action_count?: number;
  recent_turn_count_24h?: number;
  last_turn_at?: string | null;
  avg_latency_ms_24h?: number | null;
};

type PendingAction = {
  id: string;
  action: string;
  params: any;
  approval_tier: string;
  created_at: string;
  agent_employee_id: string | null;
  employee_name: string | null;
  employee_slug: string | null;
  employee_avatar: string | null;
  employee_kind: string | null;
  proposer: 'employee' | 'defty';
};

type Turn = {
  id: string;
  trigger_kind: string;
  space_id: string | null;
  latency_ms: number;
  model_name: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  result: string;
  raw_reply_text: string | null;
  error: string | null;
  created_at: string;
};

type Toast = { id: string; kind: 'success' | 'error' | 'info'; text: string };

const TRUST_LEVELS = [
  { value: 'conservative', label: 'Conservative', desc: 'Every action requires your approval.' },
  { value: 'standard', label: 'Standard', desc: 'Routine actions auto-execute. Complex ones need approval.' },
  { value: 'autonomous', label: 'Autonomous', desc: 'All actions auto-execute except external writes.' },
];

const KIND_STYLES: Record<string, { label: string; bg: string; fg: string }> = {
  native: { label: 'Native', bg: 'rgba(168, 85, 247, 0.15)', fg: '#a855f7' },
  openclaw: { label: 'OpenClaw', bg: 'rgba(245, 158, 11, 0.15)', fg: '#f59e0b' },
  claude_sdk: { label: 'Claude SDK', bg: 'rgba(59, 130, 246, 0.15)', fg: '#3b82f6' },
  custom_mcp: { label: 'Custom MCP', bg: 'rgba(100, 116, 139, 0.15)', fg: '#64748b' },
};

const CONNECTION_COLORS: Record<string, string> = {
  connected: '#10b981',
  pending: '#eab308',
  error: '#ef4444',
  revoked: '#94a3b8',
};

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function AgentSettingsPage() {
  const [actions, setActions] = useState<Action[]>([]);
  const [trustLevel, setTrustLevel] = useState('conservative');
  const [saving, setSaving] = useState(false);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);

  const [drawerEmp, setDrawerEmp] = useState<Employee | null>(null);
  const [drawerTurns, setDrawerTurns] = useState<Turn[]>([]);
  const [drawerTurnsLoading, setDrawerTurnsLoading] = useState(false);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);

  const [rejectTarget, setRejectTarget] = useState<PendingAction | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [toasts, setToasts] = useState<Toast[]>([]);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const fetchActions = useCallback(async () => {
    const res = await api.get('/api/agent/actions');
    if (res.ok) setActions(await res.json());
  }, []);

  const fetchEmployees = useCallback(async () => {
    setEmployeesLoading(true);
    try {
      const res = await api.get('/api/agent-employees?expand=stats');
      if (res.ok) setEmployees(await res.json());
    } finally {
      setEmployeesLoading(false);
    }
  }, []);

  const fetchPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const res = await api.get('/api/agent/actions/pending');
      if (res.ok) {
        const data = await res.json();
        setPending(data.actions || []);
      }
    } finally {
      setPendingLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchActions();
    void fetchEmployees();
    void fetchPending();
    void (async () => {
      const res = await api.get('/api/agent/settings');
      if (res.ok) {
        const data = await res.json();
        setTrustLevel(data.trust_level || 'conservative');
      }
    })();
  }, [fetchActions, fetchEmployees, fetchPending]);

  const openDrawer = useCallback(async (emp: Employee) => {
    setDrawerEmp(emp);
    setDrawerTurns([]);
    setExpandedTurn(null);
    setDrawerTurnsLoading(true);
    try {
      const res = await api.get(`/api/agent-employees/${emp.id}/turns`);
      if (res.ok) {
        const data = await res.json();
        setDrawerTurns(data.turns || []);
      }
    } finally {
      setDrawerTurnsLoading(false);
    }
  }, []);

  const scrollToPending = useCallback(() => {
    const el = document.getElementById('pending-approvals-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const approvePending = useCallback(
    async (p: PendingAction) => {
      const res = await api.post(`/api/agent/actions/${p.id}/approve`, {});
      if (res.ok) {
        setPending((prev) => prev.filter((x) => x.id !== p.id));
        flash('success', `Approved ${p.action}`);
        void fetchEmployees();
        void fetchActions();
      } else {
        const body = await res.json().catch(() => ({} as any));
        flash('error', body.error || `Failed to approve ${p.action}`);
      }
    },
    [flash, fetchEmployees, fetchActions],
  );

  const doReject = useCallback(async () => {
    if (!rejectTarget) return;
    const p = rejectTarget;
    const res = await api.post(`/api/agent/actions/${p.id}/reject`, {
      reason: rejectReason || undefined,
    });
    if (res.ok) {
      setPending((prev) => prev.filter((x) => x.id !== p.id));
      flash('info', `Rejected ${p.action}`);
      void fetchEmployees();
      void fetchActions();
    } else {
      flash('error', `Failed to reject ${p.action}`);
    }
    setRejectTarget(null);
    setRejectReason('');
  }, [rejectTarget, rejectReason, flash, fetchEmployees, fetchActions]);

  const labels: Record<string, string> = {
    create_task: 'Create task',
    update_task_status: 'Update status',
    assign_task: 'Assign task',
    post_message: 'Post message',
    task_create: 'Create task (MCP)',
    task_update: 'Update task (MCP)',
    message_post: 'Post message (MCP)',
    memory_update: 'Update memory (MCP)',
  };
  const statusColors: Record<string, string> = {
    pending: 'var(--accent)',
    approved: 'var(--success)',
    rejected: 'var(--danger)',
    expired: 'var(--muted)',
  };

  const employeeById = new Map(employees.map((e) => [e.id, e]));

  return (
    <div className="p-6 max-w-[900px]">
      <h2
        className="text-[18px] font-semibold mb-6"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        Agent Settings
      </h2>

      {/* Trust level — unchanged */}
      <div className="mb-8">
        <h3
          className="text-[14px] font-semibold mb-3"
          style={{ color: 'var(--on-surface)', fontFamily: 'var(--font-heading)' }}
        >
          Trust Level
        </h3>
        <div className="grid grid-cols-3 gap-3">
          {TRUST_LEVELS.map((t) => (
            <button
              key={t.value}
              onClick={async () => {
                setTrustLevel(t.value);
                setSaving(true);
                try {
                  await api.patch('/api/agent/settings', { trust_level: t.value });
                } catch {}
                setSaving(false);
              }}
              className="p-4 rounded-lg text-left"
              style={{
                background: trustLevel === t.value ? 'var(--bg-active)' : 'var(--surface-container)',
                border:
                  trustLevel === t.value
                    ? '1px solid var(--primary-container)'
                    : '1px solid transparent',
              }}
            >
              <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>
                {t.label}
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--outline)' }}>
                {t.desc}
              </p>
            </button>
          ))}
        </div>
        {saving && (
          <p className="text-[11px] mt-2" style={{ color: 'var(--outline)' }}>
            Saving...
          </p>
        )}
      </div>

      {/* Employees — Phase 6.5 */}
      <div className="mb-8">
        <h3
          className="text-[14px] font-semibold mb-3"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Employees
        </h3>
        {employeesLoading ? (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading...
          </p>
        ) : employees.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            No agent employees yet.
          </p>
        ) : (
          <div className="space-y-2">
            {employees.map((emp) => {
              const kind = emp.kind ?? 'openclaw';
              const kindStyle = KIND_STYLES[kind] ?? KIND_STYLES.openclaw!;
              const conn = emp.connection_status ?? 'pending';
              const connColor = CONNECTION_COLORS[conn] ?? '#9ca3af';
              const triggers = emp.trigger_subscriptions ?? [];
              const pendingCount = emp.pending_action_count ?? 0;
              return (
                <button
                  key={emp.id}
                  onClick={() => openDrawer(emp)}
                  data-testid={`employee-row-${emp.slug}`}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left hover:opacity-90"
                  style={{
                    background: 'var(--card-bg)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white flex-shrink-0"
                    style={{ background: 'var(--accent)' }}
                  >
                    {emp.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p
                        className="text-[14px] font-medium truncate"
                        style={{ color: 'var(--foreground)' }}
                      >
                        {emp.name}
                      </p>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: kindStyle.bg, color: kindStyle.fg }}
                      >
                        {kindStyle.label}
                      </span>
                      {kind !== 'native' && (
                        <span
                          className="flex items-center gap-1 text-[10px]"
                          style={{ color: 'var(--muted)' }}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: connColor }}
                          />
                          {conn}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {emp.template_slug && (
                        <span
                          className="text-[10px]"
                          style={{ color: 'var(--muted)' }}
                        >
                          {emp.template_slug}
                          {emp.template_version ? `@${emp.template_version}` : ''}
                        </span>
                      )}
                      {triggers.length === 0 ? (
                        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                          No triggers
                        </span>
                      ) : (
                        triggers.map((t) => (
                          <span
                            key={t}
                            className="text-[10px] px-1.5 py-0.5 rounded"
                            style={{
                              background: 'var(--surface-container)',
                              color: 'var(--foreground-secondary)',
                              border: '1px solid var(--border)',
                              fontFamily: 'var(--font-mono, monospace)',
                            }}
                          >
                            {t}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div
                    className="text-right flex flex-col gap-0.5 flex-shrink-0 text-[10px]"
                    style={{ color: 'var(--muted)' }}
                  >
                    <span>{emp.recent_turn_count_24h ?? 0} turns / 24h</span>
                    <span>heartbeat {formatRelative(emp.last_heartbeat_at)}</span>
                  </div>
                  {pendingCount > 0 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        scrollToPending();
                      }}
                      className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                      style={{
                        background: 'var(--accent)',
                        color: 'white',
                      }}
                      data-testid={`employee-pending-${emp.slug}`}
                    >
                      {pendingCount} pending
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Pending approvals — Phase 6.5 */}
      <div className="mb-8" id="pending-approvals-section">
        <h3
          className="text-[14px] font-semibold mb-3"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Pending Approvals
        </h3>
        {pendingLoading ? (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading...
          </p>
        ) : pending.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            No pending approvals. Routine actions auto-execute per trust level.
          </p>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => {
              const emp = p.agent_employee_id ? employeeById.get(p.agent_employee_id) : undefined;
              const kind = (emp?.kind ?? p.employee_kind) ?? 'native';
              const kindStyle = KIND_STYLES[kind] ?? KIND_STYLES.native!;
              const preview = JSON.stringify(p.params ?? {}).slice(0, 80);
              return (
                <div
                  key={p.id}
                  data-testid={`pending-row-${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 rounded-lg"
                  style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium text-white"
                      style={{ background: 'var(--accent)' }}
                    >
                      {(p.employee_name ?? 'Defty').charAt(0).toUpperCase()}
                    </div>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{ background: kindStyle.bg, color: kindStyle.fg }}
                    >
                      {p.proposer === 'employee' ? p.employee_name ?? 'Employee' : 'Defty'}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-[12px] font-medium truncate"
                      style={{
                        color: 'var(--foreground)',
                        fontFamily: 'var(--font-mono, monospace)',
                      }}
                    >
                      {p.action}
                    </p>
                    <p
                      className="text-[11px] truncate"
                      style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono, monospace)' }}
                    >
                      {preview}
                    </p>
                  </div>
                  <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--muted)' }}>
                    {formatRelative(p.created_at)}
                  </span>
                  <button
                    onClick={() => approvePending(p)}
                    data-testid={`approve-${p.id}`}
                    className="text-[11px] px-3 py-1 rounded font-medium"
                    style={{ background: 'var(--accent)', color: 'white' }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => {
                      setRejectTarget(p);
                      setRejectReason('');
                    }}
                    data-testid={`reject-${p.id}`}
                    className="text-[11px] px-3 py-1 rounded"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    Reject
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Action log — unchanged behavior, now with source badge */}
      <h3
        className="text-[14px] font-semibold mb-3"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
      >
        Action Log
      </h3>
      {actions.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          No agent actions yet.
        </p>
      ) : (
        <div className="space-y-1.5">
          {actions.map((a) => {
            const emp = a.agent_employee_id ? employeeById.get(a.agent_employee_id) : undefined;
            const sourceLabel = emp?.name ?? (a.agent_employee_id ? 'Employee' : 'Defty');
            return (
              <div
                key={a.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
              >
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium"
                  style={{
                    background: a.agent_employee_id
                      ? KIND_STYLES.openclaw!.bg
                      : KIND_STYLES.native!.bg,
                    color: a.agent_employee_id
                      ? KIND_STYLES.openclaw!.fg
                      : KIND_STYLES.native!.fg,
                  }}
                >
                  {sourceLabel}
                </span>
                <span style={{ color: 'var(--foreground)' }}>{labels[a.action] || a.action}</span>
                <span className="flex-1 truncate" style={{ color: 'var(--muted)' }}>
                  {a.params?.title || a.params?.task_identifier || a.params?.space_name || ''}
                </span>
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ color: statusColors[a.approval_status] || 'var(--muted)' }}
                >
                  {a.approval_status}
                </span>
                <span style={{ color: 'var(--muted)' }}>
                  {new Date(a.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Drawer */}
      {drawerEmp && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={() => setDrawerEmp(null)}
        >
          <div
            className="w-[480px] h-full overflow-y-auto"
            style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}
            onClick={(e) => e.stopPropagation()}
            data-testid="employee-drawer"
          >
            <div
              className="p-5 flex items-center gap-3 sticky top-0 z-10"
              style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-medium text-white"
                style={{ background: 'var(--accent)' }}
              >
                {drawerEmp.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className="text-[15px] font-semibold truncate"
                  style={{ color: 'var(--foreground)' }}
                >
                  {drawerEmp.name}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    style={{
                      background: (KIND_STYLES[drawerEmp.kind ?? 'openclaw'] ?? KIND_STYLES.openclaw!).bg,
                      color: (KIND_STYLES[drawerEmp.kind ?? 'openclaw'] ?? KIND_STYLES.openclaw!).fg,
                    }}
                  >
                    {(KIND_STYLES[drawerEmp.kind ?? 'openclaw'] ?? KIND_STYLES.openclaw!).label}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                    trust: {drawerEmp.trust_level}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setDrawerEmp(null)}
                className="text-[18px]"
                style={{ color: 'var(--muted)' }}
                aria-label="Close drawer"
                data-testid="drawer-close"
              >
                ×
              </button>
            </div>

            <div className="p-5">
              <button
                disabled
                title="Coming in Phase 10"
                className="w-full text-[12px] px-3 py-2 rounded opacity-50 cursor-not-allowed mb-4"
                style={{ background: 'var(--surface-container)', color: 'var(--muted)', border: '1px solid var(--border)' }}
              >
                Upgrade to autonomous (Coming in Phase 10)
              </button>

              <h4 className="text-[12px] font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
                Recent turns
              </h4>
              {drawerTurnsLoading ? (
                <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  Loading...
                </p>
              ) : drawerTurns.length === 0 ? (
                <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  No recent turns.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {drawerTurns.map((turn) => {
                    const expanded = expandedTurn === turn.id;
                    return (
                      <div
                        key={turn.id}
                        className="rounded px-2 py-1.5 text-[11px]"
                        style={{
                          background: 'var(--card-bg)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <button
                          onClick={() => setExpandedTurn(expanded ? null : turn.id)}
                          className="w-full flex items-center gap-2 text-left"
                          data-testid={`turn-row-${turn.id}`}
                        >
                          <span
                            className="px-1.5 py-0.5 rounded text-[9px] font-medium"
                            style={{
                              background:
                                turn.result === 'success'
                                  ? 'rgba(16,185,129,0.15)'
                                  : 'rgba(239,68,68,0.15)',
                              color: turn.result === 'success' ? '#10b981' : '#ef4444',
                            }}
                          >
                            {turn.result}
                          </span>
                          <span style={{ color: 'var(--foreground)' }}>{turn.trigger_kind}</span>
                          <span className="flex-1" />
                          <span style={{ color: 'var(--muted)' }}>{turn.latency_ms}ms</span>
                          <span style={{ color: 'var(--muted)' }}>
                            {formatRelative(turn.created_at)}
                          </span>
                        </button>
                        {expanded && (
                          <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                            {turn.model_name && (
                              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
                                model: {turn.model_name}
                              </p>
                            )}
                            {turn.raw_reply_text && (
                              <pre
                                className="text-[10px] whitespace-pre-wrap mt-1 p-2 rounded"
                                style={{
                                  background: 'var(--surface-container)',
                                  color: 'var(--foreground-secondary)',
                                  maxHeight: 200,
                                  overflowY: 'auto',
                                }}
                              >
                                {turn.raw_reply_text}
                              </pre>
                            )}
                            {turn.error && (
                              <p className="text-[10px] mt-1" style={{ color: '#ef4444' }}>
                                {turn.error}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pending approvals scoped to this employee */}
              <h4
                className="text-[12px] font-semibold mt-5 mb-2"
                style={{ color: 'var(--foreground)' }}
              >
                Pending approvals
              </h4>
              {pending.filter((p) => p.agent_employee_id === drawerEmp.id).length === 0 ? (
                <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  None pending for this employee.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {pending
                    .filter((p) => p.agent_employee_id === drawerEmp.id)
                    .map((p) => (
                      <div
                        key={p.id}
                        className="rounded px-2 py-1.5 text-[11px]"
                        style={{
                          background: 'var(--card-bg)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <p
                          style={{
                            color: 'var(--foreground)',
                            fontFamily: 'var(--font-mono, monospace)',
                          }}
                        >
                          {p.action}
                        </p>
                        <p
                          className="text-[10px] truncate"
                          style={{ color: 'var(--muted)' }}
                        >
                          {JSON.stringify(p.params ?? {}).slice(0, 80)}
                        </p>
                      </div>
                    ))}
                </div>
              )}

              {/* Connection details for OpenClaw */}
              {(drawerEmp.kind === 'openclaw' || drawerEmp.kind === 'custom_mcp') && (
                <>
                  <h4
                    className="text-[12px] font-semibold mt-5 mb-2"
                    style={{ color: 'var(--foreground)' }}
                  >
                    Connection
                  </h4>
                  <div
                    className="text-[11px] space-y-1 p-2 rounded"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground-secondary)',
                    }}
                  >
                    {drawerEmp.connection_url && (
                      <p>
                        <span style={{ color: 'var(--muted)' }}>url: </span>
                        {drawerEmp.connection_url}
                      </p>
                    )}
                    {drawerEmp.provider_hint && (
                      <p>
                        <span style={{ color: 'var(--muted)' }}>provider: </span>
                        {drawerEmp.provider_hint}
                      </p>
                    )}
                  </div>
                  <button
                    disabled
                    title="Coming in Phase 8"
                    className="mt-2 text-[11px] px-3 py-1.5 rounded opacity-50 cursor-not-allowed"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--muted)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    Regenerate token
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject dialog */}
      {rejectTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setRejectTarget(null)}
        >
          <div
            className="w-full max-w-[400px] rounded-xl p-5 flex flex-col gap-4"
            style={{
              background: 'var(--card-bg)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--glass-shadow)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="text-[0.9375rem] font-semibold"
              style={{ color: 'var(--on-surface)' }}
            >
              Reject action?
            </div>
            <div className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
              Optional reason — this is stored on the audit row.
            </div>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Why are you rejecting this?"
              rows={3}
              data-testid="reject-reason-input"
              className="w-full text-[12px] p-2 rounded"
              style={{
                background: 'var(--surface-container-low)',
                color: 'var(--foreground)',
                border: '1px solid var(--outline-variant)',
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRejectTarget(null)}
                className="px-4 py-2 text-[0.8125rem] rounded-lg font-medium"
                style={{
                  color: 'var(--on-surface-variant)',
                  background: 'var(--surface-container-low)',
                  border: '1px solid var(--outline-variant)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={doReject}
                data-testid="reject-confirm"
                className="px-4 py-2 text-[0.8125rem] rounded-lg font-medium"
                style={{ background: 'var(--danger)', color: '#fff' }}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-[120] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="text-[12px] px-4 py-2 rounded-lg font-medium"
            style={{
              background:
                t.kind === 'success'
                  ? 'var(--success)'
                  : t.kind === 'error'
                  ? 'var(--danger)'
                  : 'var(--accent)',
              color: 'white',
              boxShadow: 'var(--glass-shadow)',
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
