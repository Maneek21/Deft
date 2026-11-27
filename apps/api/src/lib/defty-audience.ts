// Defty answers to an audience (FIX158).
//
// Defty reads with the access of the person who asked, but its answer is
// posted in the conversation, where everyone who can read that conversation
// reads it. So in a conversation others can read, Defty uses only records
// every reader can see.
//
// - The readers of a conversation are everyone who can read it now: its
//   members, and for a public room that is not archived also every active
//   member of the workspace who is not a human guest (space-visibility.ts).
//   Only active members of the workspace count, people and agents alike; an
//   agent counts while its employee is active (it reads through the
//   employee's MCP tools, public rooms included), with the employee's
//   project scope. Defty's own user never counts. The asker counts.
// - A conversation is shared when it has a reader other than the asker. A
//   1:1 DM with Defty is not shared, and nothing changes there. A
//   conversation id that is no conversation of the workspace is shared with
//   nobody known, so every record is held back (fail closed).
// - In a shared conversation Defty's read tools run with two checks: the
//   asker's own access, as before, and "every reader can see this" under the
//   same visibility rules (tasks, rooms and messages, notes, wiki pages, and
//   an agent reader's own project scope). Only the tools in
//   SHARED_CONVERSATION_TOOLS run there; every other tool is refused with
//   SHARED_CONVERSATION_REFUSAL, so a tool nobody checked fails closed.
// - When a check held something back, Defty's reply ends with LEFT_OUT_LINE.
// - The readers are worked out once per turn. Someone who joins after the
//   answer can read it, the same as a person's message quoting a record.
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { agentEmployees, tasks, projects, wikiPages } from '@deft/db/schema';
import { db } from './db.js';
import { DEFTY_EMAIL, isCanonicalDeftyEmployee } from './defty-identity.js';
import { visibleTaskSql, type TaskVisibilityColumns } from './task-visibility.js';
import { visibleNoteCondition } from './note-visibility.js';
import { visibleWikiPageCondition } from './wiki-visibility.js';

export const SHARED_CONVERSATION_READ_UNAVAILABLE = 'SHARED_CONVERSATION_READ_UNAVAILABLE';
/** What a refused tool returns in a shared conversation. */
export const SHARED_CONVERSATION_REFUSAL = 'Other people can read this conversation, and this lookup could show things not all of them can see. Ask me in a direct message.';
/** The line Defty's reply ends with when a check held something back. */
export const LEFT_OUT_LINE = 'Some items were left out because not everyone here can see them.';

/**
 * The read tools that run in a shared conversation, each held to the
 * readers: task reads (one gate, agent-context.ts taskReadConditions),
 * projects, messages, notes and canvas, wiki. Plus two of Defty's
 * housekeeping writes, whose results carry only what the model gave them.
 * Every other tool is refused there.
 */
export const AUDIENCE_HELD_READS: ReadonlySet<string> = new Set([
  'search_tasks', 'list_my_tasks', 'get_task_detail', 'get_task_dependencies', 'get_project_progress', 'list_projects',
  'search_messages', 'search_notes', 'read_note', 'read_canvas', 'wiki_search', 'wiki_read',
]);
// wiki_suggest_update is not one of them: it names the page it looked up by slug.
const SHARED_CONVERSATION_WRITES = ['remember', 'create_plan'] as const;
export const SHARED_CONVERSATION_TOOLS: ReadonlySet<string> = new Set([...AUDIENCE_HELD_READS, ...SHARED_CONVERSATION_WRITES]);

export type DeftyAudience = Readonly<{
  orgId: string;
  conversationId: string;
  askerId: string;
  /** True when someone other than the asker can read the conversation. */
  shared: boolean;
  /** Everyone who can read the conversation, the asker included; sorted. */
  readerIds: readonly string[];
  /** Readers whose view is narrower than an owner's, admin's or member's: guests and agents. */
  narrowReaderIds: readonly string[];
  /** For each agent reader limited to some projects, those projects. */
  agentProjectScopes: ReadonlyArray<readonly string[]>;
}>;

type Executor = Pick<typeof db, 'execute'>;

