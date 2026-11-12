import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const orgId = randomUUID();
const otherOrgId = randomUUID();
const bob = randomUUID(); // owner, member of the private room
const carol = randomUUID(); // admin, not a member of the private room
const dave = randomUUID(); // admin of another org
const agentUser = randomUUID();
const employeeId = randomUUID();
const roomId = randomUUID();
const hiddenRoomId = randomUUID();
const otherOrgRoomId = randomUUID();
const sourceMessageId = randomUUID();
const hiddenMessageId = randomUUID();
const otherOrgMessageId = randomUUID();
const fileId = randomUUID();

const users: Record<string, { id: string; org_id: string; role: string }> = {
  bob: { id: bob, org_id: orgId, role: 'owner' },
  carol: { id: carol, org_id: orgId, role: 'admin' },
  dave: { id: dave, org_id: otherOrgId, role: 'admin' },
};
let currentUser = users.bob!;
let beforeLease: (() => Promise<void>) | null = null;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function ctx(): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: `source-agent-${suffix}`,
    trust_level: 'autonomous',
  };
}

function body(result: ToolResult): any {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

let app: Hono;
let documentSend: typeof import('../src/lib/mcp-tools/document-send.js').documentSend;
let workspacePlanImport: typeof import('../src/lib/mcp-tools/workspace-plan-import.js').workspacePlanImport;

before(async () => {
  const lease = await import('../src/lib/agent-action-execution-lease.js');
  mock.module(new URL('../src/lib/agent-action-execution-lease.ts', import.meta.url).href, {
    namedExports: {
      ...lease,
      tryWithApprovalLease: async (...args: Parameters<typeof lease.tryWithApprovalLease>) => {
        if (beforeLease) await beforeLease();
        return lease.tryWithApprovalLease(...args);
      },
    },
  });
  ({ documentSend } = await import('../src/lib/mcp-tools/document-send.js'));
  ({ workspacePlanImport } = await import('../src/lib/mcp-tools/workspace-plan-import.js'));
  const { agentRoutes } = await import('../src/routes/agent.js');
  const { inboxRoutes } = await import('../src/routes/inbox.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { ...currentUser, email: `${currentUser.id}@test.local`, sid: 'test-sid' } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes);
  app.route('/api/inbox', inboxRoutes);

  const csv = [
    'Project,Project Prefix,Task,Priority',
    'Source Launch,SRCL,Prepare launch,high',
  ].join('\n');
  await withClient(async (client) => {
    for (const [id, name] of [[orgId, 'source-a'], [otherOrgId, 'source-b']]) {
      await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [id, name, `${name}-${suffix}`]);
    }
    for (const [id, kind] of [[bob, 'human'], [carol, 'human'], [dave, 'human'], [agentUser, 'agent']]) {
      await client.query(
        `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $1 || '@test.local', $1, $2, $3, true)`,
        [id, kind, kind === 'agent'],
      );
    }
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
        (gen_random_uuid()::text, $1, $2, 'owner', true),
        (gen_random_uuid()::text, $1, $3, 'admin', true),
        (gen_random_uuid()::text, $1, $4, 'member', true),
        (gen_random_uuid()::text, $5, $6, 'admin', true)`,
      [orgId, bob, carol, agentUser, otherOrgId, dave],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by) VALUES
        ($1, $2, $1, 'private', $3), ($4, $2, $4, 'private', $3), ($5, $6, $5, 'public', $7)`,
      [roomId, orgId, bob, hiddenRoomId, otherOrgRoomId, otherOrgId, dave],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id) VALUES
        (gen_random_uuid()::text, $1, $2), (gen_random_uuid()::text, $1, $3),
        (gen_random_uuid()::text, $4, $2)`,
      [roomId, bob, agentUser, hiddenRoomId],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES
        ($1, $2, $3, $4, 'Share the report and import the plan'),
        ($5, $2, $6, $4, 'Room the employee cannot read'),
        ($7, $8, $9, $10, 'Other workspace')`,
      [sourceMessageId, orgId, roomId, bob, hiddenMessageId, hiddenRoomId, otherOrgMessageId, otherOrgId, otherOrgRoomId, dave],
    );
    await client.query(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES ($1, $2, $3, 'Source Agent', $4, 'project_manager', 'test', ARRAY[]::text[],
         'autonomous', 50, $5, true, true)`,
      [employeeId, orgId, agentUser, `source-agent-${suffix}`, bob],
    );
    await client.query(
      `INSERT INTO files (
         id, org_id, uploaded_by, filename, mime_type, detected_mime_type, size_bytes, storage_key,
         attachment_kind, processing_status, content_sha256, processed_at
       ) VALUES ($1, $2, $3, 'plan.csv', 'text/csv', 'text/csv', $4, $5, 'spreadsheet', 'ready', $6, now())`,
      [fileId, orgId, bob, Buffer.byteLength(csv), `${randomUUID()}-plan.csv`, `sha256:${'d'.repeat(64)}`],
    );
    await client.query(
      `INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES ($1, $2, $3, 0)`,
      [orgId, sourceMessageId, fileId],
    );
    await client.query(
      `INSERT INTO attachment_derivatives (org_id, file_id, kind, mime_type, content, size_bytes)
       VALUES ($1, $2, 'text', 'text/plain', $3, $4)`,
      [orgId, fileId, csv, Buffer.byteLength(csv)],
    );
  });
});

after(async () => {
  mock.restoreAll();
  await withClient(async (client) => {
    for (const org of [orgId, otherOrgId]) {
      for (const table of [
        'action_receipts', 'agent_action_approvers', 'agent_plans', 'attention_items', 'audit_log', 'task_activity', 'tasks',
        'agent_actions', 'attachment_derivatives', 'message_attachments', 'files', 'messages', 'agent_employees',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
      }
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)', [org]);
      await client.query('DELETE FROM spaces WHERE org_id = $1', [org]);
      await client.query('DELETE FROM projects WHERE org_id = $1', [org]);
      await client.query('DELETE FROM org_members WHERE org_id = $1', [org]);
      await client.query('DELETE FROM orgs WHERE id = $1', [org]);
    }
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[bob, carol, dave, agentUser]]);
  });
});

async function as<T>(name: keyof typeof users, fn: () => Promise<T>): Promise<T> {
  const previous = currentUser;
  currentUser = users[name]!;
  try {
    return await fn();
  } finally {
    currentUser = previous;
  }
}

async function pendingIds(): Promise<string[]> {
  const res = await app.request('/api/agent/actions/pending');
  assert.equal(res.status, 200);
  return ((await res.json()) as { actions: Array<{ id: string }> }).actions.map((row) => row.id);
}

async function inboxApprovalIds(): Promise<string[]> {
  const res = await app.request('/api/inbox?kind=pending_approval');
  assert.equal(res.status, 200);
  const json = (await res.json()) as { items: Array<{ id: string }> };
  return json.items.map((item) => item.id.replace(/^approval:/, ''));
}

async function actionRow(id: string) {
  return withClient(async (client) => (await client.query<{
    message_id: string | null; approval_status: string; executed_at: Date | null;
  }>('SELECT message_id, approval_status, executed_at FROM agent_actions WHERE id = $1', [id])).rows[0]!);
}

async function proposeDocument(key: string): Promise<string> {
  const result = await documentSend({
    caller_employee_slug: ctx().employee_slug,
    source_message_id: sourceMessageId,
    filename: `${key}.md`,
    mime_type: 'text/markdown',
    content: `# ${key}\n\nReady.`,
    idempotency_key: `${key}-${suffix}`,
  }, ctx());
  assert.equal(result.isError, false, result.content[0]?.text);
  return body(result).action_id as string;
}

async function proposePlan(): Promise<string> {
  const result = await workspacePlanImport({
    caller_employee_slug: ctx().employee_slug,
    message_id: sourceMessageId,
    attachment_id: fileId,
  }, ctx());
  assert.equal(result.isError, false, result.content[0]?.text);
  return body(result).action_id as string;
}

test('document-send and plan-import proposals record their source message', async () => {
  const documentId = await proposeDocument('recorded');
  const planId = await proposePlan();
  assert.equal((await actionRow(documentId)).message_id, sourceMessageId);
  assert.equal((await actionRow(planId)).message_id, sourceMessageId);
});

test('a source message the employee cannot read, or from another workspace, is refused at proposal time', async () => {
  for (const id of [hiddenMessageId, otherOrgMessageId, randomUUID()]) {
    const document = await documentSend({
      caller_employee_slug: ctx().employee_slug,
      source_message_id: id,
      filename: 'refused.md',
      mime_type: 'text/markdown',
      content: '# Refused',
    }, ctx());
    assert.equal(document.isError, true);
    const plan = await workspacePlanImport({ caller_employee_slug: ctx().employee_slug, message_id: id }, ctx());
    assert.equal(plan.isError, true);
  }
  const rows = await withClient(async (client) => (await client.query(
    'SELECT count(*)::int AS n FROM agent_actions WHERE message_id = ANY($1::text[])',
    [[hiddenMessageId, otherOrgMessageId]],
  )).rows[0]!.n as number);
  assert.equal(rows, 0);
});

test('an admin outside the source room cannot see, approve or reject; a room member admin can', async () => {
  const documentId = await proposeDocument('audience');
  const planId = await proposePlan();
  // An assigned reviewer outside the room is still refused.
  const assignedId = await proposeDocument('assigned');
  await withClient((client) => client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id) VALUES (gen_random_uuid()::text, $1, $2, $3)`,
    [orgId, assignedId, carol],
  ));

  await as('carol', async () => {
    assert.ok(!(await pendingIds()).includes(assignedId));
    assert.equal((await app.request(`/api/agent/actions/${assignedId}/approve`, { method: 'POST' })).status, 404);
    assert.equal((await app.request(`/api/agent/actions/${assignedId}/reject`, { method: 'POST' })).status, 404);
    const listed = await pendingIds();
    assert.ok(!listed.includes(documentId));
    assert.ok(!listed.includes(planId));
    const inbox = await inboxApprovalIds();
    assert.ok(!inbox.includes(documentId));
    assert.ok(!inbox.includes(planId));
    for (const id of [documentId, planId]) {
      assert.equal((await app.request(`/api/agent/actions/${id}/approve`, { method: 'POST' })).status, 404);
      assert.equal((await app.request(`/api/agent/actions/${id}/reject`, { method: 'POST' })).status, 404);
    }
  });
  await as('dave', async () => {
    for (const id of [documentId, planId]) {
      assert.equal((await app.request(`/api/agent/actions/${id}/approve`, { method: 'POST' })).status, 404);
    }
  });
  assert.equal((await actionRow(documentId)).approval_status, 'pending');
  assert.equal((await actionRow(planId)).approval_status, 'pending');

  await as('bob', async () => {
    const listed = await pendingIds();
    assert.ok(listed.includes(documentId));
    assert.ok(listed.includes(planId));
    assert.ok((await inboxApprovalIds()).includes(documentId));
    const approved = await app.request(`/api/agent/actions/${documentId}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200, await approved.clone().text());
    const rejected = await app.request(`/api/agent/actions/${planId}/reject`, { method: 'POST' });
    assert.equal(rejected.status, 200, await rejected.clone().text());
  });
  const document = await actionRow(documentId);
  assert.equal(document.approval_status, 'approved');
  assert.ok(document.executed_at);
  assert.equal((await actionRow(planId)).approval_status, 'rejected');
});

