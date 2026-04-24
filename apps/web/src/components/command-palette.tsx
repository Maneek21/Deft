'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Search, Hash, CheckSquare, User, MessageSquare,
  Sun, Moon, Plus, Settings, X, Bot, Tag, CalendarDays,
  BookOpen, FileText, Scale,
} from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';

const OPEN_COMMAND_PALETTE_EVENT = 'deft:open-command-palette';

type WikiResult = { id: string; title: string; summary: string | null; slug: string | null; type: string | null; source_id: string };
type NoteResult = { id: string; title: string; summary: string | null; source_id: string };
type DecisionResult = { id: string; title: string; summary: string | null; slug: string | null; source_id: string };

type SearchResults = {
  spaces: { id: string; name: string; type: string }[];
  tasks: { id: string; title: string; project_prefix: string; number: number; status: string }[];
  people: { id: string; name: string; email: string }[];
  messages: { id: string; content: string; space_id: string; space_name: string; user_name: string }[];
  tags: { id: string; name: string; color: string | null }[];
  wiki: WikiResult[];
  privateNotes: NoteResult[];
  decisions: DecisionResult[];
};

type Command = {
  label: string;
  icon: any;
  action: () => void;
};

function formatStatus(status: string): string {
  return statusLabel(status);
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>({ spaces: [], tasks: [], people: [], messages: [], tags: [], wiki: [], privateNotes: [], decisions: [] });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const mode = query.startsWith('>') ? 'commands' : 'search';

  const COMMANDS: Command[] = useMemo(() => [
    { label: 'Create task', icon: Plus, action: () => { router.push('/tasks'); close(); } },
    { label: 'New space', icon: Hash, action: () => { router.push('/chat'); close(); } },
    { label: 'Toggle dark mode', icon: Sun, action: () => { document.documentElement.classList.toggle('dark'); close(); } },
    { label: 'Open settings', icon: Settings, action: () => { router.push('/settings'); close(); } },
    { label: 'Ask Deft', icon: Bot, action: () => { router.push('/agent'); close(); } },
    { label: 'Go to Calendar', icon: CalendarDays, action: () => { router.push('/calendar'); close(); } },
  ], [router]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults({ spaces: [], tasks: [], people: [], messages: [], tags: [], wiki: [], privateNotes: [], decisions: [] });
    setSelectedIndex(0);
  }, []);

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (prev) {
            // closing
            setQuery('');
            setResults({ spaces: [], tasks: [], people: [], messages: [], tags: [], wiki: [], privateNotes: [], decisions: [] });
            setSelectedIndex(0);
          }
          return !prev;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const openHandler = () => {
      setOpen(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    document.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openHandler as EventListener);
    return () => document.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openHandler as EventListener);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query || query.startsWith('>')) {
      setResults({ spaces: [], tasks: [], people: [], messages: [], tags: [], wiki: [], privateNotes: [], decisions: [] });
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setResults({
            spaces: data.spaces ?? [],
            tasks: data.tasks ?? [],
            people: data.people ?? [],
            messages: data.messages ?? [],
            tags: data.tags ?? [],
            wiki: data.wiki ?? [],
            privateNotes: data.privateNotes ?? [],
            decisions: data.decisions ?? [],
          });
        }
      } catch {
        // silently fail
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Build flat items list for keyboard navigation
  const flatItems = useMemo(() => {
    if (mode === 'commands') {
      const commandQuery = query.slice(1).toLowerCase().trim();
      return COMMANDS
        .filter((c) => !commandQuery || c.label.toLowerCase().includes(commandQuery))
        .map((c, i) => ({ type: 'command' as const, item: c, index: i }));
    }
    const items: { type: string; item: any; index: number }[] = [];
    let idx = 0;
    results.spaces.forEach((s) => items.push({ type: 'space', item: s, index: idx++ }));
    results.tasks.forEach((t) => items.push({ type: 'task', item: t, index: idx++ }));
    results.people.forEach((p) => items.push({ type: 'person', item: p, index: idx++ }));
    results.messages.forEach((m) => items.push({ type: 'message', item: m, index: idx++ }));
    results.tags.forEach((t) => items.push({ type: 'tag', item: t, index: idx++ }));
    (results.wiki ?? []).forEach((w) => items.push({ type: 'wiki', item: w, index: idx++ }));
    (results.privateNotes ?? []).forEach((n) => items.push({ type: 'privateNote', item: n, index: idx++ }));
    (results.decisions ?? []).forEach((d) => items.push({ type: 'decision', item: d, index: idx++ }));
    return items;
  }, [mode, query, results, COMMANDS]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [flatItems.length]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = flatItems[selectedIndex];
        if (!selected) return;
        if (selected.type === 'command') {
          (selected.item as Command).action();
        } else if (selected.type === 'space') {
          router.push('/chat');
          close();
        } else if (selected.type === 'task') {
          const t = selected.item;
          router.push(`/tasks?task=${t.project_prefix}-${t.number}`);
          close();
        } else if (selected.type === 'person') {
          router.push('/chat');
          close();
        } else if (selected.type === 'message') {
          const m = selected.item;
          router.push(`/chat?space=${m.space_id}&message=${m.id}`);
          close();
        } else if (selected.type === 'tag') {
          router.push(`/settings/tags?tag=${selected.item.id}`);
          close();
        } else if (selected.type === 'wiki') {
          const slug = selected.item.slug;
          router.push(slug ? `/knowledge?slug=${slug}` : '/knowledge');
          close();
        } else if (selected.type === 'decision') {
          const slug = selected.item.slug;
          router.push(slug ? `/knowledge?slug=${slug}` : '/knowledge');
          close();
        } else if (selected.type === 'privateNote') {
          router.push(`/notes?id=${selected.item.id}`);
          close();
        }
      }
    },
    [flatItems, selectedIndex, router, close]
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const el = resultsRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!open) return null;

  const hasResults = flatItems.length > 0;
  const hasQuery = query.length > 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]"
      style={{ background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(12px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[640px] overflow-hidden"
        style={{
          background: 'var(--glass-bg)',
          backdropFilter: 'var(--glass-blur)',
          boxShadow: 'var(--glass-shadow)',
          borderRadius: 'var(--radius-xl)',
        }}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4"
          style={{ height: '52px' }}
        >
          <div
            className="flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0"
            style={{ background: 'var(--primary-container)' }}
          >
            <Search size={12} strokeWidth={2} style={{ color: '#fff' }} />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search anything..."
            className="flex-1 bg-transparent text-[13px] outline-none"
            style={{
              color: 'var(--on-surface)',
            }}
          />
          <button
            onClick={close}
            className="flex items-center justify-center"
          >
            <kbd
              className="text-[10px] px-1.5 py-0.5"
              style={{
                background: 'var(--surface-container-highest)',
                color: 'var(--outline)',
                borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ESC
            </kbd>
          </button>
        </div>

        {/* Results */}
        <div
          ref={resultsRef}
          className="max-h-[360px] overflow-y-auto py-2"
        >
          {mode === 'commands' ? (
            <>
              <div className="px-3 py-1.5">
                <span
                  className="text-[11px] font-semibold uppercase"
                  style={{ color: 'var(--outline)', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)', fontSize: '0.6875rem' }}
                >
                  Commands
                </span>
              </div>
              {flatItems.map((entry, i) => {
                const cmd = entry.item as Command;
                const isSelected = i === selectedIndex;
                return (
                  <button
                    key={cmd.label}
                    data-index={i}
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <cmd.icon size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
                    <span className="text-[13px]">{cmd.label}</span>
                  </button>
                );
              })}
            </>
          ) : hasQuery && hasResults ? (
            <>
              {/* Spaces */}
              <ResultGroup
                title="Spaces"
                icon={Hash}
                items={results.spaces}
                startIndex={0}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item, isSelected) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push('/chat'); close(); }}
                  >
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--surface-container-highest)', color: 'var(--on-surface-variant)', fontFamily: 'var(--font-mono)' }}
                    >
                      # {item.name}
                    </span>
                  </button>
                )}
              />
              {/* Tasks */}
              <ResultGroup
                title="Tasks"
                icon={CheckSquare}
                items={results.tasks}
                startIndex={results.spaces.length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item, isSelected) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push(`/tasks?task=${item.project_prefix}-${item.number}`); close(); }}
                  >
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded flex-shrink-0"
                      style={{ background: 'var(--surface-container-highest)', color: 'var(--on-surface-variant)', fontFamily: 'var(--font-mono)' }}
                    >
                      {item.project_prefix}-{item.number}
                    </span>
                    <span className="text-[13px] flex-1 truncate">{item.title}</span>
                    <span className="text-[11px]" style={{ color: 'var(--outline)' }}>{formatStatus(item.status)}</span>
                  </button>
                )}
              />
              {/* People */}
              <ResultGroup
                title="People"
                icon={User}
                items={results.people}
                startIndex={results.spaces.length + results.tasks.length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item, isSelected) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push('/chat'); close(); }}
                  >
                    <User size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
                    <span className="text-[13px] flex-1 truncate">{item.name}</span>
                    <span
                      className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(48, 164, 108, 0.15)', color: 'var(--status-green)', letterSpacing: '0.05em' }}
                    >
                      Active
                    </span>
                  </button>
                )}
              />
              {/* Messages */}
              <ResultGroup
                title="Messages"
                icon={MessageSquare}
                items={results.messages}
                startIndex={results.spaces.length + results.tasks.length + results.people.length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item, isSelected) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push(`/chat?space=${item.space_id}&message=${item.id}`); close(); }}
                  >
                    <MessageSquare size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
                    <span className="text-[13px] flex-1 truncate">{item.content}</span>
                    <span className="text-[11px]" style={{ color: 'var(--outline)' }}>#{item.space_name}</span>
                  </button>
                )}
              />
              {/* Tags */}
              <ResultGroup
                title="Tags"
                icon={Tag}
                items={results.tags}
                startIndex={results.spaces.length + results.tasks.length + results.people.length + results.messages.length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item, isSelected) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push(`/settings/tags?tag=${item.id}`); close(); }}
                  >
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: item.color || 'var(--outline)' }} />
                    <span className="text-[13px]">#{item.name}</span>
                  </button>
                )}
              />
              {/* Knowledge (Wiki) */}
              <ResultGroup
                title="Knowledge"
                icon={BookOpen}
                items={results.wiki ?? []}
                startIndex={results.spaces.length + results.tasks.length + results.people.length + results.messages.length + results.tags.length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item: WikiResult, isSelected: boolean) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push(item.slug ? `/knowledge?slug=${item.slug}` : '/knowledge'); close(); }}
                  >
                    <BookOpen size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
                    <span className="text-[13px] flex-1 truncate">{item.title}</span>
                    {item.type && (
                      <span className="text-[11px]" style={{ color: 'var(--outline)' }}>{item.type}</span>
                    )}
                  </button>
                )}
              />
              {/* Notes */}
              <ResultGroup
                title="Notes"
                icon={FileText}
                items={results.privateNotes ?? []}
                startIndex={results.spaces.length + results.tasks.length + results.people.length + results.messages.length + results.tags.length + (results.wiki ?? []).length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item: NoteResult, isSelected: boolean) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push(`/notes?id=${item.id}`); close(); }}
                  >
                    <FileText size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
                    <span className="text-[13px] flex-1 truncate">{item.title}</span>
                  </button>
                )}
              />
              {/* Decisions */}
              <ResultGroup
                title="Decisions"
                icon={Scale}
                items={results.decisions ?? []}
                startIndex={results.spaces.length + results.tasks.length + results.people.length + results.messages.length + results.tags.length + (results.wiki ?? []).length + (results.privateNotes ?? []).length}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                renderItem={(item: DecisionResult, isSelected: boolean) => (
                  <button
                    className="w-full flex items-center gap-3 px-4 text-left"
                    style={{
                      height: '36px',
                      background: isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--on-surface)',
                      transition: '150ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                    onClick={() => { router.push(item.slug ? `/knowledge?slug=${item.slug}` : '/knowledge'); close(); }}
                  >
                    <Scale size={14} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
                    <span className="text-[13px] flex-1 truncate">{item.title}</span>
                  </button>
                )}
              />
            </>
          ) : hasQuery && !hasResults ? (
            <div className="py-8 text-center">
              <p className="text-[13px]" style={{ color: 'var(--outline)' }}>
                No results for &ldquo;{query}&rdquo;
              </p>
            </div>
          ) : (
            <div className="py-8 text-center">
              <p className="text-[13px]" style={{ color: 'var(--outline)' }}>
                Start typing to search...
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--outline)' }}>
                Type <kbd className="px-1 py-0.5 rounded" style={{ background: 'var(--surface-container-highest)', fontFamily: 'var(--font-mono)', fontSize: '0.6875rem' }}>&gt;</kbd> for commands
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--outline)' }}
        >
          <span>↑↓ to navigate &nbsp; ← to select</span>
          <span>v1.0.0-beta</span>
        </div>
      </div>
    </div>
  );
}

function ResultGroup({
  title,
  icon: Icon,
  items,
  startIndex,
  selectedIndex,
  setSelectedIndex,
  renderItem,
}: {
  title: string;
  icon: any;
  items: any[];
  startIndex: number;
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  renderItem: (item: any, isSelected: boolean) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-3 py-1.5">
        <span
          className="text-[11px] font-semibold uppercase"
          style={{ color: 'var(--outline)', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)', fontSize: '0.6875rem' }}
        >
          {title}
        </span>
      </div>
      {items.map((item, i) => {
        const globalIndex = startIndex + i;
        const isSelected = globalIndex === selectedIndex;
        return (
          <div
            key={item.id}
            data-index={globalIndex}
            onMouseEnter={() => setSelectedIndex(globalIndex)}
          >
            {renderItem(item, isSelected)}
          </div>
        );
      })}
    </div>
  );
}