const textArray = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;
const READER = sql.raw('audience_reader.user_id');

/** The statement deftyConversationAudience runs. Exported for its test. */
export function conversationReadersQuery(orgId: string, conversationId: string): SQL {
  return sql`SELECT conv.id AS space_id, reader.user_id, reader_user.kind, reader_user.email, reader_member.role,
      (SELECT coalesce(json_agg(reader_employee.project_ids), '[]'::json) FROM agent_employees reader_employee
        WHERE reader_employee.user_id = reader.user_id AND reader_employee.org_id = conv.org_id
          AND reader_employee.is_active = true AND reader_employee.is_deleted = false) AS project_scopes,
      EXISTS (SELECT 1 FROM agent_employees reader_employee
        WHERE reader_employee.user_id = reader.user_id AND reader_employee.org_id = conv.org_id
          AND reader_employee.is_active = true AND reader_employee.is_deleted = false) AS active_employee
    FROM spaces conv
    LEFT JOIN LATERAL (
      SELECT conv_member.user_id FROM space_members conv_member WHERE conv_member.space_id = conv.id
      UNION
      SELECT workspace_member.user_id FROM org_members workspace_member
        JOIN users workspace_user ON workspace_user.id = workspace_member.user_id
        WHERE conv.type = 'public' AND conv.is_archived = false
          AND workspace_member.org_id = conv.org_id AND workspace_member.is_active = true
          AND NOT (workspace_member.role = 'guest' AND workspace_user.kind = 'human')
      UNION
      -- An active employee reads every active public room over MCP
      -- (mcp-tools/messages.ts), whatever its agent's membership row says.
      SELECT workspace_employee.user_id FROM agent_employees workspace_employee
        WHERE conv.type = 'public' AND conv.is_archived = false
          AND workspace_employee.org_id = conv.org_id
          AND workspace_employee.is_active = true AND workspace_employee.is_deleted = false
    ) reader ON true
    LEFT JOIN users reader_user ON reader_user.id = reader.user_id
    LEFT JOIN org_members reader_member ON reader_member.org_id = conv.org_id
      AND reader_member.user_id = reader.user_id AND reader_member.is_active = true
    WHERE conv.id = ${conversationId} AND conv.org_id = ${orgId}`;
}

/** Who reads Defty's answer in `conversationId` (a conversation of `orgId`) asked by `askerId`. */
export async function deftyConversationAudience(
  orgId: string, conversationId: string, askerId: string, executor: Executor = db,
): Promise<DeftyAudience> {
  const rows = (await executor.execute(conversationReadersQuery(orgId, conversationId))).rows as Array<{
    space_id: string; user_id: string | null; kind: string | null; email: string | null; role: string | null;
    project_scopes: unknown; active_employee: boolean | null;
  }>;
  if (rows.length === 0) {
    // No conversation of this workspace: shared with nobody known, so nothing is shown.
    return { orgId, conversationId, askerId, shared: true, readerIds: [], narrowReaderIds: [], agentProjectScopes: [] };
  }
  // A person reads while an active member of the workspace. An agent reads
  // through its employee: it is a reader while the employee is active.
  const readers = rows.filter((row) => row.user_id && row.email !== DEFTY_EMAIL && row.kind !== 'system'
    && (row.kind === 'agent' ? row.active_employee === true : Boolean(row.role)));
  const readerIds = [...new Set(readers.map((row) => row.user_id!))].sort();
  const narrowReaderIds = [...new Set(readers
    .filter((row) => row.kind !== 'human' || !['owner', 'admin', 'member'].includes(row.role ?? ''))
    .map((row) => row.user_id!))].sort();
  const agentProjectScopes: string[][] = [];
  for (const row of readers) {
    const scopes = Array.isArray(row.project_scopes) ? row.project_scopes : [];
    for (const scope of scopes) {
      // Only a non-empty project list limits an employee (employee-project-access.ts).
      const ids = Array.isArray(scope) ? scope.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
      if (ids.length > 0) agentProjectScopes.push([...new Set(ids)].sort());
    }
  }
  return {
    orgId, conversationId, askerId,
    shared: readerIds.length === 0 || readerIds.some((id) => id !== askerId),
    readerIds, narrowReaderIds, agentProjectScopes,
  };
}

