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
  work_capture: Bell,
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
      className="group relative flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3 transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        border: '1px solid transparent',
      }}
    >
      {!item.read && (
        <span
          aria-hidden="true"
          className="absolute left-2 top-4 h-2 w-2 rounded-full"
          style={{ background: 'var(--primary-container)' }}
        />
      )}
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          background: item.read ? 'transparent' : 'color-mix(in srgb, var(--primary-container) 12%, transparent)',
          color: item.read ? 'var(--outline)' : 'var(--primary)',
        }}
      >
        <Icon size={15} strokeWidth={1.65} />
      </span>
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
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full opacity-100 transition-opacity hover:bg-[var(--bg-hover)] focus-visible:opacity-100 md:h-7 md:w-7 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          style={{ color: 'var(--muted)' }}
          title="Mark read"
          aria-label="Mark notification read"
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
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {content}
    </div>
  );
}
