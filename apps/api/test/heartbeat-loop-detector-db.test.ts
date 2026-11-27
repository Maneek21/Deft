/**
 * The heartbeat loop detector (CLAUDE.md, Phase 8 Task 8.6): five identical
 * task titles or message texts in a row trip the employee's circuit breaker.
 * RC13B on 157: it never tripped, because the heartbeat queued its own
 * `heartbeat_tick` row first and the detector read that row as "not a write",
 * and an MCP `send_message` (the Phase 3 tool) was not counted either. The
 * detector now reads only the employee's writes, and runs before the tick is
 * queued, so a looping employee gets no new tick.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { handleAgentEmployeeHeartbeat } from '../src/workers/handlers/agent-employee-heartbeat.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const run = randomUUID().replace(/-/g, '').slice(0, 8);
const org = randomUUID();
const owner = randomUUID();
let client: pg.Client | undefined;
let unavailable: string | undefined;
let ready = false;
const employees: string[] = [];
const agentUsers: string[] = [];

async function q(text: string, values: unknown[] = []) {
  return client!.query(text, values);
}

before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [org, 'Loop Org', `loop-${run}`]);
  await q(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, 'Loop Owner', 'human', false)`, [owner, `owner-${run}@loop.test`]);
  await q(`INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, 'owner')`, [org, owner]);
  ready = true;
});

after(async () => {
  if (ready && client) {
    await q('DELETE FROM agent_heartbeat_turns WHERE org_id = $1', [org]);
    await q('DELETE FROM agent_actions WHERE org_id = $1', [org]);
    await q('DELETE FROM agent_employees WHERE org_id = $1', [org]);
    await q('DELETE FROM org_members WHERE org_id = $1', [org]);
    await q('DELETE FROM orgs WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[owner, ...agentUsers]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

/** A due, healthy employee with heartbeats on. */
async function employee(): Promise<{ id: string; userId: string }> {
  const id = randomUUID(), userId = randomUUID();
  await q(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, 'Loop Agent', 'agent', true)`, [userId, `agent-${id}@loop.test`]);
  await q(`INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, 'member')`, [org, userId]);
  await q(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, max_daily_actions,
      daily_action_count, created_by, is_active, is_deleted, heartbeat_enabled, heartbeat_interval_min, last_heartbeat_at)
    VALUES ($1, $2, $3, 'Loop Agent', $4, 'custom', 'test', 'standard', 500, 0, $5, true, false, true, 15, null)`,
  [id, org, userId, `loop-${id.slice(0, 8)}`, owner]);
  employees.push(id); agentUsers.push(userId);
  return { id, userId };
}

/** Records `action` with `params` for the employee, `secondsAgo` seconds ago. */
async function action(emp: { id: string; userId: string }, kind: string, params: Record<string, unknown>, secondsAgo: number) {
  await q(`INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status, created_at)
    VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', $4, $5::jsonb, 'auto', 'approved', now() - ($6 || ' seconds')::interval)`,
  [org, emp.userId, emp.id, kind, JSON.stringify(params), String(secondsAgo)]);
}

async function state(id: string) {
  const [row] = (await q('SELECT unhealthy, unhealthy_reason FROM agent_employees WHERE id = $1', [id])).rows;
  const ticks = Number((await q(`SELECT count(*)::int AS n FROM agent_actions WHERE agent_employee_id = $1 AND action = 'heartbeat_tick'`, [id])).rows[0].n);
  const turns = (await q('SELECT outcome FROM agent_heartbeat_turns WHERE agent_employee_id = $1 ORDER BY fired_at DESC', [id])).rows.map((r) => r.outcome);
  return { unhealthy: row.unhealthy as boolean, reason: row.unhealthy_reason as string | null, ticks, turns };
}

