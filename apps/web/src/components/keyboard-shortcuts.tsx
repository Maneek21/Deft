'use client';

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

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

export function KeyboardShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ background: 'rgba(0, 0, 0, 0.5)' }} />

      {/* Modal */}
      <div
        className="relative w-[calc(100vw-2rem)] max-w-[560px] max-h-[90vh] overflow-y-auto rounded-2xl p-6"
        style={{
          background: 'var(--surface-container-highest)',
          boxShadow: 'var(--glass-shadow)',
          border: '1px solid var(--outline-variant)',
          borderRadius: 'var(--radius-xl)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2
            className="text-[16px] font-semibold"
            style={{ color: 'var(--on-surface)' }}
          >
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md"
            style={{ color: 'var(--on-surface-variant)' }}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Shortcut groups — two-column grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SHORTCUT_GROUPS.map((group) => (
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
        </div>
      </div>
    </div>
  );
}