/** The audience to hold reads to, or null when the conversation is not shared. */
export function sharedAudience(audience: DeftyAudience | null | undefined): DeftyAudience | null {
  return audience?.shared ? audience : null;
}

/** True when no reader of the audience fails `visible`, a check on audience_reader.user_id. */
function everyReader(readerIds: readonly string[], visible: SQL): SQL {
  if (readerIds.length === 0) return sql`true`;
  return sql`NOT EXISTS (SELECT 1 FROM unnest(${textArray(readerIds)}) audience_reader(user_id) WHERE (${visible}) IS NOT TRUE)`;
}

/**
 * True for a task every reader can see (task-visibility.ts), and inside
 * every agent reader's project scope. An unrestricted task is visible to
 * every owner, admin and member, so only guests and agents are checked for
 * it; a restricted task is checked against every reader. On `tasks` itself
 * by default, or on the columns given.
 */
export function taskVisibleToAudienceSql(audience: DeftyAudience | null | undefined, task?: TaskVisibilityColumns): SQL {
  const held = sharedAudience(audience);
  if (!held) return sql`true`;
  if (held.readerIds.length === 0) return sql`false`;
  const visible = task ? visibleTaskSql(READER, task) : visibleTaskSql(READER);
  const metadata = task ? task.metadata : tasks.metadata;
  const projectId = task ? task.projectId : tasks.project_id;
  const scopes = held.agentProjectScopes.map((ids) => sql` AND ${projectId} = ANY(${textArray(ids)})`);
  return sql`((CASE WHEN coalesce(${metadata}->>'visibility', 'org') = 'restricted'
      THEN ${everyReader(held.readerIds, visible)}
      ELSE ${everyReader(held.narrowReaderIds, visible)} END)${sql.join(scopes, sql``)})`;
}

/** True for a project inside every agent reader's project scope (project names are visible to every member). */
export function projectVisibleToAudienceSql(audience: DeftyAudience | null | undefined, projectId: SQLWrapper = projects.id): SQL {
  const held = sharedAudience(audience);
  if (!held) return sql`true`;
  if (held.readerIds.length === 0) return sql`false`;
  const scopes = held.agentProjectScopes.map((ids) => sql` AND ${projectId} = ANY(${textArray(ids)})`);
  return sql`(true${sql.join(scopes, sql``)})`;
}

/**
 * True when `readerId` can read the room `spaceId` of `orgId` today, by the
 * rule of space-visibility.ts readableSpaceSql: they are in it, or it is a
 * public, unarchived room and they are an active member of the workspace who
 * is not a human guest, or an agent whose employee there is active (agents
 * read every public room over MCP). Every table here has its own alias, so
 * `spaceId` may be a column of an outer `spaces` (readableSpaceSql's inner
 * `spaces` would shadow it).
 */
