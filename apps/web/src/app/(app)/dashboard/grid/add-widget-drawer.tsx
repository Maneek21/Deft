'use client';

/**
 * AddWidgetDrawer — right-side panel listing every widget the user hasn't placed.
 *
 * Uses `allWidgets()` from the registry, filters out ones already in the layout,
 * filters out ones hidden by `visibleWhen` for the current context, and renders
 * an "Add" button for each.
 */
import { X, Plus } from 'lucide-react';
import { allWidgets } from '../lib/registry';
import type { DashboardLayout, WidgetContext } from '../lib/widget-types';

export type AddWidgetDrawerProps = {
  open: boolean;
  onClose: () => void;
  layout: DashboardLayout;
  ctx: WidgetContext;
  onAdd: (widgetId: string) => void;
};

const CATEGORY_LABEL: Record<string, string> = {
  work: 'Work',
  calendar: 'Calendar',
  team: 'Team',
  agent: 'Agent',
  activity: 'Activity',
  insights: 'Insights',
  external: 'External',
};

export function AddWidgetDrawer({ open, onClose, layout, ctx, onAdd }: AddWidgetDrawerProps) {
  const placedIds = new Set(layout.placements.map(p => p.widgetId));
  const available = allWidgets()
    .filter(w => !placedIds.has(w.id))
    .filter(w => !w.visibleWhen || w.visibleWhen(ctx));

  const byCategory = available.reduce<Record<string, typeof available>>((acc, w) => {
    (acc[w.category] ||= []).push(w);
    return acc;
  }, {});

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 90,
            background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(2px)',
          }}
        />
      )}
      <aside
        aria-hidden={!open}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 360,
          zIndex: 91, transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 220ms ease',
          background: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-default)',
          boxShadow: open ? '-8px 0 30px rgba(0,0,0,0.35)' : 'none',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px', borderBottom: '1px solid var(--border-default)',
        }}>
          <div>
            <h2 style={{
              fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0,
            }}>Add a widget</h2>
            <p style={{
              fontSize: 12, color: 'var(--text-tertiary)', margin: '2px 0 0',
            }}>
              {available.length === 0 ? 'Every widget is already on your dashboard.' : `${available.length} available`}
            </p>
          </div>
          <button onClick={onClose} style={{
            padding: 4, color: 'var(--text-tertiary)', background: 'transparent',
            border: 'none', cursor: 'pointer',
          }}>
            <X size={16} />
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 24px' }}>
          {Object.entries(byCategory).map(([cat, widgets]) => (
            <section key={cat} style={{ marginBottom: 20 }}>
              <h3 style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: 'var(--text-tertiary)',
                margin: '0 0 8px',
              }}>{CATEGORY_LABEL[cat] ?? cat}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {widgets.map(w => {
                  const Icon = w.icon;
                  return (
                    <button
                      key={w.id}
                      onClick={() => onAdd(w.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 12px', borderRadius: 8,
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border-default)',
                        textAlign: 'left', cursor: 'pointer',
                        transition: 'background 140ms, border-color 140ms',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                        e.currentTarget.style.borderColor = 'var(--border-strong)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'var(--bg-primary)';
                        e.currentTarget.style.borderColor = 'var(--border-default)';
                      }}
                    >
                      <div style={{
                        display: 'grid', placeItems: 'center',
                        width: 28, height: 28, borderRadius: 6,
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--border-default)',
                        color: 'var(--text-secondary)', flexShrink: 0,
                      }}>
                        {Icon ? <Icon size={14} strokeWidth={1.8} /> : <Plus size={14} strokeWidth={1.8} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                        }}>{w.title}</div>
                        {w.description && (
                          <div style={{
                            fontSize: 11, color: 'var(--text-tertiary)',
                            marginTop: 2, lineHeight: 1.35,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{w.description}</div>
                        )}
                      </div>
                      <Plus size={14} strokeWidth={1.8} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {available.length === 0 && (
            <div style={{
              textAlign: 'center', padding: '40px 20px',
              color: 'var(--text-tertiary)', fontSize: 13,
            }}>
              You've added every widget. Remove one from the dashboard to add it again.
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
