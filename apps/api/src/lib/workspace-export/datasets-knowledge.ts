import { sql, type SQL } from 'drizzle-orm';
import { visibleNoteCondition } from '../note-visibility.js';
import { visibleWikiPageCondition } from '../wiki-visibility.js';
import { col, type Dataset } from './datasets.js';
import { memberId, spaceReadable, workspaceAuthor, type ExportContext } from './scope.js';

/** A space id kept only when that space is in the export. `ref` must not be a column of a table named `spaces`. */
function exportedSpace(ctx: ExportContext, ref: SQL): SQL {
  return sql`CASE WHEN EXISTS (SELECT 1 FROM spaces referenced_space WHERE referenced_space.id = ${ref}
    AND referenced_space.org_id = ${ctx.orgId}
    AND ${spaceReadable(ctx, col('referenced_space.id'), col('referenced_space.org_id'))}) THEN ${ref} END`;
}

/** A note the export contains; for the member scope, one `visibleNoteCondition` lets them open. */
function exportableNote(ctx: ExportContext, ref: SQL): SQL {
  const userId = memberId(ctx);
  return sql`EXISTS (SELECT 1 FROM notes WHERE notes.id = ${ref} AND notes.org_id = ${ctx.orgId}
    AND notes.is_deleted = false AND ${userId ? visibleNoteCondition(userId) : sql`true`})`;
}

function exportableWikiPage(ctx: ExportContext, ref: SQL): SQL {
  const userId = memberId(ctx);
  return sql`EXISTS (SELECT 1 FROM wiki_pages WHERE wiki_pages.id = ${ref} AND wiki_pages.org_id = ${ctx.orgId}
    AND wiki_pages.is_deleted = false AND ${userId ? visibleWikiPageCondition(userId, ctx.orgId) : sql`true`})`;
}

/** Folders are private to their owner (GET /api/daily-notes/folders). */
function exportableFolder(ctx: ExportContext, alias: string): SQL {
  const userId = memberId(ctx);
  return sql`${col(`${alias}.org_id`)} = ${ctx.orgId} AND ${col(`${alias}.is_deleted`)} = false
    AND ${userId ? sql`${col(`${alias}.user_id`)} = ${userId}` : sql`true`}`;
}

/**
 * One named value from a JSON object, only when it is a plain string, number
 * or boolean: an object or array in its place is never written out.
 */
function scalar(object: SQL, key: string): SQL {
  return sql`CASE WHEN jsonb_typeof(${object}->${key}) IN ('string', 'number', 'boolean') THEN ${object}->>${key} END`;
}

/**
 * The metadata keys core Deft writes on events: native and assistant-created
 * events (native-calendar.ts, mcp-tools/human.ts), ICS subscriptions
 * (ics-sync.ts), app calendar sources (native-calendar-source-model.ts) and
 * GitHub sync. An event with any other key was written by another part of
 * Deft and is left out of the member scope.
 */
const CORE_EVENT_KEYS = ['start', 'end', 'location', 'attendees', 'hangoutLink', 'status', 'allDay', 'all_day',
  'ics_uid', 'ics_subscription_id', 'ics_label', 'app_calendar_source', 'github_sync'];

/** One calendar time from the stored calendar model, field by field. */
function calendarTime(ref: SQL): SQL {
  return sql`CASE WHEN jsonb_typeof(${ref}) = 'object' THEN jsonb_build_object('value', ${scalar(ref, 'value')},
    'value_type', ${scalar(ref, 'value_type')}, 'time_zone', ${scalar(ref, 'time_zone')}, 'instant', ${scalar(ref, 'instant')}) END`;
}

