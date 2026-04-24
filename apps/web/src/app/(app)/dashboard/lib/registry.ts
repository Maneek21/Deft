/**
 * Widget Registry
 *
 * Widgets register themselves at module load. The grid looks up by id.
 * Namespaced ids (cairn.*, acme.*) prevent collisions between first- and
 * third-party widgets. No page.tsx edits required to add a widget.
 */
import type { WidgetDefinition } from './widget-types';

const REGISTRY = new Map<string, WidgetDefinition<any>>();

export function registerWidget<C>(def: WidgetDefinition<C>): void {
  if (def.apiVersion !== 1) {
    console.warn(`[widgets] ${def.id} uses apiVersion ${def.apiVersion}, expected 1`);
  }
  if (REGISTRY.has(def.id)) {
    console.warn(`[widgets] duplicate id: ${def.id}`);
  }
  REGISTRY.set(def.id, def as WidgetDefinition<any>);
}

export function getWidget(id: string): WidgetDefinition<any> | undefined {
  return REGISTRY.get(id);
}

export function allWidgets(): WidgetDefinition<any>[] {
  return Array.from(REGISTRY.values());
}
