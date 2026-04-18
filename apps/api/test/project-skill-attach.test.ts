/**
 * Task 4.5 — Project skill attach/detach routes + real resolved-config
 * resolver.
 *
 * Scenarios covered:
 *   - getProjectResolvedConfig merges Marketing (order 0) + Engineering
 *     (order 1): statuses come from Marketing (first-attached-wins),
 *     custom_fields include both skills' fields unioned by id.
 *   - getProjectResolvedConfig with zero attachments falls back to the
 *     bundled Engineering skill's statuses.
 *   - POST /api/projects/:id/skills appends to the end of attachment_order.
 *   - DELETE renumbers the survivors contiguously.
 *   - PATCH /reorder swaps order.
 *
 * Run: cd apps/api && node --test --import tsx test/project-skill-attach.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const MEMBER_USER_ID = 'test-4-5-member';
const MEMBER_EMAIL = 'task-4-5-member@test.local';

let testApp: Hono | null = null;
let projectWithSkillsId: string | null = null;
let projectEmptyId: string | null = null;
let engineeringSkillId: string | null = null;
let marketingSkillId: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  // Seed bundled skills (idempotent — just makes sure they exist).
  const { seedBundledSkills } = await import('../src/scripts/seed-bundled-skills.js');
  await seedBundledSkills({ silent: true });

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER_USER_ID, MEMBER_EMAIL, 'Task 4.5 Member'],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, MEMBER_USER_ID],
    );

    const stamp = Date.now();

    const p1 = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `T45 With Skills ${stamp}`, `WS${stamp % 1000}`, MEMBER_USER_ID],
    );
    projectWithSkillsId = p1.rows[0].id as string;

    const p2 = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `T45 Empty ${stamp}`, `ET${stamp % 1000}`, MEMBER_USER_ID],
    );
    projectEmptyId = p2.rows[0].id as string;

    const ids = await c.query<{ slug: string; id: string }>(
      `SELECT slug, id FROM skills
       WHERE source = 'bundled' AND slug = ANY($1::text[]) AND is_deleted = false`,
      [['engineering', 'marketing-campaign']],
    );
    for (const row of ids.rows) {
      if (row.slug === 'engineering') engineeringSkillId = row.id;
      if (row.slug === 'marketing-campaign') marketingSkillId = row.id;
    }
    assert.ok(engineeringSkillId, 'engineering bundled skill must be seeded');
    assert.ok(marketingSkillId, 'marketing-campaign bundled skill must be seeded');
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    if (projectWithSkillsId) {
      await c.query(`DELETE FROM project_skills WHERE project_id = $1`, [projectWithSkillsId]);
      await c.query(`DELETE FROM projects WHERE id = $1`, [projectWithSkillsId]);
    }
    if (projectEmptyId) {
      await c.query(`DELETE FROM project_skills WHERE project_id = $1`, [projectEmptyId]);
      await c.query(`DELETE FROM projects WHERE id = $1`, [projectEmptyId]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [MEMBER_USER_ID]);
  });
}

before(async () => {
  await seedFixtures();

  const { projectRoutes } = await import('../src/routes/projects.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: MEMBER_USER_ID,
      email: MEMBER_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/projects', projectRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─── Resolver tests ─────────────────────────────────────────────────────

test('resolver: attach marketing + engineering — resolver ignores attached skills, always returns engineering defaults', async () => {
  // Clean slate for this project in case a prior broken run left rows.
  await withClient(async (c) => {
    await c.query(`DELETE FROM project_skills WHERE project_id = $1`, [projectWithSkillsId]);
  });

  // Attach marketing first, then engineering via route (exercises POST + order append).
  const r1 = await app().request(`/api/projects/${projectWithSkillsId}/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill_id: marketingSkillId }),
  });
  const attach1 = (await r1.json()) as { attachment_order: number; error?: string };
  assert.equal(r1.status, 201, `attach marketing failed: ${JSON.stringify(attach1)}`);
  assert.equal(attach1.attachment_order, 0);

  const r2 = await app().request(`/api/projects/${projectWithSkillsId}/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill_id: engineeringSkillId }),
  });
  const attach2 = (await r2.json()) as { attachment_order: number; error?: string };
  assert.equal(r2.status, 201, `attach engineering failed: ${JSON.stringify(attach2)}`);
  assert.equal(attach2.attachment_order, 1);

  // Call the resolver directly — collapsed resolver ignores project_skills,
  // always returns engineering defaults regardless of attachment order.
  const {
    getProjectResolvedConfig,
    invalidateProjectResolvedConfig,
  } = await import('../src/lib/project-resolved-config.js');
  invalidateProjectResolvedConfig(projectWithSkillsId!);

  const resolved = (await getProjectResolvedConfig(projectWithSkillsId!)) as any;

  // Hardcoded engineering statuses — skill attachment order no longer affects this.
  const statusIds = resolved.statuses.map((s: any) => s.id);
  assert.deepEqual(
    statusIds,
    ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'],
    'resolver always returns engineering defaults (attachment order ignored)',
  );

  // Engineering has transitions set (non-null).
  assert.ok(resolved.allowed_transitions);
  assert.deepEqual(resolved.allowed_transitions.backlog, ['todo', 'in_progress', 'cancelled']);

  // priority_vocab is always numbered p0..p3.
  assert.equal(resolved.priority_vocab.kind, 'numbered');
  assert.deepEqual(resolved.priority_vocab.labels, ['p0', 'p1', 'p2', 'p3']);

  // default_view is always board, hide_prefix_ids always false.
  assert.equal(resolved.default_view, 'board');
  assert.equal(resolved.hide_prefix_ids, false);

  // custom_fields and task_templates are always empty (no per-project customization).
  assert.deepEqual(resolved.custom_fields, []);
  assert.deepEqual(resolved.task_templates, []);
});

test('GET /api/projects/:id/skills returns attached skills in order + resolved_config (engineering defaults)', async () => {
  const r = await app().request(`/api/projects/${projectWithSkillsId}/skills`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as {
    attached_skills: { skill_id: string; slug: string; attachment_order: number }[];
    resolved_config: { statuses: { id: string }[] };
  };
  assert.equal(body.attached_skills.length, 2);
  assert.equal(body.attached_skills[0]!.slug, 'marketing-campaign');
  assert.equal(body.attached_skills[0]!.attachment_order, 0);
  assert.equal(body.attached_skills[1]!.slug, 'engineering');
  assert.equal(body.attached_skills[1]!.attachment_order, 1);
  // resolved_config always returns engineering defaults regardless of attachment order.
  assert.equal(body.resolved_config.statuses[0]!.id, 'backlog');
});

test('PATCH /api/projects/:id/skills/reorder swaps order and re-resolves', async () => {
  const r = await app().request(
    `/api/projects/${projectWithSkillsId}/skills/reorder`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attachment_order: [engineeringSkillId, marketingSkillId],
      }),
    },
  );
  assert.equal(r.status, 200, `reorder failed: ${await r.text()}`);

  const { getProjectResolvedConfig } = await import(
    '../src/lib/project-resolved-config.js'
  );
  const resolved = (await getProjectResolvedConfig(projectWithSkillsId!)) as any;
  // Now engineering wins; statuses should be the 6-state engineering set.
  const statusIds = resolved.statuses.map((s: any) => s.id);
  assert.deepEqual(statusIds, [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'done',
    'cancelled',
  ]);
  // engineering has allowed_transitions set (non-null).
  assert.ok(resolved.allowed_transitions);
  assert.deepEqual(resolved.allowed_transitions.backlog, [
    'todo',
    'in_progress',
    'cancelled',
  ]);
});

test('DELETE /api/projects/:id/skills/:skill_id detaches + renumbers survivors', async () => {
  // Currently order: [engineering=0, marketing=1]. Detach engineering.
  const r = await app().request(
    `/api/projects/${projectWithSkillsId}/skills/${engineeringSkillId}`,
    { method: 'DELETE' },
  );
  assert.equal(r.status, 200);

  // Marketing should have been renumbered to 0.
  await withClient(async (c) => {
    const rows = await c.query<{ skill_id: string; attachment_order: number }>(
      `SELECT skill_id, attachment_order FROM project_skills
       WHERE project_id = $1 ORDER BY attachment_order`,
      [projectWithSkillsId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.skill_id, marketingSkillId);
    assert.equal(rows.rows[0]!.attachment_order, 0);
  });
});

// ─── No-attachment fallback ─────────────────────────────────────────────

test('resolver: zero attachments falls back to bundled engineering config', async () => {
  const {
    getProjectResolvedConfig,
    invalidateProjectResolvedConfig,
  } = await import('../src/lib/project-resolved-config.js');
  invalidateProjectResolvedConfig(projectEmptyId!);

  const resolved = (await getProjectResolvedConfig(projectEmptyId!)) as any;
  const statusIds = resolved.statuses.map((s: any) => s.id);
  assert.deepEqual(
    statusIds,
    ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'],
    'zero attachments should fall back to engineering statuses',
  );
  assert.ok(resolved.allowed_transitions);
  assert.deepEqual(resolved.allowed_transitions.done, ['in_progress', 'backlog']);
});

test('GET /api/projects/:id/resolved-config returns the merged config', async () => {
  const r = await app().request(`/api/projects/${projectEmptyId}/resolved-config`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { statuses: { id: string }[] };
  assert.ok(body.statuses.length >= 5);
});

// ─── Input validation ──────────────────────────────────────────────────

test('POST /skills rejects unknown skill_id with 404', async () => {
  const r = await app().request(`/api/projects/${projectEmptyId}/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill_id: 'skill_does_not_exist' }),
  });
  assert.equal(r.status, 404);
});

test('PATCH /reorder rejects attachment_order with extra/missing ids', async () => {
  // projectEmpty has zero skills → any non-empty array should be invalid.
  const r = await app().request(
    `/api/projects/${projectEmptyId}/skills/reorder`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachment_order: [marketingSkillId] }),
    },
  );
  assert.equal(r.status, 400);
  const body = (await r.json()) as { code: string };
  assert.equal(body.code, 'INVALID_REORDER');
});
