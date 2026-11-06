import type { LayoutItem } from 'react-grid-layout';
import type { DragConfig, ResizeConfig } from 'react-grid-layout/core';
import type { BreakpointLayoutEntry } from '../lib/widget-types';

export type StackedLayoutSource = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minH: number;
  maxH?: number;
};

/**
 * Build a single-column responsive layout without carrying desktop widths or
 * x positions into a narrower grid. Saved breakpoint entries still determine
 * order and height, so vertical customization survives the normalization.
 */
export function buildStackedLayout(
  sources: StackedLayoutSource[],
  columns: number,
  overrides?: BreakpointLayoutEntry[],
): LayoutItem[] {
  const safeColumns = Math.max(1, Math.floor(columns));
  const overrideById = new Map(overrides?.map((entry) => [entry.i, entry]) ?? []);

  const ordered = sources
    .map((source, index) => ({
      source,
      position: overrideById.get(source.i) ?? source,
      index,
    }))
    .sort((left, right) =>
      left.position.y - right.position.y ||
      left.position.x - right.position.x ||
      left.index - right.index,
    );

  let nextY = 0;
  return ordered.map(({ source, position }) => {
    const minH = Math.max(1, source.minH);
    const requestedH = Math.max(minH, position.h);
    const h = source.maxH === undefined ? requestedH : Math.min(requestedH, source.maxH);
    const entry: LayoutItem = {
      i: source.i,
      x: 0,
      y: nextY,
      w: safeColumns,
      h,
      minW: safeColumns,
      maxW: safeColumns,
      minH,
      maxH: source.maxH,
    };
    nextY += h;
    return entry;
  });
}

/**
 * Map dashboard edit state onto react-grid-layout v2's interaction configs.
 * v2 has no flat isDraggable/isResizable props, and its drag/resize defaults are
 * enabled — a read-only dashboard must explicitly turn both off.
 */
export function dashboardGridInteractionConfig(editMode: boolean): {
  dragConfig: Partial<DragConfig>;
  resizeConfig: Partial<ResizeConfig>;
} {
  return {
    dragConfig: { enabled: editMode, handle: '.widget-drag-handle' },
    resizeConfig: { enabled: editMode, handles: ['se', 'e', 's'] },
  };
}
