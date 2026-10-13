'use client';

import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { AppDialog } from './overlay-primitives';

const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['G', 'D'], description: 'Go to Dashboard' },
      { keys: ['G', 'C'], description: 'Go to Chat' },
      { keys: ['G', 'T'], description: 'Go to Tasks' },
      { keys: ['G', 'A'], description: 'Go to Agent' },
      { keys: ['G', 'L'], description: 'Go to Calendar' },
      { keys: ['G', 'K'], description: 'Go to Knowledge' },
      { keys: ['G', 'R'], description: 'Go to Reminders' },
      { keys: ['G', 'S'], description: 'Go to Settings' },
    ],
  },
  {
    title: 'Global',
    shortcuts: [
      { keys: ['\u2318', 'K'], description: 'Command palette' },
      { keys: ['Shift', 'Esc'], description: 'Mark all as read' },
      { keys: ['?'], description: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Tasks',
    shortcuts: [
      { keys: ['C'], description: 'Create new task' },
      { keys: ['V', 'B'], description: 'Board view' },
      { keys: ['V', 'L'], description: 'List view' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['\u2191'], description: 'Edit last message' },
      { keys: ['\u2318', 'Shift', 'M'], description: 'Mute space' },
    ],
  },
];

const EMAIL_SHORTCUTS = {
  title: 'Email',
  shortcuts: [
    { keys: ['C'], description: 'Compose a new email' },
    { keys: ['/'], description: 'Focus mail search' },
    { keys: ['J', '/', 'K'], description: 'Focus next / previous message' },
    { keys: ['Enter'], description: 'Open focused message' },
    { keys: ['R'], description: 'Reply to the open message' },
    { keys: ['Esc'], description: 'Close reader More menu' },
  ],
};

export function KeyboardShortcutList({ email = false }: { email?: boolean }) {
  return <><div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {(email ? [...SHORTCUT_GROUPS, EMAIL_SHORTCUTS] : SHORTCUT_GROUPS).map((group) => (
            <div key={group.title}>
              <h3
                className="text-[11px] font-semibold uppercase tracking-wider mb-3"
                style={{ color: 'var(--on-surface-variant)' }}
              >
                {group.title}
              </h3>
              <div className="flex flex-col gap-2">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.description} className="flex items-center justify-between gap-3">
                    <span
                      className="text-[13px]"
                      style={{ color: 'var(--on-surface-variant)' }}
                    >
                      {shortcut.description}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {shortcut.keys.map((key, i) => (
                        <kbd
                          key={i}
                          className="inline-flex items-center justify-center min-w-[24px] h-[22px] px-1.5 rounded text-[11px] font-medium"
                          style={{
                            background: 'var(--surface-container-highest)',
                            color: 'var(--on-surface-variant)',
                            fontFamily: 'var(--font-mono)',
                            border: '1px solid var(--outline-variant)',
                          }}
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>{email && <p className="mt-5 text-xs leading-5 text-[var(--muted)]">Email shortcuts pause while typing or using a dialog. Use Tab and Shift+Tab to move through controls, then Enter or Space to activate them.</p>}</>;
}

export function KeyboardShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  return <AppDialog open={open} onClose={onClose} title="Keyboard Shortcuts" width={560}
    headerActions={<button type="button" aria-label="Close keyboard shortcuts" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><X size={16} strokeWidth={1.5}/></button>}>
    <KeyboardShortcutList email={pathname === '/email'}/>
  </AppDialog>;
}
