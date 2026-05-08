'use client';

/**
 * Dashboard — Variant C ("Bento Registry").
 *
 * Every panel is a self-contained widget declared via WidgetDefinition.
 * Phase 2 adds an edit mode: users toggle a "Customize" button to drag,
 * resize, remove, and add widgets. Layout persists per-user in localStorage.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  MessageSquare, Plus, Bot, Sunrise, Loader2, X, Pencil, Check,
  LayoutGrid, RotateCcw,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AIProviderBanner } from '@/components/ai-provider-banner';
import { sanitizeHtml } from '@/lib/sanitize';
import { formatMessageTime, formatFullDateLong } from '@/lib/time';

import { DashboardDataProvider, useDashboardData } from './lib/data-provider';
import { DashboardGrid } from './grid/dashboard-grid';
import { AddWidgetDrawer } from './grid/add-widget-drawer';
import { useLayoutStorage } from './lib/use-layout-storage';
import { getWidget } from './lib/registry';
import type { BreakpointLayoutEntry, DashboardLayout } from './lib/widget-types';
import { registerBuiltInWidgets } from './widgets';

registerBuiltInWidgets();

// ───── helpers ─────

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function renderSimpleMarkdown(text: string): string {
  if (!text) return '';
  let html = text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:13px;font-weight:600;margin:8px 0 3px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:14px;font-weight:600;margin:10px 0 4px">$1</h2>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul style="list-style:disc;padding-left:20px;margin:4px 0">$1</ul>')
    .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent);padding-left:12px;margin:6px 0">$1</blockquote>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
  if (!html.startsWith('<')) html = '<p>' + html + '</p>';
  return html;
}

function Hero({
  onStandup, standupGenerating, hasStandup,
  editMode, onToggleEdit,
}: {
  onStandup: () => void; standupGenerating: boolean; hasStandup: boolean;
  editMode: boolean; onToggleEdit: () => void;
}) {
  const { user } = useAuth();
  const { core } = useDashboardData();
  const [clientGreeting, setClientGreeting] = useState<string | null>(null);

  useEffect(() => {
    setClientGreeting(getGreeting());
  }, []);

  const firstName = user?.name?.split(' ')[0] || '';
  const greetingText = clientGreeting ?? core?.greeting ?? 'Hello';

  const totalUnread = core?.unread_spaces.reduce((s, u) => s + u.unread_count, 0) ?? 0;
  const overdueN = core?.overdue.length ?? 0;
  const dueTodayN = core?.due_today.length ?? 0;
  const inProgressN = core?.in_progress.length ?? 0;
  const doneThisWeek = (core?.due_this_week.filter(t => t.status === 'done').length ?? 0)
    + (core?.due_today.filter(t => t.status === 'done').length ?? 0);

  const Stat = ({ n, color }: { n: number; color: string }) => (
    <span style={{
      fontVariantNumeric: 'tabular-nums', fontWeight: 700, color,
      fontSize: 22, letterSpacing: '-0.02em', margin: '0 2px',
    }}>{n}</span>
  );

  const heroActions = [
    { label: 'New task', icon: Plus, href: '/tasks', primary: true },
    { label: 'Message', icon: MessageSquare, href: '/chat', primary: false },
    { label: 'Ask Deft', icon: Bot, href: '/chat', primary: false },
  ] as const;

  return (
    <header style={{
      position: 'relative', paddingTop: 36, paddingBottom: 28,
      marginBottom: 24, marginLeft: -24, marginRight: -24,
      paddingLeft: 24, paddingRight: 24,
      borderBottom: '1px solid var(--border-default)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 24, flexWrap: 'wrap',
      }}>
        <div style={{ maxWidth: 780 }}>
          <div
            className="eyebrow"
            style={{
              marginBottom: 8,
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--outline)' }} />
            {formatFullDateLong(new Date())}
          </div>
          <h1 className="display" style={{ margin: 0 }}>{greetingText}, {firstName}.</h1>
          <p
            className="lede"
            style={{
              margin: '18px 0 0', maxWidth: 720,
            }}
          >
            {dueTodayN === 0 && inProgressN === 0 && totalUnread === 0 && overdueN === 0 ? (
              <>A clear slate today. No tasks pending, your inbox is empty, and nothing is mid-flight. A rare kind of quiet.</>
            ) : (
              <>
                You have{' '}
                {overdueN > 0 && (
                  <>
                    <Stat n={overdueN} color="var(--status-red)" />{' '}
                    <Link href="/tasks?filter=overdue" style={{
                      color: 'var(--text-secondary)', textDecoration: 'underline',
                      textDecorationColor: 'var(--border-strong)', textUnderlineOffset: 3,
                    }}>overdue</Link>,{' '}
                  </>
                )}
                <Stat n={dueTodayN} color="var(--status-amber)" />{' '}
                due today, and{' '}
                <Stat n={inProgressN} color="var(--status-blue)" />{' '}
                in progress.
                {totalUnread > 0 && (
                  <>{' '}Across the workspace,{' '}
                    <Link href="/chat" style={{
                      color: 'var(--text-secondary)', textDecoration: 'underline',
                      textDecorationColor: 'var(--border-strong)', textUnderlineOffset: 3,
                    }}>
                      <Stat n={totalUnread} color="var(--accent)" />{' '}unread message{totalUnread === 1 ? '' : 's'}
                    </Link>{' '}
                    across {core?.unread_spaces.length ?? 0} space{(core?.unread_spaces.length ?? 0) === 1 ? '' : 's'}.
                  </>
                )}
                {doneThisWeek > 0 && (
                  <>{' '}You've shipped{' '}
                    <Stat n={doneThisWeek} color="var(--status-green)" />{' '}
                    this week.
                  </>
                )}
              </>
            )}
          </p>
        </div>

        <div
          className="grid w-full grid-cols-5 gap-2 p-2 md:flex md:w-auto md:flex-wrap md:items-center md:justify-end md:gap-1.5 md:p-1"
          style={{
            borderRadius: 14,
            background: 'color-mix(in srgb, var(--bg-surface) 88%, black 12%)',
            border: '1px solid var(--border-default)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
            flexShrink: 0,
            maxWidth: '100%',
          }}
        >
          {heroActions.map(a => (
            <Link key={a.label} href={a.href} className="fc-btn" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              minHeight: 44,
              minWidth: 44,
              padding: '10px 12px', borderRadius: 10,
              fontSize: 12, fontWeight: 500,
              color: a.primary ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: a.primary
                ? 'color-mix(in srgb, var(--bg-hover) 75%, white 4%)'
                : 'transparent',
              textDecoration: 'none',
            }} aria-label={a.label} title={a.label}>
              <a.icon size={13} strokeWidth={1.8} />
              <span className="hidden md:inline">{a.label}</span>
            </Link>
          ))}
          <span className="hidden md:block" style={{ width: 1, height: 20, background: 'var(--border-default)', margin: '0 2px' }} />
          <button onClick={onStandup} disabled={standupGenerating} className="fc-btn" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            minHeight: 44,
            minWidth: 44,
            padding: '10px 12px', borderRadius: 10,
            fontSize: 12, fontWeight: 500,
            color: hasStandup ? 'var(--status-amber)' : 'var(--text-secondary)',
            background: hasStandup ? 'rgba(245, 158, 11, 0.08)' : 'transparent',
            border: 'none', cursor: 'pointer',
          }} aria-label="Standup" title="Standup">
            {standupGenerating ? <Loader2 size={13} className="animate-spin" /> : <Sunrise size={13} strokeWidth={1.8} />}
            <span className="hidden md:inline">Standup</span>
          </button>
          <span className="hidden md:block" style={{ width: 1, height: 20, background: 'var(--border-default)', margin: '0 2px' }} />
          <button onClick={onToggleEdit} className="fc-btn" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            minHeight: 44,
            minWidth: 44,
            padding: '10px 12px', borderRadius: 10,
            fontSize: 12, fontWeight: 500,
            color: editMode ? 'var(--accent)' : 'var(--text-secondary)',
            background: editMode ? 'var(--bg-hover)' : 'transparent',
            border: 'none', cursor: 'pointer',
          }} aria-label={editMode ? 'Done customizing' : 'Customize dashboard'} title={editMode ? 'Done' : 'Customize'}>
            {editMode ? <Check size={13} strokeWidth={1.8} /> : <Pencil size={13} strokeWidth={1.8} />}
            <span className="hidden md:inline">{editMode ? 'Done' : 'Customize'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function EditBar({
  onAdd, onReset,
}: { onAdd: () => void; onReset: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px', marginBottom: 14,
      borderRadius: 10,
      background: 'var(--bg-surface)',
      border: '1px dashed var(--border-strong)',
    }}>
      <LayoutGrid size={14} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
      <span style={{
        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
        letterSpacing: '0.02em',
      }}>
        Edit mode
      </span>
      <span style={{
        fontSize: 11, color: 'var(--text-tertiary)',
      }}>
        Drag the header of a widget to move it. Grab the bottom-right corner to resize.
      </span>
      <span style={{ flex: 1 }} />
      <button onClick={onAdd} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 7,
        fontSize: 12, fontWeight: 500,
        color: 'white', background: 'var(--accent)',
        border: 'none', cursor: 'pointer',
      }}>
        <Plus size={13} strokeWidth={1.8} />
        Add widget
      </button>
      <button onClick={onReset} className="fc-btn" style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 7,
        fontSize: 12, fontWeight: 500,
        color: 'var(--text-secondary)',
        background: 'transparent',
        border: '1px solid var(--border-default)', cursor: 'pointer',
      }}>
        <RotateCcw size={13} strokeWidth={1.8} />
        Reset
      </button>
    </div>
  );
}

function DashboardBody() {
  const { user } = useAuth();
  const { loading, core, widgetContext, setStandup } = useDashboardData();
  const [standupOpen, setStandupOpen] = useState(false);
  const [standupGenerating, setStandupGenerating] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Mobile-deep P2-8: inner-scroll container breaks iOS Safari URL-bar
  // auto-hide, pull-to-refresh, and scroll-to-top. Use body scroll on <md.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const isManager = user?.role === 'owner' || user?.role === 'admin';
  const { layout, setLayout, reset } = useLayoutStorage(user?.id, isManager);

  const handleStandup = async () => {
    if (!core?.standup) {
      setStandupGenerating(true);
      try {
        const s = await widgetContext.api.generateStandup();
        if (s) setStandup(s);
      } finally {
        setStandupGenerating(false);
      }
    }
    setStandupOpen(true);
  };

  const handleRemove = useCallback((instanceId: string) => {
    const stripFrom = (entries?: BreakpointLayoutEntry[]) =>
      entries?.filter(e => e.i !== instanceId);
    const overrides = layout.responsiveLayouts;
    setLayout({
      version: 2,
      placements: layout.placements.filter(p => p.instanceId !== instanceId),
      responsiveLayouts: overrides
        ? {
            md: stripFrom(overrides.md),
            sm: stripFrom(overrides.sm),
            xs: stripFrom(overrides.xs),
            xxs: stripFrom(overrides.xxs),
          }
        : undefined,
    });
  }, [layout, setLayout]);

  const handleAdd = useCallback((widgetId: string) => {
    const def = getWidget(widgetId);
    if (!def) return;
    const maxY = layout.placements.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    const instanceId = `${widgetId.split('.').pop() ?? 'widget'}-${Date.now()}`;
    setLayout({
      version: 2,
      placements: [
        ...layout.placements,
        {
          instanceId, widgetId,
          x: 0, y: maxY,
          w: def.defaultSize.w, h: def.defaultSize.h,
        },
      ],
      responsiveLayouts: layout.responsiveLayouts,
    });
    setAddOpen(false);
  }, [layout, setLayout]);

  const handleLayoutChange = useCallback((next: DashboardLayout) => {
    setLayout(next);
  }, [setLayout]);

  const handleConfigChange = useCallback((instanceId: string, config: unknown) => {
    setLayout({
      version: 2,
      placements: layout.placements.map(p =>
        p.instanceId === instanceId ? { ...p, config } : p
      ),
      responsiveLayouts: layout.responsiveLayouts,
    });
  }, [layout, setLayout]);

  const handleReset = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm('Reset dashboard to default layout?')) return;
    reset();
  }, [reset]);

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg-primary)' }}>
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
      </div>
    );
  }

  return (
    <div style={{
      // On <md: let the body scroll naturally (no height constraint, no overflowY).
      // On md+: use inner-scroll so the fixed sidebar layout stays intact.
      ...(isMobile ? {} : { height: '100%', overflowY: 'auto' as const }),
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>
      <style>{`
        .fc-btn { transition: background 140ms; }
        .fc-btn:hover { background: var(--bg-hover); }
        .dashboard4-grid { position: relative; }
        .dashboard4-grid .react-grid-item.react-grid-placeholder {
          background: var(--accent) !important;
          opacity: 0.18 !important;
          border-radius: 12px !important;
        }

        /* Hide the default react-resizable triangle — we draw our own. */
        .dashboard4-grid .react-resizable-handle {
          background-image: none !important;
          padding: 0 !important;
          opacity: 0;
          transition: opacity 140ms;
        }
        .dashboard4-grid[data-edit="true"] .react-resizable-handle {
          opacity: 1;
        }

        /* Corner (SE) — a visible 14×14 grip block with two chevron lines. */
        .dashboard4-grid .react-resizable-handle-se {
          width: 16px !important;
          height: 16px !important;
          right: 4px !important;
          bottom: 4px !important;
          cursor: se-resize;
          border-right: 2px solid var(--text-tertiary);
          border-bottom: 2px solid var(--text-tertiary);
          border-bottom-right-radius: 4px;
        }
        .dashboard4-grid .react-resizable-handle-se::after {
          content: '';
          position: absolute;
          right: 4px;
          bottom: 4px;
          width: 6px;
          height: 6px;
          border-right: 2px solid var(--text-tertiary);
          border-bottom: 2px solid var(--text-tertiary);
        }
        .dashboard4-grid .react-resizable-handle-se:hover,
        .dashboard4-grid .react-grid-item:hover .react-resizable-handle-se {
          border-color: var(--accent);
        }
        .dashboard4-grid .react-resizable-handle-se:hover::after {
          border-color: var(--accent);
        }

        /* East edge — thin vertical bar, wider hit area. */
        .dashboard4-grid .react-resizable-handle-e {
          width: 10px !important;
          height: 40% !important;
          top: 30% !important;
          right: -2px !important;
          cursor: ew-resize;
        }
        .dashboard4-grid .react-resizable-handle-e::after {
          content: '';
          position: absolute;
          top: 0;
          bottom: 0;
          right: 4px;
          width: 2px;
          border-radius: 2px;
          background: var(--border-strong);
          transition: background 140ms;
        }
        .dashboard4-grid .react-resizable-handle-e:hover::after {
          background: var(--accent);
        }

        /* South edge — thin horizontal bar. */
        .dashboard4-grid .react-resizable-handle-s {
          width: 40% !important;
          height: 10px !important;
          left: 30% !important;
          bottom: -2px !important;
          cursor: ns-resize;
        }
        .dashboard4-grid .react-resizable-handle-s::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: 4px;
          height: 2px;
          border-radius: 2px;
          background: var(--border-strong);
          transition: background 140ms;
        }
        .dashboard4-grid .react-resizable-handle-s:hover::after {
          background: var(--accent);
        }

        /* While resizing, drop opacity on content so the size grid shows. */
        .dashboard4-grid .react-grid-item.resizing .widget-shell {
          opacity: 0.85;
          box-shadow: 0 0 0 2px var(--accent);
        }
      `}</style>

      <div style={{ width: '100%', maxWidth: 1320, margin: '0 auto', padding: '0 24px 64px' }}>
        <AIProviderBanner />
        <Hero
          onStandup={handleStandup}
          standupGenerating={standupGenerating}
          hasStandup={!!core?.standup}
          editMode={editMode}
          onToggleEdit={() => setEditMode(e => !e)}
        />

        {editMode && (
          <EditBar onAdd={() => setAddOpen(true)} onReset={handleReset} />
        )}

        <div className="dashboard4-grid" data-edit={editMode || undefined}>
          <DashboardGrid
            layout={layout}
            ctx={widgetContext}
            editMode={editMode}
            onLayoutChange={handleLayoutChange}
            onRemove={handleRemove}
            onConfigChange={handleConfigChange}
          />
        </div>
      </div>

      <AddWidgetDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        layout={layout}
        ctx={widgetContext}
        onAdd={handleAdd}
      />

      {standupOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center',
          background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        }}
          onClick={e => { if (e.target === e.currentTarget) setStandupOpen(false); }}>
          <div style={{
            width: '100%', maxWidth: 520, margin: '0 16px', maxHeight: '70vh',
            display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 18px', borderBottom: '1px solid var(--border-default)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sunrise size={16} strokeWidth={1.8} style={{ color: 'var(--status-amber)' }} />
                <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Daily standup</h2>
                {core?.standup && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    {formatMessageTime(core.standup.date)}
                  </span>
                )}
              </div>
              <button
                onClick={() => setStandupOpen(false)}
                className="inline-flex items-center justify-center"
                style={{ minWidth: 44, minHeight: 44, color: 'var(--text-tertiary)' }}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
              {core?.standup ? (
                <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderSimpleMarkdown(core.standup.summary)) }} />
              ) : standupGenerating ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '40px 0', color: 'var(--text-tertiary)' }}>
                  <Loader2 size={16} className="animate-spin" />
                  <span style={{ fontSize: 13 }}>Generating standup…</span>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No standup generated yet today.</p>
                  <button onClick={handleStandup}
                    style={{
                      marginTop: 12, padding: '8px 16px', borderRadius: 8,
                      fontSize: 13, fontWeight: 500, color: 'white',
                      background: 'var(--accent)', border: 'none', cursor: 'pointer',
                    }}>Generate now</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard4Page() {
  return (
    <DashboardDataProvider>
      <DashboardBody />
    </DashboardDataProvider>
  );
}
