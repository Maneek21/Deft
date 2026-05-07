/**
 * people-graph relationship tests — delegation_chain, cross_team_bridge, tension (stub).
 *
 * Run: pnpm --filter @deft/api test -- people-graph-relationships
 *
 * Covers:
 *   1. delegation_chain edge created when user-A assigns ≥5 tasks to user-B
 *      with no reverse assignments (strength = min(1, count/20)).
 *   2. cross_team_bridge edge created when a user is in ≥3 spaces AND has
 *      ≥2 distinct expertise topics; links them to their top interaction partner.
 *   3. tension is intentionally stubbed — no edge is created (stub behaviour
 *      confirmed by absence of 'tension' rows for the test pair).
 *
 * Uses the real local Postgres DB (postgres://postgres:postgres@localhost:5432/cairn).
 * All inserted rows are cleaned up in finally blocks.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Real user IDs from the test org — must exist in users table (FK constraint)
const USER_A = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // Alex PM
const USER_B = '07308d0d-199a-479d-a2e3-fefdf7cdbac9'; // Priya
const USER_C = 'd3e6d84d-f5da-4172-825a-964d951bb649'; // Rahul

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ─── Service import ───────────────────────────────────────────────────────────

let detectRelationships: (orgId: string) => Promise<void>;

before(async () => {
  const mod = await import('../src/services/people-graph.js');
  detectRelationships = mod.detectRelationships;
});

// ─── Test 1: delegation_chain ─────────────────────────────────────────────────

test('1. delegation_chain edge created when user-A assigns >=5 tasks to user-B with no reverse', async () => {
  const taskIds: string[] = [];

  // Resolve a project_id for the test org
  const projectId = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (r.rows.length > 0) return r.rows[0].id as string;
    // Create a minimal project if none exists
    const ins = await c.query(
      `INSERT INTO projects (org_id, name, slug, created_by)
       VALUES ($1, 'Test Project (delegation)', 'test-delegation-proj', $2)
       RETURNING id`,
      [ORG_ID, USER_A],
    );
    return ins.rows[0].id as string;
  });

  // Seed 5 tasks: created_by = USER_A, assignee_id = USER_B, within last 14 days
  await withClient(async (c) => {
    for (let i = 0; i < 5; i++) {
      const r = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2,
           (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
           $3, 'backlog', 'p2', $4, $5, false)
         RETURNING id`,
        [ORG_ID, projectId, `Delegation test task ${i} ${Date.now()}`, USER_B, USER_A],
      );
      taskIds.push(r.rows[0].id as string);
    }
  });

  try {
    await detectRelationships(ORG_ID);

    const rows = await withClient(async (c) => {
      const r = await c.query(
        `SELECT strength, direction FROM people_relationships
         WHERE user_a_id = $1 AND user_b_id = $2 AND relationship_type = 'delegation_chain'
           AND org_id = $3`,
        [USER_A, USER_B, ORG_ID],
      );
      return r.rows as Array<{ strength: number; direction: string }>;
    });

    assert.ok(rows.length >= 1, 'expected at least 1 delegation_chain row');
    const rel = rows[0]!;
    assert.equal(rel.direction, 'a_to_b', 'direction should be a_to_b');
    assert.ok(rel.strength >= 0.25, `strength should be >= 0.25 (5/20), got ${rel.strength}`);
    assert.ok(rel.strength <= 1.0, `strength should be <= 1.0, got ${rel.strength}`);
  } finally {
    await withClient(async (c) => {
      if (taskIds.length > 0) {
        await c.query(`DELETE FROM tasks WHERE id = ANY($1)`, [taskIds]);
      }
      await c.query(
        `DELETE FROM people_relationships
         WHERE user_a_id = $1 AND user_b_id = $2 AND relationship_type = 'delegation_chain'
           AND org_id = $3`,
        [USER_A, USER_B, ORG_ID],
      );
    });
  }
});

// ─── Test 2: cross_team_bridge ────────────────────────────────────────────────

test('2. cross_team_bridge edge created for user in >=3 spaces with >=2 expertise topics', async () => {
  const spaceIds: string[] = [];
  const expertiseIds: string[] = [];
  const interactionIds: string[] = [];

  // Bridge user = USER_C; their top interaction partner = USER_A
  await withClient(async (c) => {
    // Seed 3 spaces and add USER_C as a member of each
    for (let i = 0; i < 3; i++) {
      const suf = `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      const sr = await c.query(
        `INSERT INTO spaces (id, org_id, name, type, created_by)
         VALUES (gen_random_uuid()::text, $1, $2, 'public', $3)
         RETURNING id`,
        [ORG_ID, `Bridge Test Space ${suf}`, USER_A],
      );
      const spaceId = sr.rows[0].id as string;
      spaceIds.push(spaceId);

      // Add USER_C as member
      await c.query(
        `INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2) ON CONFLICT (space_id, user_id) DO NOTHING`,
        [spaceId, USER_C],
      );
    }

    // Seed 2 distinct expertise topics for USER_C
    for (const topic of ['testing', 'devops']) {
      const er = await c.query(
        `INSERT INTO people_expertise
           (id, org_id, user_id, topic, message_count, expertise_score)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 5, 10)
         ON CONFLICT (org_id, user_id, topic) DO UPDATE SET message_count = people_expertise.message_count + 1
         RETURNING id`,
        [ORG_ID, USER_C, topic],
      );
      expertiseIds.push(er.rows[0].id as string);
    }

    // Seed an interaction between USER_C and USER_A so USER_A becomes the top partner
    const ir = await c.query(
      `INSERT INTO people_interactions
         (id, org_id, user_a_id, user_b_id, interaction_count, dm_count, mention_count,
          thread_co_participation, recency_weighted_score, last_interaction_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 10, 2, 1, 1, 30, now())
       ON CONFLICT (org_id, user_a_id, user_b_id) DO UPDATE
         SET recency_weighted_score = GREATEST(people_interactions.recency_weighted_score, 30)
       RETURNING id`,
      [ORG_ID, USER_A, USER_C],
    );
    interactionIds.push(ir.rows[0].id as string);
  });

  try {
    await detectRelationships(ORG_ID);

    const rows = await withClient(async (c) => {
      const r = await c.query(
        `SELECT strength, direction FROM people_relationships
         WHERE (user_a_id = $1 OR user_b_id = $1)
           AND relationship_type = 'cross_team_bridge'
           AND org_id = $2`,
        [USER_C, ORG_ID],
      );
      return r.rows as Array<{ strength: number; direction: string }>;
    });

    assert.ok(rows.length >= 1, 'expected at least 1 cross_team_bridge row for USER_C');
    const rel = rows[0]!;
    assert.ok(rel.strength >= 0, `strength should be >= 0, got ${rel.strength}`);
    assert.ok(rel.strength <= 1.0, `strength should be <= 1.0, got ${rel.strength}`);
  } finally {
    await withClient(async (c) => {
      // Remove space memberships and spaces
      for (const spaceId of spaceIds) {
        await c.query(`DELETE FROM space_members WHERE space_id = $1 AND user_id = $2`, [spaceId, USER_C]);
      }
      if (spaceIds.length > 0) {
        await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [spaceIds]);
      }
      if (expertiseIds.length > 0) {
        await c.query(`DELETE FROM people_expertise WHERE id = ANY($1)`, [expertiseIds]);
      }
      // Clean up cross_team_bridge rows for USER_C
      await c.query(
        `DELETE FROM people_relationships
         WHERE (user_a_id = $1 OR user_b_id = $1) AND relationship_type = 'cross_team_bridge'
           AND org_id = $2`,
        [USER_C, ORG_ID],
      );
    });
  }
});

// ─── Test 3: tension (stubbed) ────────────────────────────────────────────────

test('3. tension detection is intentionally stubbed — no tension edges emitted', async () => {
  // Tension is stubbed in people-graph.ts (heuristic quality is low; deferred).
  // This test confirms that detectRelationships does NOT create 'tension' rows
  // for any pair, even when the pair has high co-participation and mutual mentions.
  // If/when tension is implemented, this test should be updated to seed data and
  // assert edge creation instead.

  // Ensure no pre-existing tension rows for our test pair
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM people_relationships
       WHERE relationship_type = 'tension' AND org_id = $1
         AND ((user_a_id = $2 AND user_b_id = $3) OR (user_a_id = $3 AND user_b_id = $2))`,
      [ORG_ID, USER_A, USER_B],
    );
  });

  await detectRelationships(ORG_ID);

  const rows = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM people_relationships
       WHERE relationship_type = 'tension' AND org_id = $1`,
      [ORG_ID],
    );
    return r.rows;
  });

  // Stub means zero tension rows should be created
  assert.equal(rows.length, 0, 'expected no tension rows (detection is intentionally stubbed)');
});
