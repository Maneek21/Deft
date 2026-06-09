/**
 * events_query — Phase 6 read-only event search.
 *
 * Queries the `events` table (the unified schema where native events,
 * calendar reminders, imported ICS feeds, and connected-tool events land).
 * Lets an agent read the event stream for its org without needing every user
 * to connect a separate MCP server per provider.
 *
 * Filtering:
 *   - `type` / `types` narrows by event_type (e.g. 'calendar_event')
 *   - `source` narrows by source enum (e.g. 'ics', 'google_calendar')
 *   - `since` / `until`— ISO8601 window on the event.timestamp field
 *
 * Scoping is strict: every query is filtered by `ctx.org_id`. There is no
 * `is_deleted` column on `events`, so no soft-delete filter. Results are
 * capped at 200 rows and default to 50.
 */
import { and, eq, gte, lte, inArray, desc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db.js';
import { events } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

const VALID_SOURCES = new Set([
  'native',
  'google_calendar',
  'ics',
  'github',
  'linear',
]);

export type EventsQueryArgs = {
  caller_employee_slug: string;
  type?: string;
  types?: string[];
  since?: string;
  until?: string;
  source?: string;
  limit?: number;
};

function parseIsoDate(v: string | undefined, label: string): Date | null | Error {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) {
    return new Error(`events_query: ${label} is not a valid ISO8601 date: ${v}`);
  }
  return d;
}

export async function eventsQuery(
  args: EventsQueryArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);

  try {
    const conditions: SQL[] = [eq(events.org_id, ctx.org_id)];

    // Type filter: prefer `types` (list) if present, else fall back to `type`.
    if (Array.isArray(args.types) && args.types.length > 0) {
      const cleaned = args.types.filter((t) => typeof t === 'string' && t.length > 0);
      if (cleaned.length > 0) {
        conditions.push(inArray(events.event_type, cleaned));
      }
    } else if (args.type && typeof args.type === 'string') {
      conditions.push(eq(events.event_type, args.type));
    }

    if (args.source && VALID_SOURCES.has(args.source)) {
      // Drizzle enum column — cast via `as any` since the column type is the
      // enum union. We've already validated membership.
      conditions.push(eq(events.source, args.source as any));
    }

    const sinceDate = parseIsoDate(args.since, 'since');
    if (sinceDate instanceof Error) return errorResult(sinceDate.message);
    if (sinceDate) conditions.push(gte(events.timestamp, sinceDate));

    const untilDate = parseIsoDate(args.until, 'until');
    if (untilDate instanceof Error) return errorResult(untilDate.message);
    if (untilDate) conditions.push(lte(events.timestamp, untilDate));

    const rows = await db
      .select({
        id: events.id,
        source: events.source,
        event_type: events.event_type,
        external_id: events.external_id,
        title: events.title,
        body: events.body,
        url: events.url,
        actor: events.actor,
        timestamp: events.timestamp,
        user_id: events.user_id,
        connected_account_id: events.connected_account_id,
      })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.timestamp))
      .limit(limit);

    return textResult(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`events_query failed: ${msg}`);
  }
}
