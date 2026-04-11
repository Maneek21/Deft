'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Clock, CheckSquare, Smile, BellOff, Bell, Moon, Search, FileText,
} from 'lucide-react';

export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  icon: React.ComponentType<any>;
  needsArgs: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'remind', usage: '/remind [time] [text]', description: 'Set a reminder (e.g. /remind 30m check email)', icon: Clock, needsArgs: true },
  { name: 'task', usage: '/task [title]', description: 'Create a task', icon: CheckSquare, needsArgs: true },
  { name: 'status', usage: '/status [emoji] [text]', description: 'Set status (e.g. /status 🍕 Lunch)', icon: Smile, needsArgs: true },
  { name: 'mute', usage: '/mute', description: 'Mute this channel', icon: BellOff, needsArgs: false },
  { name: 'unmute', usage: '/unmute', description: 'Unmute this channel', icon: Bell, needsArgs: false },
  { name: 'dnd', usage: '/dnd', description: 'Toggle Do Not Disturb', icon: Moon, needsArgs: false },
  { name: 'search', usage: '/search [query]', description: 'Search everything', icon: Search, needsArgs: false },
  { name: 'note', usage: '/note [title]', description: 'Create a new note', icon: FileText, needsArgs: true },
];

export function SlashCommandAutocomplete({
  query, onSelect, onClose,
}: {
  query: string;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = SLASH_COMMANDS.filter(cmd =>
    !query || cmd.name.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => { setSelectedIndex(0); }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered[selectedIndex]) {
          e.preventDefault();
          onSelect(filtered[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [filtered, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (filtered.length === 0) return null;

  return (
    <div ref={containerRef}
      className="absolute bottom-full mb-1 left-0 w-[320px] max-h-[280px] overflow-y-auto rounded-xl z-50"
      style={{
        background: 'var(--card-bg, var(--surface-container-low))',
        border: '1px solid var(--border-default, var(--outline-variant))',
        boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
      }}
    >
      <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-tertiary, var(--outline))' }}>
        Commands
      </div>
      {filtered.map((cmd, i) => {
        const Icon = cmd.icon;
        return (
          <button key={cmd.name}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => setSelectedIndex(i)}
            className="w-full text-left px-3 py-2 flex items-center gap-3 transition-colors"
            style={{
              background: i === selectedIndex ? 'var(--bg-active, var(--surface-container-highest))' : 'transparent',
            }}
          >
            <Icon size={15} strokeWidth={1.5} style={{ color: 'var(--text-tertiary, var(--outline))', flexShrink: 0 }} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary, var(--on-surface))' }}>
                /{cmd.name}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-tertiary, var(--outline))' }}>
                {cmd.description}
              </div>
            </div>
            <span className="text-[10px] flex-shrink-0 hidden md:inline" style={{ color: 'var(--text-tertiary, var(--outline))', fontFamily: 'var(--font-mono)' }}>
              {cmd.usage}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Parse time string like "30m", "1h", "2h30m", "tomorrow", "3pm" into milliseconds from now */
export function parseReminderTime(input: string): { ms: number; label: string } | null {
  const s = input.trim().toLowerCase();

  // "30m", "20min", "1h", "2h30m"
  const relMatch = s.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/);
  if (relMatch) {
    const num = parseInt(relMatch[1]!);
    const unit = relMatch[2]!.startsWith('h') ? 60 : 1;
    return { ms: num * unit * 60000, label: `in ${num}${unit === 60 ? 'h' : 'm'}` };
  }

  // Combined: "1h30m", "2h15m"
  const combMatch = s.match(/^(\d+)h\s*(\d+)m$/);
  if (combMatch) {
    const hours = parseInt(combMatch[1]!);
    const mins = parseInt(combMatch[2]!);
    return { ms: (hours * 60 + mins) * 60000, label: `in ${hours}h${mins}m` };
  }

  // "tomorrow"
  if (s === 'tomorrow') {
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + 1);
    tmr.setHours(9, 0, 0, 0);
    return { ms: tmr.getTime() - Date.now(), label: 'tomorrow 9 AM' };
  }

  // Fallback: default 20 minutes
  return null;
}
