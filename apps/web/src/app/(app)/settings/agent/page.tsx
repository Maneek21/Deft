'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { MoreHorizontal, Terminal, Webhook, Copy, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { ReceiptViewer } from '@/components/receipt-viewer';
import { ConfirmDangerous } from '@/components/confirm-dangerous';
import { SessionTurnCard, type SessionTurn } from '@/components/session-turn-card';

// Phase 10 — mirrors apps/api/src/lib/model-pricing.ts. Kept in sync by hand
// because the cost column is advisory only.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-4-6': { input: 15, output: 75 },
  'anthropic/claude-sonnet-4-6': { input: 3, output: 15 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

function computeTurnCostUsd(
  modelName: string | null | undefined,
  tin: number | null | undefined,
  tout: number | null | undefined,
): number | null {
  if (!modelName) return null;
  const p = MODEL_PRICING[modelName];
  if (!p) return null;
  return ((tin ?? 0) / 1_000_000) * p.input + ((tout ?? 0) / 1_000_000) * p.output;
}

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
  has_receipt?: boolean;
};

type Employee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  trust_level: string;
  is_active: boolean;
  avatar_url?: string | null;
  trigger_subscriptions?: string[] | null;
  last_heartbeat_at?: string | null;
  pending_action_count?: number;
  recent_turn_count_24h?: number;
  last_turn_at?: string | null;
  avg_latency_ms_24h?: number | null;
};

type Turn = SessionTurn;

type Toast = { id: string; kind: 'success' | 'error' | 'info'; text: string };

const TRUST_LEVELS = [
  { value: 'conservative', label: 'Conservative', desc: 'Every action requires your approval.' },
  { value: 'standard', label: 'Standard', desc: 'Routine actions auto-execute. Complex ones need approval.' },
  { value: 'autonomous', label: 'Autonomous', desc: 'All actions auto-execute except external writes.' },
];

