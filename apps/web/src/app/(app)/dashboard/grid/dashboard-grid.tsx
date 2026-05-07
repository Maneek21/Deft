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
import type { BreakpointLayoutEntry, DashboardLayout, WidgetContext } from '../lib/widget-types';

const ResponsiveGridLayout = WidthProvider(Responsive);

type ViewLinkResolver = (widgetId: string) => string | undefined;

const DEFAULT_VIEW_LINKS: Record<string, string> = {
  'cairn.today': '/tasks',
  'cairn.my-work': '/tasks',
  'cairn.calendar': '/calendar',
  'cairn.unread': '/chat',
  'cairn.projects': '/tasks',
  'cairn.activity': '',
  'cairn.agent': '/chat',
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

  const layouts = useMemo(() => {
    const placementById = new Map(placements.map(p => [p.instanceId, p]));
    const lg: Layout[] = placements.map(p => {
      const def = getWidget(p.widgetId)!;
      return {
        i: p.instanceId,
        x: p.x, y: p.y, w: p.w, h: p.h,
        minW: def.minSize.w, minH: def.minSize.h,
        maxW: def.maxSize?.w, maxH: def.maxSize?.h,
      };
    });
    const fromOverride = (entries?: BreakpointLayoutEntry[]): Layout[] | undefined => {
      if (!entries) return undefined;
      const seen = new Set<string>();
      const out: Layout[] = [];
      for (const e of entries) {
        const p = placementById.get(e.i);
        if (!p) continue; // widget removed since this breakpoint layout was saved
        const def = getWidget(p.widgetId)!;
        out.push({
          i: e.i,
          x: e.x, y: e.y, w: e.w, h: e.h,
          minW: def.minSize.w, minH: def.minSize.h,
          maxW: def.maxSize?.w, maxH: def.maxSize?.h,
        });
        seen.add(e.i);
      }
      // Append any placements added since this breakpoint was last saved so they
      // still appear (RGL will compact them into place).
      for (const p of placements) {
        if (seen.has(p.instanceId)) continue;
        const def = getWidget(p.widgetId)!;
        out.push({
          i: p.instanceId,
          x: p.x, y: p.y, w: p.w, h: p.h,
          minW: def.minSize.w, minH: def.minSize.h,
          maxW: def.maxSize?.w, maxH: def.maxSize?.h,
        });
      }
      return out;
    };
    const overrides = layout.responsiveLayouts ?? {};
    return {
      lg,
      md: fromOverride(overrides.md) ?? lg,
      sm: fromOverride(overrides.sm) ?? lg,
      xs: fromOverride(overrides.xs) ?? lg,
      xxs: fromOverride(overrides.xxs) ?? lg,
    };
  }, [placements, layout.responsiveLayouts]);

  const handleChange = (_current: Layout[], all: { [breakpoint: string]: Layout[] }) => {
    if (!onLayoutChange) return;
    const lgEntries = all.lg ?? [];
    const byId = new Map(lgEntries.map(n => [n.i, n]));
    const nextPlacements = layout.placements.map(p => {
      const n = byId.get(p.instanceId);
      if (!n) return p;
      return { ...p, x: n.x, y: n.y, w: n.w, h: n.h };
    });
    const stripMeta = (entries?: Layout[]): BreakpointLayoutEntry[] | undefined =>
      entries?.map(e => ({ i: e.i, x: e.x, y: e.y, w: e.w, h: e.h }));
    const responsiveLayouts = {
      md: stripMeta(all.md),
      sm: stripMeta(all.sm),
      xs: stripMeta(all.xs),
      xxs: stripMeta(all.xxs),
    };
    onLayoutChange({
      version: 2,
      placements: nextPlacements,
      responsiveLayouts,
    });
  };

  return (
    <ResponsiveGridLayout
      className="dashboard4-grid"
      layouts={layouts}
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
