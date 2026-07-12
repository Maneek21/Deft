import type { InboxItemKind } from '@/hooks/use-inbox';

export type InboxTab = 'attention' | 'messages' | 'tasks' | 'approvals' | 'activity';

export const INBOX_TABS: { id: InboxTab; label: string }[] = [
  { id: 'attention', label: 'Attention' },
  { id: 'messages', label: 'Messages' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'approvals', label: 'Approvals' },
];

export const TAB_TO_KINDS: Record<InboxTab, InboxItemKind[]> = {
  attention: ['mention', 'dm_unread', 'task_assigned', 'task_updated', 'blocked', 'pending_approval'],
  messages: ['mention', 'dm_unread'],
  tasks: ['task_assigned', 'task_updated', 'blocked'],
  approvals: ['pending_approval'],
  activity: ['cross_reference', 'wiki_update', 'system', 'work_capture'],
};

export function normalizeInboxTab(value: string | null): InboxTab {
  if (value === 'all' || value === null) return 'attention';
  if (value === 'mentions' || value === 'dms') return 'messages';
  if (value === 'captures') return 'activity';
  if (value === 'activity') return 'activity';
  return INBOX_TABS.some((tab) => tab.id === value) ? value as InboxTab : 'attention';
}

export function inboxStatusText(tab: InboxTab, count: number, loading: boolean) {
  if (loading) return 'Checking what needs your attention...';
  const noun = count === 1 ? '' : 's';
  if (tab === 'approvals') return count ? `${count} approval${noun} waiting` : 'No approvals waiting.';
  if (tab === 'activity') return 'Automation, capture, and delivery history.';
  if (tab === 'messages') return count ? `${count} unread message update${noun}` : 'No unread message updates.';
  if (tab === 'tasks') return count ? `${count} unread task update${noun}` : 'No unread task updates.';
  return count ? `${count} item${noun} need${count === 1 ? 's' : ''} attention` : "You're caught up.";
}

export function inboxEmptyText(tab: InboxTab) {
  if (tab === 'approvals') return 'No approvals are waiting for you.';
  if (tab === 'activity') return 'No background activity to show.';
  if (tab === 'messages') return 'No unread messages or mentions.';
  if (tab === 'tasks') return 'No unread task updates.';
  return "You're caught up.";
}