// Visual treatment for proposer badges. Defty (built-in) vs BYOA employees.
const PROPOSER_STYLE = {
  defty: { label: 'Defty', bg: 'rgba(168, 85, 247, 0.15)', fg: '#a855f7' },
  employee: { label: 'BYOA', bg: 'rgba(245, 158, 11, 0.15)', fg: '#f59e0b' },
} as const;

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
  // Block UX-sweep — per-employee kebab menu state. Stores the id of the
  // open menu, or null.
  const [rowMenuOpen, setRowMenuOpen] = useState<string | null>(null);
  const [rowActionBusy, setRowActionBusy] = useState<string | null>(null);
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const [saveTemplateFor, setSaveTemplateFor] = useState<Employee | null>(null);

  // Close the kebab menu when clicking outside it OR pressing Escape.
  useEffect(() => {
    if (!rowMenuOpen) return undefined;
    const onDown = () => setRowMenuOpen(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRowMenuOpen(null);
    };
    // Attach on the next tick so the click that opened doesn't instantly close.
    const t = setTimeout(() => document.addEventListener('click', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [rowMenuOpen]);

  const handleCloneEmployee = useCallback(async (emp: Employee) => {
    setRowActionBusy(emp.id);
    setRowActionError(null);
    try {
      const res = await api.post(`/api/agent-employees/${emp.id}/clone`, {});
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      await res.json();
      // Refetch list so the new row appears
      const listRes = await api.get('/api/agent-employees');
      if (listRes.ok) setEmployees(await listRes.json());
    } catch (err) {
      setRowActionError(`Clone failed: ${(err as Error).message}`);
      setTimeout(() => setRowActionError(null), 4000);
    } finally {
      setRowActionBusy(null);
      setRowMenuOpen(null);
    }
  }, []);

  const [drawerEmp, setDrawerEmp] = useState<Employee | null>(null);
  const [drawerTurns, setDrawerTurns] = useState<Turn[]>([]);
  const [drawerTurnsLoading, setDrawerTurnsLoading] = useState(false);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [turnsLimit, setTurnsLimit] = useState(20);
  const [turnFilterTrigger, setTurnFilterTrigger] = useState<string>('');
  const [turnFilterResult, setTurnFilterResult] = useState<string>('');
  const [turnReceiptActionId, setTurnReceiptActionId] = useState<string | null>(null);
  const [turnReceiptIds, setTurnReceiptIds] = useState<Record<string, string>>({});

  // Phase 10 — typed-confirmation modals for the drawer's destructive actions.
  const [confirmAutonomous, setConfirmAutonomous] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);

  // Phase 7 — signed receipt viewer modal state.
  const [receiptActionId, setReceiptActionId] = useState<string | null>(null);

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

  useEffect(() => {
    void fetchActions();
    void fetchEmployees();
    void (async () => {
      const res = await api.get('/api/agent/settings');
      if (res.ok) {
        const data = await res.json();
        setTrustLevel(data.trust_level || 'conservative');
      }
    })();
  }, [fetchActions, fetchEmployees]);

  const fetchTurns = useCallback(
    async (empId: string, limit: number, trigger: string, result: string) => {
      setDrawerTurnsLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (trigger) params.set('trigger_kind', trigger);
        if (result) params.set('result', result);
        const res = await api.get(`/api/agent-employees/${empId}/turns?${params}`);
        if (res.ok) {
          const data = await res.json();
          setDrawerTurns(data.turns || []);
        }
      } finally {
        setDrawerTurnsLoading(false);
      }
    },
    [],
  );

  const openDrawer = useCallback(
    async (emp: Employee) => {
      setDrawerEmp(emp);
      setDrawerTurns([]);
      setExpandedTurn(null);
      setTurnsLimit(20);
      setTurnFilterTrigger('');
      setTurnFilterResult('');
      setTurnReceiptIds({});
      await fetchTurns(emp.id, 20, '', '');
    },
    [fetchTurns],
  );

  // Refetch turns when filters/limit change while the drawer is open.
  useEffect(() => {
    if (!drawerEmp) return;
    void fetchTurns(drawerEmp.id, turnsLimit, turnFilterTrigger, turnFilterResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnsLimit, turnFilterTrigger, turnFilterResult]);

  // Probe the receipt proxy lazily when the user expands a turn.
  const checkReceipt = useCallback(
    async (turnId: string) => {
      if (!drawerEmp) return;
      if (turnReceiptIds[turnId]) return; // already resolved
      const res = await api.get(
        `/api/agent-employees/${drawerEmp.id}/turns/${turnId}/receipt`,
      );
      if (res.ok) {
        const data = await res.json();
        if (data.action_id) {
          setTurnReceiptIds((prev) => ({ ...prev, [turnId]: data.action_id }));
        }
      }
    },
    [drawerEmp, turnReceiptIds],
  );

  const upgradeToAutonomous = useCallback(async () => {
    if (!drawerEmp) return;
    const res = await api.patch(`/api/agent-employees/${drawerEmp.id}`, {
      trust_level: 'autonomous',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      throw new Error(body.error || 'Failed to upgrade trust level');
    }
    setDrawerEmp({ ...drawerEmp, trust_level: 'autonomous' });
    setEmployees((prev) =>
      prev.map((e) => (e.id === drawerEmp.id ? { ...e, trust_level: 'autonomous' } : e)),
    );
    flash('success', `${drawerEmp.name} upgraded to autonomous`);
  }, [drawerEmp, flash]);

  const deleteEmployee = useCallback(async () => {
    if (!drawerEmp) return;
    const res = await api.delete(`/api/agent-employees/${drawerEmp.id}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      throw new Error(body.error || 'Failed to delete employee');
    }
    setEmployees((prev) => prev.filter((e) => e.id !== drawerEmp.id));
    flash('info', `${drawerEmp.name} deleted`);
    setDrawerEmp(null);
  }, [drawerEmp, flash]);

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
    <div className="h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-[900px] p-4 sm:p-6">
      <div className="mb-6">
        <h1
          className="text-[18px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Agent governance
        </h1>
        <p className="text-[12px] mt-1 max-w-[640px]" style={{ color: 'var(--muted)' }}>
          Set global trust rails for Defty and shared agent employees, then review approvals, receipts, and agent health from one place.
        </p>
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto" aria-label="Agent employee settings">
        <Link href="/settings/agent-employees" className="deft-pill" style={{ color: 'var(--muted)' }}>Employees</Link>
        <Link href="/settings/agent" className="deft-pill" data-active={true}>Governance & audit</Link>
      </nav>

      {/* Approvals moved banner */}
      <div
        className="mb-4 px-4 py-3 rounded-lg text-[13px]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
      >
        Pending approvals moved to{' '}
        <Link href="/inbox?tab=approvals" className="underline" style={{ color: 'var(--accent)' }}>Inbox &gt; Approvals</Link>.
      </div>

      {/* Trust level — unchanged */}
      <div className="mb-8">
        <h3
          className="text-[14px] font-semibold mb-3"
          style={{ color: 'var(--on-surface)', fontFamily: 'var(--font-heading)' }}
        >
          Trust Level
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
        <div className="flex items-center justify-between mb-3">
          <h3
            className="text-[14px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Employees
          </h3>
          <a
            href="/settings/agent-employees/create"
            data-testid="connect-agent"
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Connect agent
          </a>
        </div>
        {employeesLoading ? (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Loading...
          </p>
        ) : employees.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            No agent employees yet.
          </p>
        ) : (
          <>
          {rowActionError && (
            <div
              className="mb-2 rounded px-3 py-2 text-[12px]"
              style={{ background: 'rgba(239,68,68,0.1)', color: '#EF4444' }}
            >
              {rowActionError}
            </div>
          )}
          <div className="space-y-2">
            {employees.map((emp) => {
              const triggers = emp.trigger_subscriptions ?? [];
              const pendingCount = emp.pending_action_count ?? 0;
              return (
                <div
                  key={emp.id}
                  data-testid={`employee-row-${emp.slug}`}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg relative"
                  style={{
                    background: 'var(--card-bg)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => openDrawer(emp)}
                    className="absolute inset-0 rounded-lg hover:opacity-90"
                    style={{ zIndex: 0 }}
                    aria-label={`Open drawer for ${emp.name}`}
                  />
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-medium text-white flex-shrink-0 relative z-10 pointer-events-none"
                    style={{ background: 'var(--accent)' }}
                  >
                    {emp.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0 relative z-10 pointer-events-none">
                    <div className="flex items-center gap-2">
                      <p
                        className="text-[14px] font-medium truncate"
                        style={{ color: 'var(--foreground)' }}
                      >
                        {emp.name}
                      </p>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: PROPOSER_STYLE.employee.bg, color: PROPOSER_STYLE.employee.fg }}
                      >
                        {PROPOSER_STYLE.employee.label}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
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
                    className="text-right flex flex-col gap-0.5 flex-shrink-0 text-[10px] relative z-10 pointer-events-none"
                    style={{ color: 'var(--muted)' }}
                  >
                    <span>{emp.recent_turn_count_24h ?? 0} turns / 24h</span>
                    <span>heartbeat {formatRelative(emp.last_heartbeat_at)}</span>
                  </div>
                  {pendingCount > 0 && (
                    <Link
                      href="/approvals"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 relative z-10"
                      style={{
                        background: 'var(--accent)',
                        color: 'white',
                      }}
                      data-testid={`employee-pending-${emp.slug}`}
                    >
                      {pendingCount} pending
                    </Link>
                  )}
                  {/* UX sweep — per-employee kebab menu. Keeps the big-click
                      drawer affordance AND surfaces the deep links that
                      were previously URL-only. */}
                  <div className="relative z-10 flex-shrink-0">
                    <button
                      type="button"
                      aria-label={`More actions for ${emp.name}`}
                      data-testid={`employee-menu-${emp.slug}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRowMenuOpen(rowMenuOpen === emp.id ? null : emp.id);
                      }}
                      className="p-1.5 rounded hover:bg-accent/60"
                      style={{ color: 'var(--muted)' }}
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                    {rowMenuOpen === emp.id && (
                      <div
                        className="absolute right-0 top-full mt-1 w-56 rounded-md border py-1 shadow-lg"
                        style={{
                          background: 'var(--card-bg)',
                          borderColor: 'var(--border)',
                          zIndex: 30,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* Personality page was retired in PR 1 of the
                            self-hosted v1 reframe — it edited SOUL.md
                            files via the BYOA gateway. Native agents
                            edit their system_prompt on the detail page;
                            BYOA agents own their prompt in the user's own
                            codebase. */}
                        <Link
                          href={`/settings/agent-employees/${emp.id}/developer`}
                          className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-accent/40"
                          style={{ color: 'var(--foreground)' }}
                          onClick={() => setRowMenuOpen(null)}
                        >
                          <Terminal className="size-3.5" /> Developer
                        </Link>
                        <Link
                          href={`/settings/agent-employees/${emp.id}/webhooks`}
                          className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-accent/40"
                          style={{ color: 'var(--foreground)' }}
                          onClick={() => setRowMenuOpen(null)}
                        >
                          <Webhook className="size-3.5" /> Webhooks
                        </Link>
                        <div className="my-1 h-px" style={{ background: 'var(--border)' }} />
                        <button
                          type="button"
                          onClick={() => handleCloneEmployee(emp)}
                          disabled={rowActionBusy === emp.id}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40 disabled:opacity-50"
                          style={{ color: 'var(--foreground)' }}
                        >
                          <Copy className="size-3.5" />
                          {rowActionBusy === emp.id ? 'Cloning…' : 'Clone agent'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSaveTemplateFor(emp);
                            setRowMenuOpen(null);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40"
                          style={{ color: 'var(--foreground)' }}
                        >
                          <FileText className="size-3.5" /> Save as template
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          </>
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
                      ? PROPOSER_STYLE.employee.bg
                      : PROPOSER_STYLE.defty.bg,
                    color: a.agent_employee_id
                      ? PROPOSER_STYLE.employee.fg
                      : PROPOSER_STYLE.defty.fg,
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
                {a.has_receipt && (
                  <button
                    onClick={() => setReceiptActionId(a.id)}
                    data-testid={`view-receipt-${a.id}`}
                    className="text-[10px] px-2 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--foreground-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    View receipt
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Phase 7 — signed receipt viewer modal */}
      {receiptActionId && (
        <ReceiptViewer
          actionId={receiptActionId}
          isOpen={receiptActionId !== null}
          onClose={() => setReceiptActionId(null)}
        />
      )}

      {/* Phase 10 — turn-scoped receipt viewer (from the drawer) */}
      {turnReceiptActionId && (
        <ReceiptViewer
          actionId={turnReceiptActionId}
          isOpen={turnReceiptActionId !== null}
          onClose={() => setTurnReceiptActionId(null)}
        />
      )}

      {/* Phase 10 — trust upgrade to autonomous */}
      {drawerEmp && (
        <ConfirmDangerous
          open={confirmAutonomous}
          onClose={() => setConfirmAutonomous(false)}
          title="Upgrade trust level to AUTONOMOUS?"
          body={
            <>
              <p className="mb-2">
                Autonomous trust auto-executes all write actions except posting to
                chat. Every action will still produce a signed receipt in the action
                log.
              </p>
              <p>This cannot be undone without another confirmation.</p>
            </>
          }
          confirmWord="AUTONOMOUS"
          confirmLabel="Upgrade trust level"
          variant="warning"
          onConfirm={upgradeToAutonomous}
          testId="confirm-upgrade-autonomous"
        />
      )}

      {/* Phase 10 — delete employee */}
      {drawerEmp && (
        <ConfirmDangerous
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={`Delete ${drawerEmp.name}?`}
          body={
            <>
              <p className="mb-2">
                Soft-deletes the employee and revokes its API key. Pending
                approvals are marked expired. You can still access the audit
                log afterwards.
              </p>
              <p>
                Type the employee slug to confirm —{' '}
                <span className="font-mono">{drawerEmp.slug}</span>
              </p>
            </>
          }
          confirmWord={drawerEmp.slug}
          confirmLabel="Delete employee"
          variant="danger"
          onConfirm={deleteEmployee}
          testId="confirm-delete-employee"
        />
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
                      background: PROPOSER_STYLE.employee.bg,
                      color: PROPOSER_STYLE.employee.fg,
                    }}
                  >
                    {PROPOSER_STYLE.employee.label}
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
              {/* Phase 10 — destructive action gates */}
              <div className="flex gap-2 mb-4">
                {drawerEmp.trust_level !== 'autonomous' ? (
                  <button
                    onClick={() => setConfirmAutonomous(true)}
                    className="flex-1 text-[12px] px-3 py-2 rounded font-medium"
                    style={{
                      background: 'var(--warning, #f59e0b)',
                      color: 'white',
                    }}
                    data-testid="upgrade-autonomous-btn"
                  >
                    Upgrade to autonomous
                  </button>
                ) : (
                  <div
                    className="flex-1 text-[11px] px-3 py-2 rounded text-center"
                    style={{
                      background: 'var(--surface-container)',
                      color: 'var(--muted)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    Trust: autonomous
                  </div>
                )}
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-[12px] px-3 py-2 rounded font-medium"
                  style={{
                    background: 'transparent',
                    color: 'var(--danger, #ef4444)',
                    border: '1px solid var(--danger, #ef4444)',
                  }}
                  data-testid="delete-employee-btn"
                >
                  Delete
                </button>
              </div>

              {/* Recent turns header + filter bar */}
              <div className="flex items-center justify-between mb-2">
                <h4
                  className="text-[12px] font-semibold"
                  style={{ color: 'var(--foreground)' }}
                >
                  Recent turns
                </h4>
                <div className="flex gap-1.5">
                  <select
                    value={turnFilterTrigger}
                    onChange={(e) => {
                      setTurnsLimit(20);
                      setTurnFilterTrigger(e.target.value);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-container-low, var(--surface))',
                      color: 'var(--foreground-secondary)',
                      border: '1px solid var(--border)',
                    }}
                    data-testid="turn-filter-trigger"
                  >
                    <option value="">all triggers</option>
                    <option value="chat_mention">chat_mention</option>
                    <option value="cron">cron</option>
                    <option value="webhook">webhook</option>
                    <option value="event">event</option>
                  </select>
                  <select
                    value={turnFilterResult}
                    onChange={(e) => {
                      setTurnsLimit(20);
                      setTurnFilterResult(e.target.value);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'var(--surface-container-low, var(--surface))',
                      color: 'var(--foreground-secondary)',
                      border: '1px solid var(--border)',
                    }}
                    data-testid="turn-filter-result"
                  >
                    <option value="">all results</option>
                    <option value="success">success</option>
                    <option value="error">error</option>
                    <option value="timeout">timeout</option>
                    <option value="rejected_approval">rejected</option>
                  </select>
                </div>
              </div>

              {drawerTurnsLoading ? (
                <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  Loading...
                </p>
              ) : drawerTurns.length === 0 ? (
                <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  No recent turns.
                </p>
              ) : (
                <>
                  <div className="space-y-1.5">
                    {drawerTurns.map((turn) => {
                      const expanded = expandedTurn === turn.id;
                      const cost = computeTurnCostUsd(
                        turn.model_name,
                        turn.tokens_in,
                        turn.tokens_out,
                      );
                      const receiptActionId = turnReceiptIds[turn.id];
                      return (
                        <SessionTurnCard
                          key={turn.id}
                          turn={turn}
                          expanded={expanded}
                          costUsd={cost}
                          receiptAvailable={Boolean(receiptActionId)}
                          onViewReceipt={
                            receiptActionId
                              ? () => setTurnReceiptActionId(receiptActionId)
                              : undefined
                          }
                          onToggle={() => {
                            const next = expanded ? null : turn.id;
                            setExpandedTurn(next);
                            if (next) void checkReceipt(turn.id);
                          }}
                        />
                      );
                    })}
                  </div>
                  {drawerTurns.length >= turnsLimit && turnsLimit < 100 && (
                    <button
                      onClick={() => setTurnsLimit(Math.min(turnsLimit + 20, 100))}
                      className="w-full mt-2 text-[11px] py-1.5 rounded"
                      style={{
                        background: 'var(--surface-container)',
                        color: 'var(--foreground-secondary)',
                        border: '1px solid var(--border)',
                      }}
                      data-testid="turns-load-more"
                    >
                      Load more
                    </button>
                  )}
                </>
              )}

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
    {/* UX sweep — save-as-template modal */}
    {saveTemplateFor && (
      <SaveAsTemplateModal
        employee={saveTemplateFor}
        onClose={() => setSaveTemplateFor(null)}
        onSuccess={(msg) => {
          flash('success', msg);
          setSaveTemplateFor(null);
        }}
      />
    )}
    </div>
  );
}

// UX sweep — modal that collects slug/name/description and POSTs
// to /save-as-template.
function SaveAsTemplateModal({
  employee,
  onClose,
  onSuccess,
}: {
  employee: { id: string; name: string; slug: string };
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const [slug, setSlug] = useState(`${employee.slug}-template`);
  const [name, setName] = useState(`${employee.name} (template)`);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.post(`/api/agent-employees/${employee.id}/save-as-template`, {
        slug,
        name,
        description: description.trim() || `Template seeded from ${employee.name}`,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onSuccess(`Template "${name}" saved.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg p-5"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-[15px] font-semibold" style={{ color: 'var(--foreground)' }}>
          Save {employee.name} as template
        </h3>
        <p className="mb-3 text-[12px]" style={{ color: 'var(--muted)' }}>
          Templates appear in the Connect agent wizard step 1 for everyone in your org.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9-]+"
              className="mt-1 w-full rounded border px-2 py-1.5 text-[13px] font-mono"
              style={{ background: 'var(--background)', borderColor: 'var(--border)', color: 'var(--foreground)' }}
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1.5 text-[13px]"
              style={{ background: 'var(--background)', borderColor: 'var(--border)', color: 'var(--foreground)' }}
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Short description shown in the wizard"
              className="mt-1 w-full rounded border px-2 py-1.5 text-[13px]"
              style={{ background: 'var(--background)', borderColor: 'var(--border)', color: 'var(--foreground)' }}
            />
          </div>
        </div>
        {error && <div className="mt-2 text-[12px]" style={{ color: '#EF4444' }}>{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-3 py-1.5 text-[12px]"
            style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !slug || !name}
            className="rounded px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  );
}
