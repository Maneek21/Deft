/**
 * Shared DB fixture for the W2-a2 action-durability tests. Creates one
 * disposable org (requester member, admin, a second member), a private space
 * and a project, and mounts the agent routes behind a header-selected user.
 * Run only against a disposable DB (DEFT_TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';

import { closeDb } from '../../src/lib/db.js';
import { agentRoutes } from '../../src/routes/agent.js';
import { safeTestDatabaseUrl } from './safe-test-database.js';

export type DurabilityFixture = {
  client: pg.Client;
  orgId: string;
  requesterId: string;
  otherId: string;
  adminId: string;
  spaceId: string;
  projectId: string;
  prefix: string;
  as: (userId: string, path: string, init?: RequestInit) => Response | Promise<Response>;
  insertAction: (values: InsertActionValues) => Promise<string>;
  insertTask: (values: { title: string; status?: string; assigneeId?: string | null; parentId?: string | null }) => Promise<string>;
  insertMessage: (content: string, userId?: string) => Promise<string>;
  teardown: () => Promise<void>;
};

export type InsertActionValues = {
  userId?: string;
  action: string;
  params: Record<string, unknown>;
  status?: 'pending' | 'approved' | 'rejected';
  result?: Record<string, unknown> | null;
  executed?: boolean;
  error?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  messageId?: string | null;
  createdAt?: Date;
};

export const durabilityDatabaseUrl = safeTestDatabaseUrl();

export async function setupDurabilityFixture(label: string): Promise<DurabilityFixture> {
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const requesterId = randomUUID();
  const otherId = randomUUID();
  const adminId = randomUUID();
  const spaceId = randomUUID();
  const projectId = randomUUID();
  const prefix = `D${label}${suffix.slice(0, 3)}`.toUpperCase().replace(/[^A-Z]/g, 'Q');
  const roles: Record<string, string> = { [requesterId]: 'member', [otherId]: 'member', [adminId]: 'admin' };

  const client = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await client.connect();
  await client.query("INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, $2, $3, 'standard')",
    [orgId, `W2-a2 ${label}`, `w2a2-${label.toLowerCase()}-${suffix}`]);
  for (const id of [requesterId, otherId, adminId]) {
    await client.query(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, $3, 'human', false, true)`,
      [id, `w2a2-${id}@example.test`, `W2a2 ${roles[id]} ${id.slice(0, 4)}`],
    );
    await client.query(
      'INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
      [randomUUID(), orgId, id, roles[id]],
    );
  }
  await client.query(
    "INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)",
    [spaceId, orgId, `w2a2-${label.toLowerCase()}-${suffix}`, requesterId],
  );
  for (const id of [requesterId, adminId]) {
    await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), spaceId, id]);
  }
  await client.query(
    'INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $3, $4, $5)',
    [projectId, orgId, `W2a2 ${label} ${suffix}`, prefix, requesterId],
  );

  const app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-user') ?? requesterId;
    c.set('user', { id, org_id: orgId, email: `${id}@example.test`, role: roles[id] } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes);

  let taskNumber = 0;
  const fixture: DurabilityFixture = {
    client, orgId, requesterId, otherId, adminId, spaceId, projectId, prefix,
    as: (userId, path, init) => app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), 'x-test-user': userId },
    }),
    async insertAction(values) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO agent_actions
           (id, org_id, user_id, agent_employee_id, source, action, params, result,
            approval_tier, approval_status, approved_at, executed_at, error, before_state, after_state,
            message_id, conversation_id, created_at)
         VALUES ($1, $2, $3, NULL, 'mention', $4, $5::jsonb, $6::jsonb, 'full', $7, $8, $9, $10,
                 $11::jsonb, $12::jsonb, $13, $14, $15)`,
        [
          id, orgId, values.userId ?? requesterId, values.action, JSON.stringify(values.params),
          values.result === undefined || values.result === null ? null : JSON.stringify(values.result),
          values.status ?? 'approved',
          (values.status ?? 'approved') === 'approved' ? new Date() : null,
          values.executed === false ? null : new Date(),
          values.error ?? null,
          values.beforeState ? JSON.stringify(values.beforeState) : null,
          values.afterState ? JSON.stringify(values.afterState) : null,
          values.messageId ?? null,
          values.messageId ? spaceId : null,
          values.createdAt ?? new Date(),
        ],
      );
      return id;
    },
    async insertTask(values) {
      const id = randomUUID();
      taskNumber += 1;
      await client.query(
        `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, parent_task_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'p2', $7, $8, $9)`,
        [id, orgId, projectId, 1000 + taskNumber, values.title, values.status ?? 'todo',
          values.assigneeId ?? null, requesterId, values.parentId ?? null],
      );
      return id;
    },
    async insertMessage(content, userId) {
      const id = randomUUID();
      await client.query(
        'INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
        [id, orgId, spaceId, userId ?? requesterId, content],
      );
      return id;
    },
    async teardown() {
      try {
        for (const table of ['action_receipts', 'notifications', 'attention_items', 'agent_action_approvers',
          'job_queue', 'audit_log', 'task_activity', 'wiki_ops_log', 'wiki_links', 'agent_actions']) {
          await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]).catch(() => undefined);
        }
        await client.query('DELETE FROM wiki_page_versions WHERE page_id IN (SELECT id FROM wiki_pages WHERE org_id = $1)', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM wiki_pages WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM task_relationships WHERE source_task_id IN (SELECT id FROM tasks WHERE org_id = $1)', [orgId]).catch(() => undefined);
        await client.query('UPDATE tasks SET parent_task_id = NULL WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM tasks WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM messages WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM projects WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM space_members WHERE space_id = $1', [spaceId]).catch(() => undefined);
        await client.query('DELETE FROM spaces WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => undefined);
        await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[requesterId, otherId, adminId]]).catch(() => undefined);
      } finally {
        await client.end();
        await closeDb();
      }
    },
  };
  return fixture;
}
