'use client';

import Link from 'next/link';
import { formatRelative } from '@/lib/time';
import {
  AtSign, MessageSquare, CheckSquare, AlertTriangle, Link as LinkIcon,
  BookOpen, Bell, X,
} from 'lucide-react';
import type { InboxItem, InboxItemKind } from '@/hooks/use-inbox';

const KIND_ICON: Record<InboxItemKind, typeof AtSign> = {
  mention: AtSign,
  dm_unread: MessageSquare,
  task_assigned: CheckSquare,
  task_updated: CheckSquare,
  blocked: AlertTriangle,
  cross_reference: LinkIcon,
  wiki_update: BookOpen,
  system: Bell,
  pending_approval: Bell, // not used here — approvals use AgentActionCard
};

type Props = {
  item: InboxItem;
  onClick?: () => void; // mark-read on visit
  onDismiss?: () => void; // mark-read without navigating
};

export function InboxRow({ item, onClick, onDismiss }: Props) {
  const Icon = KIND_ICON[item.kind] ?? Bell;
  const content = (
    <div
      className="group flex items-start gap-3 px-4 py-3 rounded-lg cursor-pointer relative"
      style={{
        background: item.read ? 'transparent' : 'var(--bg-active)',
        borderLeft: item.read ? '2px solid transparent' : '2px solid var(--primary)',
      }}
    >
      <Icon size={16} strokeWidth={1.5} style={{ color: 'var(--primary)', marginTop: 2 }} />
      <div className="flex-1 min-w-0 pr-7">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: 'var(--on-surface)', fontWeight: item.read ? 400 : 600 }}
        >
          {item.title}
        </div>
        {item.body && (
          <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: 'var(--muted)' }}>
            {item.body}
          </div>
        )}
        <div className="text-[11px] mt-1" style={{ color: 'var(--outline)' }}>
          {formatRelative(item.created_at)}
        </div>
      </div>
      {!item.read && onDismiss && (
        <button
          type="button"
          onClick={(e) => {
            // Stop the Link wrapper from navigating; just mark read.
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
          className="absolute top-2.5 right-2.5 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--muted)' }}
          title="Dismiss"
          aria-label="Dismiss notification"
        >
          <X size={13} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );

  if (item.link) {
    return (
      <Link href={item.link} onClick={onClick}>
        {content}
      </Link>
    );
  }
  return <div onClick={onClick}>{content}</div>;
}