describe('heartbeat loop detector', { skip: !url }, () => {
  test('five identical messages trip the breaker even after a heartbeat tick, and no new tick is queued', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const emp = await employee();
    for (let i = 0; i < 5; i += 1) await action(emp, 'message_post', { content: 'Standup reminder' }, 600 - i);
    // The previous heartbeat's tick is newer than every write: it used to hide the loop.
    await action(emp, 'heartbeat_tick', { heartbeat_prompt: 'x' }, 60);
    await handleAgentEmployeeHeartbeat({} as any);
    const after = await state(emp.id);
    assert.equal(after.unhealthy, true, 'the breaker trips');
    assert.match(after.reason ?? '', /loop detected/);
    assert.equal(after.ticks, 1, 'no new tick is queued for a looping employee');
  });

  test('five identical send_message texts trip the breaker too', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const emp = await employee();
    for (let i = 0; i < 5; i += 1) await action(emp, 'send_message', { target: { space_id: 'x' }, content: 'Same text' }, 600 - i);
    await action(emp, 'chat_mention', { message_id: 'm' }, 30);
    await handleAgentEmployeeHeartbeat({} as any);
    const after = await state(emp.id);
    assert.equal(after.unhealthy, true);
    assert.equal(after.ticks, 0);
  });

  test('five identical task titles trip the breaker', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const emp = await employee();
    for (let i = 0; i < 5; i += 1) await action(emp, 'task_create', { title: 'Follow up' }, 600 - i);
    await handleAgentEmployeeHeartbeat({} as any);
    assert.equal((await state(emp.id)).unhealthy, true);
  });

  test('different writes do not trip it, and the tick is queued', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const emp = await employee();
    for (let i = 0; i < 5; i += 1) await action(emp, 'message_post', { content: `Update ${i}` }, 600 - i);
    await action(emp, 'heartbeat_tick', { heartbeat_prompt: 'x' }, 60);
    await handleAgentEmployeeHeartbeat({} as any);
    const after = await state(emp.id);
    assert.equal(after.unhealthy, false);
    assert.equal(after.ticks, 2, 'the new tick is queued');
    assert.equal(after.turns[0], 'queued');
  });

  test('after an owner clears the breaker, the old loop does not trip it again; a new one does', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const emp = await employee();
    for (let i = 0; i < 5; i += 1) await action(emp, 'message_post', { content: 'Same text' }, 600 - i);
    await handleAgentEmployeeHeartbeat({} as any);
    assert.equal((await state(emp.id)).unhealthy, true, 'tripped');
    // An owner clears it (PATCH /api/agent-employees/:id { mark_healthy: true }), and the next tick is due.
    await q('UPDATE agent_employees SET unhealthy = false, unhealthy_reason = null, last_heartbeat_at = null WHERE id = $1', [emp.id]);
    await handleAgentEmployeeHeartbeat({} as any);
    const recovered = await state(emp.id);
    assert.equal(recovered.unhealthy, false, 'the writes before the trip are not counted again');
    assert.equal(recovered.ticks, 1, 'the recovered employee gets its tick');
    // Five new identical writes after recovery trip it again.
    for (let i = 0; i < 5; i += 1) await action(emp, 'message_post', { content: 'Again' }, -1 - i);
    await q('UPDATE agent_employees SET last_heartbeat_at = null WHERE id = $1', [emp.id]);
    await handleAgentEmployeeHeartbeat({} as any);
    assert.equal((await state(emp.id)).unhealthy, true, 'a new loop trips it');
  });

  test('fewer than five writes never trip it, whatever else the employee queued', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const emp = await employee();
    for (let i = 0; i < 4; i += 1) await action(emp, 'message_post', { content: 'Same' }, 600 - i);
    for (let i = 0; i < 3; i += 1) await action(emp, 'heartbeat_tick', { heartbeat_prompt: 'x' }, 300 - i);
    await handleAgentEmployeeHeartbeat({} as any);
    assert.equal((await state(emp.id)).unhealthy, false);
  });
});
