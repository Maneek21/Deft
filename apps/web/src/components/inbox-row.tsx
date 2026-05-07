'use client';

import Link from 'next/link';
import { formatRelative } from '@/lib/time';
import {
  AtSign, MessageSquare, CheckSquare, AlertTriangle, Link as LinkIcon,
  BookOpen, Bell,
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
};

export function InboxRow({ item, onClick }: Props) {
  const Icon = KIND_ICON[item.kind] ?? Bell;
  const content = (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-lg cursor-pointer"
      style={{
        background: item.read ? 'transparent' : 'var(--bg-active)',
        borderLeft: item.read ? '2px solid transparent' : '2px solid var(--primary)',
      }}
    >
      <Icon size={16} strokeWidth={1.5} style={{ color: 'var(--primary)', marginTop: 2 }} />
      <div className="flex-1 min-w-0">
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
