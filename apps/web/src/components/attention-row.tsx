'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  AtSign,
  Bell,
  BookOpen,
  CalendarClock,
  Check,
  CheckSquare,
  Clock3,
  MessageSquare,
  Sparkles,
  X,
} from 'lucide-react';
import { formatRelative } from '@/lib/time';
import type { AttentionItem } from '@/hooks/use-attention';

const ICONS: Record<string, typeof Bell> = {
  mention: AtSign,
  message: MessageSquare,
  task_assigned: CheckSquare,
  task_updated: CheckSquare,
  task: CheckSquare,
  blocked: AlertTriangle,
  reminder: CalendarClock,
  wiki_update: BookOpen,
  agent_suggestion: Sparkles,
  approval: Sparkles,
};

function attentionPreview(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[\s#>*+-]+/gm, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function AttentionRow({
  item,
  onSeen,
  onAcknowledge,
  onResolve,
  onSnooze,
  onFeedback,
}: {
  item: AttentionItem;
  onSeen: () => void;
  onAcknowledge: () => void;
  onResolve: () => void;
  onSnooze: () => void;
  onFeedback?: (feedback: 'not_for_me' | 'not_urgent') => void;
}) {
  const Icon = ICONS[item.kind] ?? Bell;
  const unseen = item.state === 'open_unseen';
  const content = (
    <div className="group flex min-w-0 items-start gap-3 border-b px-1 py-3.5 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={{
          color: item.priority === 'critical' || item.priority === 'high' ? 'var(--status-amber)' : 'var(--muted)',
          background: 'var(--bg-subtle)',
        }}
      >
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {unseen && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--primary)' }} />}
          <p className="truncate text-[13px]" style={{ color: 'var(--foreground)', fontWeight: unseen ? 650 : 500 }}>
            {item.title}
          </p>
          {item.event_count > 1 && (
            <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>+{item.event_count - 1}</span>
          )}
        </div>
        {item.body && (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            {attentionPreview(item.body)}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--outline)' }}>
          <span>{formatRelative(item.last_event_at)}</span>
          {item.lane === 'needs_you' && item.state !== 'acknowledged' && (
            <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onAcknowledge(); }} className="inline-flex items-center gap-1 hover:underline">
              <Check size={11} /> Own this
            </button>
          )}
          <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSnooze(); }} className="inline-flex items-center gap-1 hover:underline">
            <Clock3 size={11} /> Later
          </button>
          <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onResolve(); }} className="inline-flex items-center gap-1 hover:underline">
            <X size={11} /> Clear
          </button>
          {item.metadata.classification_source === 'bounded_ai' && onFeedback && (
            <>
              <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onFeedback('not_for_me'); }} className="hover:underline">
                Not for me
              </button>
              {item.priority === 'high' && (
                <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onFeedback('not_urgent'); }} className="hover:underline">
                  Not urgent
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (!item.link) return <div onClick={unseen ? onSeen : undefined}>{content}</div>;
  return <Link href={item.link} onClick={unseen ? onSeen : undefined}>{content}</Link>;
}
