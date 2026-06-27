// apps/web/src/app/(app)/inbox/page.tsx
'use client';

import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInbox, type InboxItemKind } from '@/hooks/use-inbox';
import { InboxRow } from '@/components/inbox-row';
import { AgentActionCard, type AgentAction } from '@/components/agent-action-card';
import { api } from '@/lib/api';

type Tab = 'all' | 'mentions' | 'dms' | 'tasks' | 'approvals';

const TAB_TO_KIND: Record<Tab, InboxItemKind | undefined> = {
  all: undefined,
  mentions: 'mention',
  dms: 'dm_unread',
  tasks: 'task_assigned',
  approvals: 'pending_approval',
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'dms', label: 'DMs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'approvals', label: 'Approvals' },
];

export default function InboxPage() {
  const params = useSearchParams();
  const initialTab = (params.get('tab') as Tab) ?? 'all';
  const [tab, setTab] = useState<Tab>(initialTab);

  // For 'tasks' we want both task_assigned and task_updated. Fetch all and filter
  // client-side for that tab; for the others we pass kind to the API.
  const apiKind = tab === 'tasks' ? undefined : TAB_TO_KIND[tab];
  const { items, unreadCount, isLoading, markRead, markAllRead, refresh } = useInbox(apiKind);

  const filtered = useMemo(() => {
    if (tab === 'tasks') {
      return items.filter((it) => it.kind === 'task_assigned' || it.kind === 'task_updated');
    }
    return items;
  }, [items, tab]);

  const handleApprove = useCallback(
    async (id: string) => {
      const res = await api.post(`/api/agent/actions/${id}/approve`, {});
      if (res.ok) void refresh();
    },
    [refresh],
  );

  const handleReject = useCallback(
    async (id: string) => {
      const res = await api.post(`/api/agent/actions/${id}/reject`, {});
      if (res.ok) void refresh();
    },
    [refresh],
  );

  const handleRowClick = useCallback(
    (id: string) => () => {
      void markRead([id]);
    },
    [markRead],
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="max-w-[760px] mx-auto px-4 py-6 md:px-6 md:py-8">
        <header className="mb-6 flex items-end justify-between">
          <div>
            <h1
              className="text-[20px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              Inbox
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
              {unreadCount > 0
                ? `${unreadCount} unread item${unreadCount === 1 ? '' : 's'}`
                : "You're caught up."}
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={() => void markAllRead()}
              className="text-[12px] px-3 py-1.5 rounded-md"
              style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}
            >
              Mark all read
            </button>
          )}
        </header>

        {/* Tab strip */}
        <nav className="flex gap-1 mb-5 border-b" style={{ borderColor: 'var(--border)' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="text-[13px] px-3 py-2 -mb-px"
              style={{
                color: tab === t.id ? 'var(--primary)' : 'var(--muted)',
                borderBottom: tab === t.id ? '2px solid var(--primary)' : '2px solid transparent',
                fontWeight: tab === t.id ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        {isLoading ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : filtered.length === 0 ? (
          <div
            className="text-[13px] py-12 text-center rounded-lg"
            style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}
          >
            Nothing here.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((item) => {
              if (item.kind === 'pending_approval' && item.approval) {
                const action: AgentAction = {
                  id: item.approval.action_id,
                  action: item.approval.action,
                  params: item.approval.params as Record<string, any>,
                };
                return (
                  <AgentActionCard
                    key={item.id}
                    action={action}
                    onApprove={() => handleApprove(item.approval!.action_id)}
                    onReject={() => handleReject(item.approval!.action_id)}
                  />
                );
              }
              return (
                <InboxRow
                  key={item.id}
                  item={item}
                  onClick={handleRowClick(item.id)}
                  onDismiss={() => void markRead([item.id])}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
