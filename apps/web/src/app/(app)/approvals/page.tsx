'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';

type PendingAction = {
  id: string;
  action: string;
  params: Record<string, unknown>;
  approval_tier: string;
  created_at: string;
  agent_employee_id: string | null;
  employee_name: string | null;
  employee_slug: string | null;
  employee_avatar: string | null;
  proposer: 'employee' | 'defty';
};

type Toast = { id: string; kind: 'success' | 'error'; text: string };

export default function ApprovalsPage() {
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/agent/actions/pending');
      if (res.ok) {
        const data = await res.json();
        setPending(data.actions ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  const handleApprove = useCallback(
    async (id: string) => {
      const action = pending.find((p) => p.id === id);
      const res = await api.post(`/api/agent/actions/${id}/approve`, {});
      if (res.ok) {
        setPending((prev) => prev.filter((p) => p.id !== id));
        flash('success', `Approved${action ? ` ${action.action}` : ''}`);
      } else {
        const body = await res.json().catch(() => ({} as { error?: string }));
        flash('error', body.error ?? 'Failed to approve');
      }
    },
    [pending, flash],
  );

  const handleReject = useCallback(
    async (id: string) => {
      const action = pending.find((p) => p.id === id);
      const res = await api.post(`/api/agent/actions/${id}/reject`, {});
      if (res.ok) {
        setPending((prev) => prev.filter((p) => p.id !== id));
        flash('success', `Rejected${action ? ` ${action.action}` : ''}`);
      } else {
        flash('error', 'Failed to reject');
      }
    },
    [pending, flash],
  );

  // Map PendingAction → AgentAction shape that AgentActionCard expects.
  // Pending items have no `status` so the card renders its approve/reject UI.
  const toCardAction = (p: PendingAction): AgentAction => ({
    id: p.id,
    action: p.action,
    params: p.params as Record<string, unknown>,
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-6 py-8">
        <header className="mb-6">
          <h1
            className="text-[20px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            Approvals
          </h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
            Pending agent actions awaiting your review.
          </p>
        </header>

        {loading ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Loading...
          </p>
        ) : pending.length === 0 ? (
          <div
            className="text-[13px] py-12 text-center rounded-lg"
            style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}
          >
            No pending approvals. Routine actions auto-execute per trust level.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {pending.map((p) => (
              <AgentActionCard
                key={p.id}
                action={toCardAction(p)}
                onApprove={() => handleApprove(p.id)}
                onReject={() => handleReject(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-[120] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="text-[12px] px-4 py-2 rounded-lg font-medium"
            style={{
              background: t.kind === 'success' ? 'var(--success)' : 'var(--danger)',
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
