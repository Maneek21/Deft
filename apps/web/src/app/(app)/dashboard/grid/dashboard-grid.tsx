'use client';

/**
 * DashboardGrid — thin wrapper over react-grid-layout's Responsive layout.
 *
 * Phase 1: read-only layout. The grid uses compactType="vertical" so widgets
 * pack against each other automatically — this is what fixes the gap from
 * /dashboard3. Edit mode (drag + resize + add/remove) is Phase 2; flip the
 * `editMode` prop to enable.
 *
 * RGL is an implementation detail — the rest of the app talks to widgets via
 * the registry + contract, not RGL. Swapping the engine later is contained
 * to this file.
 */
import { useMemo } from 'react';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { getWidget } from '../lib/registry';
import { WidgetShell } from './widget-shell';
import type { DashboardLayout, WidgetContext } from '../lib/widget-types';

const ResponsiveGridLayout = WidthProvider(Responsive);

type ViewLinkResolver = (widgetId: string) => string | undefined;

const DEFAULT_VIEW_LINKS: Record<string, string> = {
  'cairn.today': '/tasks',
  'cairn.my-work': '/tasks',
  'cairn.calendar': '/calendar',
  'cairn.unread': '/chat',
  'cairn.projects': '/tasks',
  'cairn.activity': '',
  'cairn.agent': '/agent',
  'cairn.team': '',
  'cairn.insights': '',
};

export type DashboardGridProps = {
  layout: DashboardLayout;
  ctx: WidgetContext;
  editMode?: boolean;
  onLayoutChange?: (next: DashboardLayout) => void;
  onRemove?: (instanceId: string) => void;
  onConfigChange?: (instanceId: string, config: unknown) => void;
  viewLink?: ViewLinkResolver;
};

export function DashboardGrid({
  layout, ctx, editMode = false, onLayoutChange, onRemove, onConfigChange, viewLink,
}: DashboardGridProps) {
  const placements = useMemo(() => layout.placements.filter(p => {
    const def = getWidget(p.widgetId);
    if (!def) return false;
    if (def.visibleWhen && !def.visibleWhen(ctx)) return false;
    return true;
  }), [layout.placements, ctx]);

  const rglLayout: Layout[] = useMemo(() => placements.map(p => {
    const def = getWidget(p.widgetId)!;
    return {
      i: p.instanceId,
      x: p.x, y: p.y, w: p.w, h: p.h,
      minW: def.minSize.w, minH: def.minSize.h,
      maxW: def.maxSize?.w, maxH: def.maxSize?.h,
    };
  }), [placements]);

  const handleChange = (next: Layout[]) => {
    if (!onLayoutChange) return;
    const byId = new Map(next.map(n => [n.i, n]));
    onLayoutChange({
      version: 1,
      placements: layout.placements.map(p => {
        const n = byId.get(p.instanceId);
        if (!n) return p;
        return { ...p, x: n.x, y: n.y, w: n.w, h: n.h };
      }),
    });
  };

  return (
    <ResponsiveGridLayout
      className="dashboard4-grid"
      layouts={{ lg: rglLayout, md: rglLayout, sm: rglLayout, xs: rglLayout, xxs: rglLayout }}
      breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
      cols={{ lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 }}
      rowHeight={60}
      margin={[16, 16]}
      containerPadding={[0, 0]}
      compactType="vertical"
      preventCollision={false}
      isDraggable={editMode}
      isResizable={editMode}
      resizeHandles={['se', 'e', 's']}
      draggableHandle=".widget-drag-handle"
      onLayoutChange={handleChange}
    >
      {placements.map(p => {
        const def = getWidget(p.widgetId)!;
        const Component = def.Component;
        const hrefResolved = viewLink?.(p.widgetId) ?? DEFAULT_VIEW_LINKS[p.widgetId];
        return (
          <div key={p.instanceId}>
            <WidgetShell
              title={def.title}
              href={hrefResolved || undefined}
              editMode={editMode}
              onRemove={onRemove ? () => onRemove(p.instanceId) : undefined}
            >
              <Component
                instanceId={p.instanceId}
                size={{ w: p.w, h: p.h }}
                config={(p.config ?? null) as any}
                onConfigChange={onConfigChange ? (c: unknown) => onConfigChange(p.instanceId, c) : undefined}
                editMode={editMode}
              />
            </WidgetShell>
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}
