'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Bell, ChevronRight } from 'lucide-react';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';
import { AttentionRow } from '@/components/attention-row';
import { useAttention } from '@/hooks/use-attention';
import { api } from '@/lib/api';

export function NotificationPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const {
    items,
    counts,
    isLoading,
    refresh,
    markSeen,
    acknowledge,
    resolve,
    snooze,
    markAllSeen,
  } = useAttention({ lane: 'needs_you', state: 'open', limit: 12 });

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const mutateApproval = async (actionId: string, action: 'approve' | 'reject') => {
    const response = await api.post(`/api/agent/actions/${actionId}/${action}`, {});
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `${action} failed`);
    }
    const result = await response.json().catch(() => ({ status: action === 'approve' ? 'approved' : 'rejected' }));
    await refresh();
    return result;
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Needs your attention"
      className="fixed bottom-0 left-0 right-0 z-[9999] flex max-h-[70vh] flex-col overflow-hidden rounded-t-2xl md:absolute md:bottom-auto md:left-auto md:right-0 md:top-full md:mt-2 md:max-h-[540px] md:w-[380px] md:rounded-xl"
      style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
        <div>
          <p className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Needs you</p>
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>{counts.needs_you.count} open</p>
        </div>
        <button type="button" onClick={() => void markAllSeen('needs_you')} disabled={counts.needs_you.unseen === 0} className="deft-pill min-h-[30px] disabled:opacity-45">
          Mark seen
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        {isLoading ? (
          <p className="py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12" style={{ color: 'var(--muted)' }}>
            <Bell size={22} strokeWidth={1.5} />
            <span className="text-[13px]">Nothing is waiting on you.</span>
          </div>
        ) : items.map((item) => {
          if (item.kind === 'approval' && item.approval) {
            const action: AgentAction = {
              id: item.approval.id,
              action: item.approval.action,
              params: item.approval.params,
              created_at: item.created_at,
              approval_tier: item.approval.approval_tier,
              employee_name: item.approval.employee_name,
            };
            return (
              <div key={item.id} className="py-2">
                <AgentActionCard
                  action={action}
                  variant="compact"
                  onApprove={() => mutateApproval(action.id, 'approve')}
                  onReject={() => mutateApproval(action.id, 'reject')}
                />
              </div>
            );
          }
          return (
            <AttentionRow
              key={item.id}
              item={item}
              onSeen={() => { void markSeen(item.id); }}
              onAcknowledge={() => { void acknowledge(item.id); }}
              onResolve={() => { void resolve(item.id); }}
              onSnooze={() => { void snooze(item.id, new Date(Date.now() + 60 * 60 * 1000)); }}
            />
          );
        })}
      </div>

      <Link href="/inbox" onClick={onClose} className="flex shrink-0 items-center justify-center gap-1 border-t px-4 py-2.5 text-[12px] font-medium" style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}>
        Open Inbox <ChevronRight size={13} />
      </Link>
    </div>
  );
}
