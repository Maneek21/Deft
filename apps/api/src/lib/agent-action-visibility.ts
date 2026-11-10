import {and, eq, sql, type SQL} from 'drizzle-orm';
import {agentActions, messages, notes, projects, spaceMembers, spaces, tasks, wikiPages} from '@deft/db/schema';
import {db} from './db.js';
import {resolveSpaceTargetFromRows} from './resolve-space-target.js';
import {requireSpaceMembership} from './space-membership.js';
import {visibleTaskCondition} from './task-visibility.js';
import {visibleWikiPageCondition} from './wiki-visibility.js';
export function visibleCaptureActionSql(user: { id: string; org_id: string }) {
  return sql`(
    ${agentActions.source} IS DISTINCT FROM 'defty_capture'
    OR (
      (
        COALESCE(
          ${agentActions.params}->>'source_space_id',
          ${agentActions.params}->>'origin_space_id',
          ${agentActions.params}->>'space_id'
        ) IS NULL
        OR EXISTS (
          SELECT 1
          FROM space_members agent_capture_sm
          INNER JOIN spaces agent_capture_s
            ON agent_capture_s.id = agent_capture_sm.space_id
          WHERE agent_capture_sm.space_id = COALESCE(
              ${agentActions.params}->>'source_space_id',
              ${agentActions.params}->>'origin_space_id',
              ${agentActions.params}->>'space_id'
            )
            AND agent_capture_sm.user_id = ${user.id}
            AND agent_capture_s.org_id = ${user.org_id}
            AND agent_capture_s.is_archived = false
        )
      )
      AND (
        ${agentActions.params}->>'source_message_id' IS NULL
        OR EXISTS (
          SELECT 1
          FROM messages agent_capture_m
          INNER JOIN space_members agent_capture_msg_sm
            ON agent_capture_msg_sm.space_id = agent_capture_m.space_id
          INNER JOIN spaces agent_capture_msg_s
            ON agent_capture_msg_s.id = agent_capture_m.space_id
          WHERE agent_capture_m.id = ${agentActions.params}->>'source_message_id'
            AND agent_capture_m.org_id = ${user.org_id}
            AND agent_capture_m.is_deleted = false
            AND agent_capture_msg_sm.user_id = ${user.id}
            AND agent_capture_msg_s.org_id = ${user.org_id}
            AND agent_capture_msg_s.is_archived = false
            AND (
              COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              ) IS NULL
              OR agent_capture_m.space_id = COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              )
            )
        )
      )
    )
  )`;
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : null;
}

/**
 * Undo authority (C01). The caller must be the action's requester or an org
 * owner/admin, AND must still be able to see the object the undo would change
 * (task visibility for task actions, space membership for posted messages).
 * Callers answer `false` exactly like a missing action.
 */
export async function canUndoAgentAction(
  user: { id: string; org_id: string; role?: string },
  action: { user_id: string; action: string; params: unknown; result: unknown; before_state: unknown },
): Promise<boolean> {
  const requester = action.user_id === user.id
    || stringField(action.params, 'source_user_id') === user.id
    || stringField(action.params, 'origin_user_id') === user.id;
  if (!requester && user.role !== 'owner' && user.role !== 'admin') return false;

  switch (action.action) {
    case 'create_task':
    case 'update_task_status':
    case 'assign_task': {
      const taskId = stringField(action.before_state, 'task_id') ?? stringField(action.result, 'task_id');
      if (!taskId) return true;
      const [task] = await db.select({ id: tasks.id }).from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.project_id))
        .where(and(eq(tasks.id, taskId), eq(tasks.org_id, user.org_id), visibleTaskCondition(user.id)))
        .limit(1);
      return Boolean(task);
    }
    case 'post_message': {
      const messageId = stringField(action.result, 'message_id');
      if (!messageId) return true;
      const [message] = await db.select({ space_id: messages.space_id }).from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.org_id, user.org_id)))
        .limit(1);
      return Boolean(message && await requireSpaceMembership(message.space_id, user.id, user.org_id));
    }
    default:
      return true;
  }
}

/**
 * Note promotion (C13): the same predicate the Defty proposal applies — the
 * actor's own note, an org note, or a space note in a space the actor is a
 * member of.
 */
export function promotableNoteSql(userId: string): SQL {
  return sql`(
    ${notes.user_id} = ${userId}
    OR ${notes.visibility} = 'org'
    OR (${notes.visibility} = 'space' AND EXISTS (
      SELECT 1 FROM space_members promotable_note_sm
      WHERE promotable_note_sm.space_id = ${notes.visibility_space_id}
        AND promotable_note_sm.user_id = ${userId}
    ))
  )`;
}

