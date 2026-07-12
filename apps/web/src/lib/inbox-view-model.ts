import type { InboxItemKind } from '@/hooks/use-inbox';

export type InboxTab = 'all' | 'mentions' | 'dms' | 'tasks' | 'captures' | 'approvals';

export const INBOX_TABS: { id: InboxTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'dms', label: 'DMs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'captures', label: 'Captures' },
  { id: 'approvals', label: 'Approvals' },
];

export const TAB_TO_KINDS: Record<InboxTab, InboxItemKind[] | undefined> = {
  all: undefined,
  mentions: ['mention'],
  dms: ['dm_unread'],
  tasks: ['task_assigned', 'task_updated'],
  captures: ['work_capture'],
  approvals: ['pending_approval'],
};

export function normalizeInboxTab(value: string | null): InboxTab {
  return INBOX_TABS.some((tab) => tab.id === value) ? value as InboxTab : 'all';
}

export function inboxStatusText(tab: InboxTab, count: number, loading: boolean) {
  if (loading) return 'Checking what needs your attention...';
  const noun = count === 1 ? '' : 's';
  if (tab === 'approvals') return count ? `${count} approval${noun} waiting` : 'No approvals waiting.';
  if (tab === 'captures') return count ? `${count} capture${noun} waiting for review` : 'No captures need review.';
  if (tab === 'dms') return count ? `${count} unread conversation${noun}` : 'No unread direct messages.';
  if (tab === 'mentions') return count ? `${count} unread mention${noun}` : 'No unread mentions.';
  if (tab === 'tasks') return count ? `${count} unread task update${noun}` : 'No unread task updates.';
  return count ? `${count} item${noun} need${count === 1 ? 's' : ''} attention` : "You're caught up.";
}

export function inboxEmptyText(tab: InboxTab) {
  if (tab === 'approvals') return 'No approvals are waiting for you.';
  if (tab === 'captures') return 'No captured work needs review.';
  if (tab === 'dms') return 'No unread direct messages.';
  if (tab === 'mentions') return 'No unread mentions.';
  if (tab === 'tasks') return 'No unread task updates.';
  return "You're caught up.";
}
