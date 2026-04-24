/**
 * Widget Contract — dashboard4
 *
 * A widget is a self-contained module that can render a bento cell on the
 * dashboard. The contract is intentionally:
 *   - versioned (apiVersion)    → we can evolve without breaking existing widgets
 *   - layout-engine agnostic    → swap react-grid-layout for something else without
 *                                 touching widget code
 *   - sandbox-ready             → widgets receive a curated API facade (not our
 *                                 internal api client) so we can later run third-party
 *                                 widgets in iframes/workers without a rewrite
 *
 * v1 widgets live in this repo. v2+ third-party widgets will implement this same
 * contract and call registerWidget() at mount time.
 */
import type { ComponentType } from 'react';
import type { WidgetApiFacade } from './facade';

export type WidgetSize = { w: number; h: number };

export type WidgetCategory =
  | 'work'
  | 'calendar'
  | 'team'
  | 'agent'
  | 'activity'
  | 'insights'
  | 'external';

/** Scoped view of workspace/user/theme a widget is allowed to read. */
export type WidgetContext = {
  user: {
    id: string;
    name: string;
    role: string;
  };
  /** CSS variable names only — never raw theme values, so themes can be swapped. */
  theme: {
    tokens: {
      textPrimary: string;
      textSecondary: string;
      textTertiary: string;
      bgPrimary: string;
      bgSurface: string;
      bgHover: string;
      borderDefault: string;
      borderStrong: string;
      accent: string;
      accentMuted: string;
      statusGreen: string;
      statusAmber: string;
      statusRed: string;
      statusBlue: string;
    };
  };
  api: WidgetApiFacade;
};

/** Props passed to a widget's Component on every render. */
export type WidgetProps<Config = unknown> = {
  /** Unique per placement — a widget can appear more than once. */
  instanceId: string;
  /** Current size (grid cells). Widgets may use this to adapt density. */
  size: WidgetSize;
  /** Per-instance config. Null/undefined until user opens settings. */
  config: Config | null;
  onConfigChange?: (c: Config) => void;
  /** True when the page is in edit mode — widgets may want to suppress interaction. */
  editMode: boolean;
};

/** The declarative module a widget author ships. */
export type WidgetDefinition<Config = unknown> = {
  /** Contract version. Always 1 for now. */
  apiVersion: 1;
  /** Globally unique, dot-namespaced: "cairn.today", "acme.github-prs". */
  id: string;
  title: string;
  description?: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  category: WidgetCategory;

  defaultSize: WidgetSize;
  minSize: WidgetSize;
  maxSize?: WidgetSize;

  /** Gate visibility based on context (e.g. manager-only). */
  visibleWhen?: (ctx: WidgetContext) => boolean;

  /** The component. Receives WidgetProps. */
  Component: ComponentType<WidgetProps<Config>>;

  /** Optional JSON-Schema for the settings form (filled in later phases). */
  settingsSchema?: Record<string, unknown>;
  defaultConfig?: Config;
};

/** What a user has placed on their dashboard. Stored layout state. */
export type WidgetPlacement = {
  instanceId: string;
  widgetId: string;
  x: number; y: number;
  w: number; h: number;
  config?: unknown;
};

export type DashboardLayout = {
  version: 1;
  placements: WidgetPlacement[];
};
