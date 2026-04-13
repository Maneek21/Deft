'use client';

import { api } from '@/lib/api';
import Link from 'next/link';
import { X } from 'lucide-react';

export type ConversationListItem = {
  id: string;
  title: string | null;
  updated_at: string;
  agent_employee_id?: string | null;
};

type Props = {
  conversations: ConversationListItem[];
  activeId: string | null;
  /** Per-conversation href builder — passed in so pages can control URL format. */
  hrefFor: (conv: ConversationListItem) => string;
  /** Called after a conversation is deleted (parent can refetch / navigate). */
  onDelete?: (id: string) => void;
  /** Called when a conversation link is clicked (e.g. to close a mobile panel). */
  onNavigate?: () => void;
  emptyText?: string;
  maxItems?: number;
};

export function ConversationList({
  conversations,
  activeId,
  hrefFor,
  onDelete,
  onNavigate,
  emptyText = 'No conversations yet',
  maxItems = 20,
}: Props) {
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await api.delete(`/api/agent/conversations/${id}`);
    onDelete?.(id);
  };

  if (conversations.length === 0) {
    return (
      <p className="text-[12px] text-center py-4" style={{ color: 'var(--outline)' }}>
        {emptyText}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {conversations.slice(0, maxItems).map((conv) => {
        const isActive = activeId === conv.id;
        return (
          <Link
            key={conv.id}
            href={hrefFor(conv)}
            onClick={onNavigate}
            className="flex items-center justify-between gap-2 px-2 py-2 rounded-lg text-[0.8125rem] group"
            style={{
              background: isActive ? 'var(--accent-subtle)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--foreground-secondary)',
            }}
          >
            <span className="truncate flex-1" title={conv.title ?? 'Untitled'}>
              {conv.title || 'Untitled'}
            </span>
            {onDelete && (
              <button
                onClick={(e) => handleDelete(conv.id, e)}
                className="p-1 rounded opacity-0 group-hover:opacity-100 group-active:opacity-100 flex-shrink-0"
                style={{ color: 'var(--outline)' }}
                aria-label="Delete conversation"
              >
                <X size={12} />
              </button>
            )}
          </Link>
        );
      })}
    </div>
  );
}
