import { sql, type SQL } from 'drizzle-orm';
import { visibleLiveMemberForOrg } from '../member-visibility.js';
import { spaceReadable, workspaceUser, userKnown, type ExportContext } from './scope.js';

/**
 * A dataset is one JSON Lines file. Its SELECT list is the allowlist: only the
 * named columns are written, under the names given here. Never `SELECT *`,
 * never a whole JSONB column. Every query is filtered on the workspace's id,
 * and every row it reaches through a join is checked to be in the workspace
 * too (both ends of every link).
 */
export type Dataset = Readonly<{
  path: string;
  /** Datasets that only make sense for one scope. */
  scopes?: readonly ('workspace' | 'member')[];
  query: (ctx: ExportContext) => SQL;
}>;

const col = (ref: string) => sql.raw(ref);

export const PEOPLE_AND_SPACES: readonly Dataset[] = [
  {
    // People, guests and agents. The member scope sees what GET /api/members shows.
    path: 'data/members.jsonl',
    query: (ctx) => ctx.scope.kind === 'workspace'
      ? sql`SELECT users.id AS user_id, users.name, users.email, users.kind, org_members.role,
            org_members.is_active, users.title, org_members.joined_at
          FROM org_members JOIN users ON users.id = org_members.user_id
          WHERE org_members.org_id = ${ctx.orgId}
          ORDER BY org_members.joined_at, users.id`
      : sql`SELECT users.id AS user_id, users.name, users.email, users.kind, org_members.role,
            org_members.is_active
          FROM org_members JOIN users ON users.id = org_members.user_id
          WHERE org_members.org_id = ${ctx.orgId} AND org_members.is_active = true
            AND ${visibleLiveMemberForOrg(sql`org_members.org_id`)}
          ORDER BY org_members.joined_at, users.id`,
  },
  {
    // Agent employees' descriptions. Never their prompts, tokens or settings.
    path: 'data/agents.jsonl',
    scopes: ['workspace'],
    query: (ctx) => sql`SELECT a.id, a.user_id, a.name, a.job_title, a.expertise_description, a.is_active, a.created_at
      FROM agent_employees a
      WHERE a.org_id = ${ctx.orgId} AND a.is_deleted = false
        AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ${ctx.orgId} AND m.user_id = a.user_id)
      ORDER BY a.created_at, a.id`,
  },
  {
    // Public and private spaces, direct messages, group DMs and assistant conversations.
    path: 'data/spaces.jsonl',
    query: (ctx) => sql`SELECT export_space.id, export_space.name, export_space.description, export_space.topic,
        export_space.type, export_space.is_default, export_space.is_archived,
        ${workspaceUser(ctx, col('export_space.created_by'))} AS created_by,
        export_space.created_at, export_space.updated_at
      FROM spaces export_space
      WHERE export_space.org_id = ${ctx.orgId}
        AND ${spaceReadable(ctx, col('export_space.id'), col('export_space.org_id'))}
      ORDER BY export_space.created_at, export_space.id`,
  },
  {
    path: 'data/space_members.jsonl',
    query: (ctx) => sql`SELECT export_space.id AS space_id, export_member.user_id, export_member.joined_at
      FROM space_members export_member
      JOIN spaces export_space ON export_space.id = export_member.space_id
      WHERE export_space.org_id = ${ctx.orgId}
        AND ${userKnown(ctx, col('export_member.user_id'))}
        AND ${spaceReadable(ctx, col('export_space.id'), col('export_space.org_id'))}
      ORDER BY export_space.id, export_member.joined_at, export_member.user_id`,
  },
];