test('pending rows of these kinds without a recorded source are not reviewable by anyone', async () => {
  const legacyIds: string[] = [];
  await withClient(async (client) => {
    for (const action of ['document_send', 'workspace_plan_import']) {
      const id = randomUUID();
      legacyIds.push(id);
      await client.query(
        `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
         VALUES ($1, $2, $3, $4, 'mcp', $5, $6::jsonb, 'full', 'pending')`,
        [id, orgId, agentUser, employeeId, action, JSON.stringify({ source_message_id: sourceMessageId })],
      );
    }
  });
  for (const name of ['bob', 'carol'] as const) {
    await as(name, async () => {
      const listed = await pendingIds();
      const inbox = await inboxApprovalIds();
      for (const id of legacyIds) {
        assert.ok(!listed.includes(id));
        assert.ok(!inbox.includes(id));
        assert.equal((await app.request(`/api/agent/actions/${id}/approve`, { method: 'POST' })).status, 404);
        assert.equal((await app.request(`/api/agent/actions/${id}/reject`, { method: 'POST' })).status, 404);
      }
    });
  }
  for (const id of legacyIds) assert.equal((await actionRow(id)).approval_status, 'pending');
});

test('approval re-checks the reviewer once the execution lease is held', async () => {
  const documentId = await proposeDocument('recheck');
  beforeLease = async () => {
    await withClient((client) => client.query(
      'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2',
      [roomId, bob],
    ));
  };
  try {
    await as('bob', async () => {
      const res = await app.request(`/api/agent/actions/${documentId}/approve`, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  } finally {
    beforeLease = null;
    await withClient((client) => client.query(
      'INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)',
      [roomId, bob],
    ));
  }
  const row = await actionRow(documentId);
  assert.equal(row.approval_status, 'pending');
  assert.equal(row.executed_at, null);

  // An admin in the room demoted to member between the first read and the
  // lease is refused too (plan imports are reviewed by owners/admins).
  const planId = await proposePlan();
  await withClient((client) => client.query(
    'INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)',
    [roomId, carol],
  ));
  beforeLease = async () => {
    await withClient((client) => client.query(
      `UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`,
      [orgId, carol],
    ));
  };
  try {
    await as('carol', async () => {
      const res = await app.request(`/api/agent/actions/${planId}/approve`, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  } finally {
    beforeLease = null;
    await withClient(async (client) => {
      await client.query(`UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, carol]);
      await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [roomId, carol]);
    });
  }
  assert.equal((await actionRow(planId)).approval_status, 'pending');
});

test('room cards follow the source audience, and approval adds no extra confirmation message', async () => {
  const documentId = await proposeDocument('room-card');
  const roomCards = async () => {
    const res = await app.request(`/api/agent/actions/pending-by-space?space_id=${roomId}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as Array<{ id: string }>).map((row) => row.id);
  };
  await as('bob', async () => {
    assert.ok((await roomCards()).includes(documentId));
  });
  await withClient((client) => client.query(
    'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [roomId, agentUser],
  ));
  try {
    await as('bob', async () => {
      assert.ok(!(await roomCards()).includes(documentId));
      assert.ok(!(await pendingIds()).includes(documentId));
    });
  } finally {
    await withClient((client) => client.query(
      'INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)', [roomId, agentUser],
    ));
  }
  const before = await withClient(async (client) => (await client.query(
    'SELECT count(*)::int AS n FROM messages WHERE space_id = $1', [roomId],
  )).rows[0]!.n as number);
  await as('bob', async () => {
    const res = await app.request(`/api/agent/actions/${documentId}/approve`, { method: 'POST' });
    assert.equal(res.status, 200, await res.clone().text());
  });
  const afterCount = await withClient(async (client) => (await client.query(
    'SELECT count(*)::int AS n FROM messages WHERE space_id = $1', [roomId],
  )).rows[0]!.n as number);
  assert.equal(afterCount, before + 1, 'only the delivered document message is posted');
});

test('retrying a proposal whose pending row has no recorded source creates a reviewable row', async () => {
  const key = `legacy-retry-${suffix}`;
  const legacyId = randomUUID();
  await withClient((client) => client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'document_send', $5::jsonb, 'full', 'pending')`,
    [legacyId, orgId, agentUser, employeeId, JSON.stringify({ idempotency_key: key, source_message_id: sourceMessageId })],
  ));
  const result = await documentSend({
    caller_employee_slug: ctx().employee_slug,
    source_message_id: sourceMessageId,
    filename: 'legacy-retry.md',
    mime_type: 'text/markdown',
    content: '# Retry',
    idempotency_key: key,
  }, ctx());
  assert.equal(result.isError, false, result.content[0]?.text);
  const retried = body(result);
  assert.notEqual(retried.action_id, legacyId);
  assert.equal(retried.idempotent, false);
  assert.equal((await actionRow(retried.action_id)).message_id, sourceMessageId);
});

test('an employee-bound plan does not queue document sends or plan imports as plan steps', async () => {
  const { createPlanRow, executePlan } = await import('../src/lib/agent-plans.js');
  const { plan_id } = await createPlanRow({
    org_id: orgId,
    user_id: bob,
    agent_employee_id: employeeId,
    conversation_id: null,
    title: 'Plan step document',
    description: null,
    steps: [{
      id: 'send',
      description: 'Send a document',
      tool: 'document_send',
      params: { source_message_id: sourceMessageId, filename: 'plan.md', mime_type: 'text/markdown', content: '# Plan' },
    }],
  } as any);
  await withClient((client) => client.query(`UPDATE agent_plans SET status = 'approved' WHERE id = $1`, [plan_id]));
  await executePlan(plan_id, orgId, bob).catch(() => undefined);
  const queued = await withClient(async (client) => (await client.query(
    `SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1 AND source = 'plan'`, [orgId],
  )).rows[0]!.n as number);
  assert.equal(queued, 0);
  await withClient((client) => client.query('DELETE FROM agent_plans WHERE id = $1', [plan_id]));
});
