'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, ChevronRight } from 'lucide-react';
import { useInbox, type InboxItem } from '@/hooks/use-inbox';
import { InboxRow } from '@/components/inbox-row';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';
import { api } from '@/lib/api';

type Props = {
  onClose: () => void;
};

export function NotificationPanel({ onClose }: Props) {
  const router = useRouter();
  const { items, isLoading, markRead, markAllRead, refresh } = useInbox();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleApprovalNav = (item: InboxItem) => {
    void markRead([item.id]);
    router.push(`/inbox?tab=${item.kind === 'work_capture' ? 'captures' : 'approvals'}`);
    onClose();
  };

  const handleApprove = async (item: InboxItem) => {
    if (!item.approval) return;
    const res = await api.post(`/api/agent/actions/${item.approval.action_id}/approve`, {});
    if (!res.ok) throw new Error(`Approve failed (${res.status})`);
    await markRead([item.id]);
    void refresh();
  };

  const handleReject = async (item: InboxItem) => {
    if (!item.approval) return;
    const res = await api.post(`/api/agent/actions/${item.approval.action_id}/reject`, {});
    if (!res.ok) throw new Error(`Reject failed (${res.status})`);
    await markRead([item.id]);
    void refresh();
  };

  const handleRowClick = (item: InboxItem) => {
    void markRead([item.id]);
    // InboxRow wraps content in a Link if item.link exists; navigation happens there.
    onClose();
  };

  return (
    <div
      ref={ref}
      className="fixed bottom-0 left-0 right-0 z-[9999] max-h-[70vh] flex flex-col overflow-hidden rounded-t-2xl md:rounded-xl md:absolute md:bottom-auto md:left-auto md:right-0 md:top-full md:mt-2 md:w-[360px] md:max-h-[520px]"
      style={{
        background: 'var(--surface-container-highest)',
        boxShadow: 'var(--glass-shadow)',
        backdropFilter: 'blur(12px)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center justify-between flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <span
          className="text-[13px] font-semibold"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
        >
          Notifications
        </span>
        <button
          onClick={() => void markAllRead()}
          className="text-[11px] font-medium px-2 py-2 md:py-1 rounded-md min-h-[36px] flex items-center"
          style={{ color: 'var(--accent)', fontFamily: 'var(--font-body)' }}
        >
          Mark all read
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex gap-1.5">
              <div className="skeleton w-1.5 h-1.5 rounded-full" />
              <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.2s' }} />
              <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        ) : items.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-12 gap-2"
            style={{ color: 'var(--muted)' }}
          >
            <Bell size={24} strokeWidth={1.5} />
            <span className="text-[13px]" style={{ fontFamily: 'var(--font-body)' }}>
              You're caught up.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">
            {items.map((item) => {
              if ((item.kind === 'pending_approval' || item.kind === 'work_capture') && item.approval) {
                const action: AgentAction = {
                  id: item.approval.action_id,
                  action: item.approval.action,
                  params: item.approval.params as Record<string, any>,
                  created_at: item.created_at,
                };
                return (
                  <div key={item.id}>
                    <AgentActionCard
                      action={action}
                      onApprove={() => handleApprove(item)}
                      onReject={() => handleReject(item)}
                    />
                    <button
                      type="button"
                      onClick={() => handleApprovalNav(item)}
                      className="ml-3 mb-2 text-[11px] underline"
                      style={{ color: 'var(--muted)' }}
                    >
                      Open in Inbox
                    </button>
                  </div>
                );
              }
              return (
                <InboxRow
                  key={item.id}
                  item={item}
                  onClick={() => handleRowClick(item)}
                  onDismiss={() => void markRead([item.id])}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Footer — always visible */}
      <div
        className="flex-shrink-0"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <Link
          href="/inbox"
          onClick={onClose}
          className="flex items-center justify-center gap-1 px-4 py-2.5 text-[12px] font-medium"
          style={{ color: 'var(--accent)', fontFamily: 'var(--font-body)' }}
        >
          View all
          <ChevronRight size={13} strokeWidth={1.75} />
        </Link>
      </div>
    </div>
  );
}