const INVALID_TARGET = 'Invalid action target';

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** Non-archived spaces in the org the actor belongs to. */
async function memberSpaces(orgId: string, userId: string) {
  return db.select({ id: spaces.id, name: spaces.name, type: spaces.type, is_archived: spaces.is_archived })
    .from(spaces)
    .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, userId)))
    .where(and(eq(spaces.org_id, orgId), eq(spaces.is_archived, false)));
}

export type NativeActionTarget = { params: Record<string, any> } | { error: string };

/**
 * Execution-time target authorization for native writes (C03). Rejects
 * malformed target types, then resolves ONE target among the targets the
 * acting principal (the user the action runs for, or the employee's user)
 * may use under the HTTP route's rule: wiki page visibility, or membership of
 * the target space. Name lookups only consider the actor's own spaces, so an
 * answer never depends on, or reveals, a space the actor cannot see. The
 * returned params carry the authorized space id, and the executor uses that
 * id instead of repeating the name search. Caller-supplied resolved ids are
 * dropped. Actions this does not govern pass through unchanged.
 */
export async function authorizeNativeActionTarget(
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
): Promise<NativeActionTarget> {
  switch (action) {
    case 'post_message': {
      if (!optionalString(params.space_id) || !optionalString(params.resolved_space_id)
        || !optionalString(params.space_name)) return { error: INVALID_TARGET };
      const resolved = resolveSpaceTargetFromRows(await memberSpaces(orgId, userId), {
        spaceId: params.space_id ?? params.resolved_space_id,
        spaceName: params.space_name,
      });
      if (resolved.status !== 'resolved') return { error: resolved.message };
      return { params: { ...params, space_id: resolved.space.id, resolved_space_id: resolved.space.id } };
    }
    case 'add_knowledge':
    case 'write_canvas': {
      const next = { ...params };
      delete next.resolved_space_id;
      if (action === 'write_canvas' && (params.space_name === undefined || params.space_name === null)) {
        return { params: next };
      }
      if (typeof params.space_name !== 'string') return { error: INVALID_TARGET };
      const spaceName = action === 'write_canvas' ? params.space_name.trim() : params.space_name;
      if (!spaceName) return action === 'write_canvas' ? { params: next } : { error: INVALID_TARGET };
      const wanted = spaceName.toLowerCase();
      const rows = await memberSpaces(orgId, userId);
      const exact = rows.filter((space) => space.name.toLowerCase() === wanted);
      // write_canvas matches the whole name; add_knowledge matches a part of
      // it, preferring a single whole-name match.
      const candidates = action === 'write_canvas' || exact.length === 1
        ? exact
        : rows.filter((space) => space.name.toLowerCase().includes(wanted));
      if (candidates.length === 0) return { error: `Space "${spaceName}" not found` };
      if (candidates.length > 1) return { error: `Space "${spaceName}" matches more than one space; use its full name` };
      return { params: { ...next, resolved_space_id: candidates[0]!.id } };
    }
    case 'post_thread_reply': {
      if (!optionalString(params.parent_message_id)) return { error: INVALID_TARGET };
      const parentId = params.parent_message_id;
      if (!parentId) return { params };
      const [parent] = await db.select({ space_id: messages.space_id }).from(messages)
        .where(and(eq(messages.id, parentId), eq(messages.org_id, orgId), eq(messages.is_deleted, false)))
        .limit(1);
      return !parent || await requireSpaceMembership(parent.space_id, userId, orgId)
        ? { params }
        : { error: 'Parent message not found in this org' };
    }
    case 'create_note': {
      if (params.visibility !== 'space') return { params };
      if (!optionalString(params.visibility_space_id)) return { error: INVALID_TARGET };
      if (!params.visibility_space_id) return { params };
      const [space] = await db.select({ id: spaces.id }).from(spaces).where(and(
        eq(spaces.id, params.visibility_space_id),
        eq(spaces.org_id, orgId),
        eq(spaces.is_archived, false),
      )).limit(1);
      return space && await requireSpaceMembership(space.id, userId, orgId)
        ? { params }
        : { error: 'I could not verify access to the target space for this note.' };
    }
    case 'wiki_write': {
      if (!optionalString(params.slug)) return { error: INVALID_TARGET };
      const related = params.related_slugs;
      if (related !== undefined && related !== null
        && !(Array.isArray(related) && related.every((slug: unknown) => typeof slug === 'string'))) {
        return { error: INVALID_TARGET };
      }
      const slugs = [...(params.slug ? [params.slug as string] : []), ...((related ?? []) as string[])];
      for (const slug of slugs) {
        const pages = await db.select({ id: wikiPages.id }).from(wikiPages)
          .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug)));
        if (pages.length === 0) continue;
        const visible = await db.select({ id: wikiPages.id }).from(wikiPages)
          .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug), visibleWikiPageCondition(userId, orgId)));
        if (visible.length !== pages.length) return { error: `Wiki page "${slug}" not found` };
      }
      return { params };
    }
    default:
      return { params };
  }
}