export function roomReadableBySql(readerId: SQLWrapper | string, spaceId: SQLWrapper, orgId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM spaces audience_room
    WHERE audience_room.id = ${spaceId} AND audience_room.org_id = ${orgId}
      AND (EXISTS (SELECT 1 FROM space_members audience_room_member
          WHERE audience_room_member.space_id = audience_room.id AND audience_room_member.user_id = ${readerId})
        OR (audience_room.type = 'public' AND audience_room.is_archived = false AND (
          EXISTS (SELECT 1 FROM org_members audience_room_reader
            JOIN users audience_room_reader_user ON audience_room_reader_user.id = audience_room_reader.user_id
            WHERE audience_room_reader.org_id = audience_room.org_id AND audience_room_reader.user_id = ${readerId}
              AND audience_room_reader.is_active = true
              AND NOT (audience_room_reader.role = 'guest' AND audience_room_reader_user.kind = 'human'))
          OR EXISTS (SELECT 1 FROM agent_employees audience_room_employee
            WHERE audience_room_employee.org_id = audience_room.org_id AND audience_room_employee.user_id = ${readerId}
              AND audience_room_employee.is_active = true AND audience_room_employee.is_deleted = false)))))`;
}

/** True for a room (of `orgId`) every reader can read. The conversation itself always is. */
export function roomReadableByAudienceSql(audience: DeftyAudience | null | undefined, spaceId: SQLWrapper, orgId: SQLWrapper): SQL {
  const held = sharedAudience(audience);
  if (!held) return sql`true`;
  if (held.readerIds.length === 0) return sql`false`;
  return sql`(CASE WHEN ${spaceId} = ${held.conversationId} THEN true
    ELSE ${everyReader(held.readerIds, roomReadableBySql(READER, spaceId, orgId))} END)`;
}

/** True for a note every reader can see (note-visibility.ts). */
export function noteVisibleToAudienceSql(audience: DeftyAudience | null | undefined): SQL {
  const held = sharedAudience(audience);
  if (!held) return sql`true`;
  if (held.readerIds.length === 0) return sql`false`;
  return everyReader(held.readerIds, visibleNoteCondition(READER));
}

/** True for a wiki page every reader can see (wiki-visibility.ts). */
export function wikiPageVisibleToAudienceSql(audience: DeftyAudience | null | undefined): SQL {
  const held = sharedAudience(audience);
  if (!held) return sql`true`;
  if (held.readerIds.length === 0) return sql`false`;
  return everyReader(held.readerIds, visibleWikiPageCondition(READER, held.orgId) ?? sql`false`);
}

/** Whether every reader can read the room `spaceId`. */
export async function roomReadableByAudience(audience: DeftyAudience | null | undefined, spaceId: string): Promise<boolean> {
  const held = sharedAudience(audience);
  if (!held) return true;
  const rows = (await db.execute(sql`SELECT ${roomReadableByAudienceSql(held, sql`${spaceId}`, sql`${held.orgId}`)} AS readable`)).rows as Array<{ readable: boolean }>;
  return rows[0]?.readable === true;
}

/** Which of the wiki pages `pageIds` every reader can see. */
export async function wikiPagesVisibleToAudience(audience: DeftyAudience | null | undefined, pageIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(pageIds)];
  const held = sharedAudience(audience);
  if (!held) return new Set(ids);
  if (ids.length === 0) return new Set();
  const rows = (await db.execute(sql`SELECT ${wikiPages.id} AS id FROM ${wikiPages}
    WHERE ${wikiPages.org_id} = ${held.orgId} AND ${wikiPages.id} = ANY(${textArray(ids)}) AND ${wikiPageVisibleToAudienceSql(held)}`)).rows as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Which of the tasks `taskIds` (of the audience's workspace) every reader can see. */
export async function tasksVisibleToAudience(audience: DeftyAudience | null | undefined, taskIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(taskIds)];
  const held = sharedAudience(audience);
  if (!held) return new Set(ids);
  if (ids.length === 0) return new Set();
  const rows = (await db.execute(sql`SELECT ${tasks.id} AS id FROM ${tasks}
    WHERE ${tasks.org_id} = ${held.orgId} AND ${tasks.id} = ANY(${textArray(ids)}) AND ${taskVisibleToAudienceSql(held)}`)).rows as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * True when a run with `agentEmployeeId` is Defty: no employee, or Defty's
 * own system employee (defty-identity.ts). A BYOA employee reads as itself.
 */
export async function answersAsDefty(orgId: string, agentEmployeeId?: string | null): Promise<boolean> {
  if (!agentEmployeeId) return true;
  const [employee] = await db.select({ slug: agentEmployees.slug, runtime_kind: agentEmployees.runtime_kind, is_byoa: agentEmployees.is_byoa })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, agentEmployeeId), eq(agentEmployees.org_id, orgId)))
    .limit(1);
  return isCanonicalDeftyEmployee(employee);
}

/** Defty's reply text, with LEFT_OUT_LINE when something was held back. */
export function withLeftOutLine(text: string, withheld: boolean | undefined): string {
  if (!withheld || text.includes(LEFT_OUT_LINE)) return text;
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n_${LEFT_OUT_LINE}_` : LEFT_OUT_LINE;
}
