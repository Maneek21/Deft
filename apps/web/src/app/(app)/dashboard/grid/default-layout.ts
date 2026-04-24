/**
 * Default bento layout. 12-column grid, arranged to cover the gap from /dashboard3:
 *
 * ┌──────────────── Today ───────────────────┐┌── Calendar ──┐
 * │ 8 cols × 4 rows                          ││ 4 × 6        │
 * ├──────────────── My Work ─────────────────┤│              │
 * │ 8 × 5                                    ││              │
 * │                                          │└──────────────┘
 * │                                          │┌── Unread ────┐
 * │                                          ││ 4 × 4        │
 * └──────────────────────────────────────────┘└──────────────┘
 * ┌── Projects ──┐┌── Activity ──┐┌── Agent ─┐┌── Insights ──┐
 * │ 3 × 4        ││ 3 × 4        ││ 3 × 4    ││ 3 × 4        │
 * └──────────────┘└──────────────┘└──────────┘└──────────────┘
 *   (Team replaces one of the bottom row cells when isManager)
 */
import type { DashboardLayout } from '../lib/widget-types';

export function buildDefaultLayout(isManager: boolean): DashboardLayout {
  const placements: DashboardLayout['placements'] = [
    { instanceId: 'today',    widgetId: 'cairn.today',    x: 0, y: 0, w: 8, h: 4 },
    { instanceId: 'calendar', widgetId: 'cairn.calendar', x: 8, y: 0, w: 4, h: 6 },
    { instanceId: 'my-work',  widgetId: 'cairn.my-work',  x: 0, y: 4, w: 8, h: 5 },
    { instanceId: 'unread',   widgetId: 'cairn.unread',   x: 8, y: 6, w: 4, h: 3 },

    { instanceId: 'projects', widgetId: 'cairn.projects', x: 0, y: 9, w: 3, h: 4 },
    { instanceId: 'activity', widgetId: 'cairn.activity', x: 3, y: 9, w: 3, h: 4 },
    { instanceId: 'agent',    widgetId: 'cairn.agent',    x: 6, y: 9, w: 3, h: 4 },
    { instanceId: 'insights', widgetId: 'cairn.insights', x: 9, y: 9, w: 3, h: 4 },
  ];
  if (isManager) {
    placements.push({
      instanceId: 'team', widgetId: 'cairn.team',
      x: 0, y: 13, w: 12, h: 3,
    });
  }
  return { version: 1, placements };
}