export const NOTES_WIKI_EVENTS: readonly Dataset[] = [
  {
    path: 'data/note_folders.jsonl',
    query: (ctx) => sql`SELECT folder.id, ${workspaceAuthor(ctx, col('folder.user_id'))} AS user_id, folder.name, folder.icon,
        CASE WHEN EXISTS (SELECT 1 FROM note_folders parent WHERE parent.id = folder.parent_folder_id AND ${exportableFolder(ctx, 'parent')})
          THEN folder.parent_folder_id END AS parent_folder_id,
        folder.sort_order, folder.created_at, folder.updated_at
      FROM note_folders folder WHERE ${exportableFolder(ctx, 'folder')}
      ORDER BY folder.user_id, folder.sort_order, folder.id`,
  },
  {
    // Note bodies are the editor's HTML, as stored.
    path: 'data/notes.jsonl',
    query: (ctx) => sql`SELECT export_note.id, ${workspaceAuthor(ctx, col('export_note.user_id'))} AS user_id,
        CASE WHEN EXISTS (SELECT 1 FROM note_folders folder WHERE folder.id = export_note.folder_id AND ${exportableFolder(ctx, 'folder')})
          THEN export_note.folder_id END AS folder_id,
        export_note.title, export_note.content, export_note.icon, export_note.is_pinned, export_note.is_template,
        export_note.visibility, ${exportedSpace(ctx, col('export_note.visibility_space_id'))} AS visibility_space_id,
        export_note.created_at, export_note.updated_at
      FROM notes export_note
      WHERE export_note.org_id = ${ctx.orgId} AND ${exportableNote(ctx, col('export_note.id'))}
      ORDER BY export_note.created_at, export_note.id`,
  },
  {
    // Who a note is shared with, as GET /api/daily-notes/:id/shares lists it:
    // recipients who are active members of this workspace. The member scope
    // sees only the shares of the member's own notes.
    path: 'data/note_shares.jsonl',
    query: (ctx) => {
      const userId = memberId(ctx);
      return sql`SELECT share.note_id, share.shared_with_user_id, share.permission, share.created_at
        FROM note_shares share JOIN notes shared_note ON shared_note.id = share.note_id
        WHERE shared_note.org_id = ${ctx.orgId} AND ${exportableNote(ctx, col('share.note_id'))}
          AND EXISTS (SELECT 1 FROM org_members recipient WHERE recipient.org_id = ${ctx.orgId}
            AND recipient.user_id = share.shared_with_user_id AND recipient.is_active = true)
          AND ${userId ? sql`shared_note.user_id = ${userId}` : sql`true`}
        ORDER BY share.note_id, share.created_at, share.id`;
    },
  },
  {
    // Wiki pages as stored (Markdown). Not their version history or search data.
    path: 'data/wiki_pages.jsonl',
    query: (ctx) => sql`SELECT page.id, page.scope, ${exportedSpace(ctx, col('page.space_id'))} AS space_id, page.type,
        page.title, page.slug, page.summary, page.content, page.tags, ${workspaceAuthor(ctx, col('page.user_id'))} AS user_id,
        page.created_via, page.version, page.created_at, page.updated_at
      FROM wiki_pages page
      WHERE page.org_id = ${ctx.orgId} AND ${exportableWikiPage(ctx, col('page.id'))}
      ORDER BY page.created_at, page.id`,
  },
  {
    path: 'data/wiki_links.jsonl',
    query: (ctx) => sql`SELECT link.source_page_id, link.target_page_id, link.context, link.created_at
      FROM wiki_links link
      WHERE link.org_id = ${ctx.orgId} AND ${exportableWikiPage(ctx, col('link.source_page_id'))}
        AND ${exportableWikiPage(ctx, col('link.target_page_id'))}
      ORDER BY link.source_page_id, link.target_page_id`,
  },
  {
    // Calendar and connected-tool events, with named fields only. The member
    // scope must never show more than the Calendar shows them. The Calendar
    // hides some events by rules that belong to other parts of Deft (whole
    // series of cancelled invitations, for one), which core code may not
    // name. So the member scope keeps only the member's own events that core
    // Deft wrote entirely (every metadata key is a core key) and that are not
    // cancelled. It may show less than the Calendar, never more.
    path: 'data/events.jsonl',
    query: (ctx) => {
      const userId = memberId(ctx);
      const meta = sql`event.metadata`;
      const model = sql`event.metadata->'app_calendar_source'->'event'`;
      const attendee = sql`attendee.value`;
      return sql`SELECT event.id, event.source, event.event_type, event.title, event.body, event.url, event.actor,
          event.timestamp, ${workspaceAuthor(ctx, col('event.user_id'))} AS user_id,
          ${scalar(meta, 'start')} AS start, ${scalar(meta, 'end')} AS "end",
          coalesce(${scalar(meta, 'all_day')}, ${scalar(meta, 'allDay')}) AS all_day,
          ${scalar(meta, 'location')} AS location, ${scalar(meta, 'status')} AS status,
          (SELECT jsonb_agg(jsonb_build_object('email', ${scalar(attendee, 'email')},
              'name', coalesce(${scalar(attendee, 'displayName')}, ${scalar(attendee, 'name')})))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.metadata->'attendees') = 'array'
              THEN event.metadata->'attendees' ELSE '[]'::jsonb END) attendee
            WHERE jsonb_typeof(attendee.value) = 'object') AS attendees,
          CASE WHEN jsonb_typeof(${model}) = 'object' THEN jsonb_build_object(
            'start', ${calendarTime(sql`${model}->'start'`)}, 'end', ${calendarTime(sql`${model}->'end'`)},
            'rrule', ${scalar(model, 'rrule')}, 'recurrence_id', ${calendarTime(sql`${model}->'recurrence_id'`)},
            'exdates', (SELECT jsonb_agg(${calendarTime(sql`exdate.value`)}) FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(${model}->'exdates') = 'array' THEN ${model}->'exdates' ELSE '[]'::jsonb END) exdate)) END AS recurrence,
          event.created_at, event.updated_at
        FROM events event
        WHERE event.org_id = ${ctx.orgId}
          AND ${userId ? sql`event.user_id = ${userId} AND event.metadata->>'status' IS DISTINCT FROM 'canceled'
            AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(event.metadata) = 'object'
              THEN event.metadata ELSE '{}'::jsonb END) metadata_key
              WHERE metadata_key <> ALL (ARRAY[${sql.join(CORE_EVENT_KEYS.map((key) => sql`${key}`), sql`, `)}]::text[]))` : sql`true`}
        ORDER BY event.timestamp, event.id`;
    },
  },
];
