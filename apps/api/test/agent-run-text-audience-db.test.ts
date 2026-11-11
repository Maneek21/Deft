/**
 * Lane W2a4: free text produced by an agent run (summaries, outcome details,
 * error strings, last-error fields) and references taken from a reply's
 * audience-only metadata reach only the audience of the run's source.
 * Owners/admins keep full diagnostics; everyone else who may see the
 * surface receives a neutral entry or status.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = { admin: randomUUID(), insider: randomUUID(), peer: randomUUID(), guest: randomUUID(), agent: randomUUID(), defty: randomUUID() };
const roles: Record<string, 'owner' | 'admin' | 'member' | 'guest'> = {
  [ids.admin]: 'admin', [ids.insider]: 'member', [ids.peer]: 'member', [ids.guest]: 'guest', [ids.agent]: 'member', [ids.defty]: 'member',
};
const employeeId = randomUUID();
const privateSpace = randomUUID();
const publicSpace = randomUUID();
const projectId = randomUUID();
const taskId = randomUUID();
const sourceMessageId = randomUUID();
const messageEventId = randomUUID();
const taskEventId = randomUUID();
const looseEventId = randomUUID();
const turnId = randomUUID();
const claimToken = `claim-${randomUUID()}`;
const bearer = `deft-channel-w2a4-${randomUUID()}`;
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let employeeRoutes: Hono | undefined;
let channelRoutes: Hono | undefined;

async function asViewer(viewerId: string, path: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: orgId, email: `${viewerId}@example.test`, role: roles[viewerId] } as any);
    await next();
  });
  hono.route('/api/agent-employees', employeeRoutes!);
  return hono.request(`/api/agent-employees${path}`);
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Run text audience', `run-text-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    const agent = name === 'agent' || name === 'defty';
    await q('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,$4,$5)', [id, `${id}@example.test`, name, agent ? 'agent' : 'human', agent]);
    await q('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,is_byoa,runtime_kind,wake_mode,created_by)
    VALUES($1,$2,$3,'Runner',$4,'custom','test','standard',true,'hermes','external_chat',$5)`, [employeeId, orgId, ids.agent, `runner-${employeeId.slice(0, 8)}`, ids.peer]);
  await q('UPDATE users SET agent_employee_id=$1 WHERE id=$2', [employeeId, ids.agent]);
  await q(`INSERT INTO agent_channel_tokens(id,org_id,agent_employee_id,name,token_hash,token_prefix,created_by)
    VALUES($1,$2,$3,'w2a4',$4,$5,$6)`, [randomUUID(), orgId, employeeId, await bcrypt.hash(bearer, 4), bearer.slice(0, 18), ids.admin]);
  await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'private\',$4)', [privateSpace, orgId, `private-${privateSpace}`, ids.insider]);
  await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'public\',$4)', [publicSpace, orgId, `public-${publicSpace}`, ids.insider]);
  for (const user of [ids.insider, ids.agent]) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), privateSpace, user]);
  await q('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [sourceMessageId, orgId, privateSpace, ids.insider, 'please look into this']);
  await q('INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,$3,$4)', [projectId, orgId, 'Run text', `RT${orgId.slice(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X')}`]);
  await q(`INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,metadata)
    VALUES($1,$2,$3,1,'Restricted work','in_progress',$4,$5,'{"visibility":"restricted"}')`, [taskId, orgId, projectId, ids.agent, ids.insider]);
  await q(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,space_id,idempotency_key,status,
      work_outcome,outcome_detail,error,completed_at,outcome_at)
    VALUES($1,$2,$3,'message.created','message',$4,$5,$6,'completed','needs_human','CANARY-EVENT-DETAIL','CANARY-EVENT-ERROR',now(),now())`,
  [messageEventId, orgId, employeeId, sourceMessageId, privateSpace, `w2a4:${messageEventId}`]);
  await q(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,source_kind,source_id,idempotency_key,status,
      claim_owner,claim_token,claimed_at,lease_expires_at,delivered_at,acked_at)
    VALUES($1,$2,$3,'task.assigned','task',$4,$5,'acknowledged','w2a4-worker',$6,now(),now() + interval '10 minutes',now(),now())`,
  [taskEventId, orgId, employeeId, taskId, `w2a4:${taskEventId}`, claimToken]);
  await q(`INSERT INTO agent_channel_events(id,org_id,agent_employee_id,kind,idempotency_key,status,outcome_detail,error,failed_at)
    VALUES($1,$2,$3,'trigger.fired',$4,'failed','CANARY-LOOSE-DETAIL','CANARY-LOOSE-ERROR',now())`, [looseEventId, orgId, employeeId, `w2a4:${looseEventId}`]);
  await q(`INSERT INTO agent_mcp_call_audit(id,org_id,employee_id,tool_name,success,error) VALUES($1,$2,$3,'task_update',false,'CANARY-CALL')`, [randomUUID(), orgId, employeeId]);
  await q(`INSERT INTO agent_session_turns(id,org_id,employee_id,trigger_kind,triggering_message_id,space_id,input_messages_json,latency_ms,result,error)
    VALUES($1,$2,$3,'mention',$4,$5,'[]',12,'error','CANARY-TURN')`, [turnId, orgId, employeeId, sourceMessageId, privateSpace]);
  await q(`INSERT INTO agent_cooperative_log(id,org_id,employee_id,kind,summary,session_turn_id) VALUES($1,$2,$3,'outcome','CANARY-COOP-TURN',$4)`, [randomUUID(), orgId, employeeId, turnId]);
  await q(`INSERT INTO agent_cooperative_log(id,org_id,employee_id,kind,summary) VALUES($1,$2,$3,'milestone','CANARY-COOP-LOOSE')`, [randomUUID(), orgId, employeeId]);
  await q(`INSERT INTO agent_channel_connections(id,org_id,agent_employee_id,runtime_kind,status,last_error) VALUES($1,$2,$3,'hermes','degraded','CANARY-CONNECTION')`, [randomUUID(), orgId, employeeId]);
  employeeRoutes = (await import('../src/routes/agent-employees.js')).agentEmployeeRoutes;
  channelRoutes = (await import('../src/routes/agent-channel.js')).agentChannelRoutes;
  seeded = true;
});

after(async () => {
  await realtime?.close();
  if (seeded && client) {
    for (const table of ['agent_channel_delivery_attempts', 'agent_channel_cursors', 'agent_channel_connections', 'agent_channel_tokens', 'agent_cooperative_log',
      'agent_session_turns', 'agent_mcp_call_audit', 'agent_channel_events', 'agent_actions', 'task_activity', 'tasks', 'projects']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await client.query('UPDATE users SET agent_employee_id=NULL WHERE id=$1', [ids.agent]);
    await client.query('DELETE FROM agent_employees WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const canaries = (body: string) => [...new Set(body.match(/CANARY-[A-Z-]+/g) ?? [])].sort();

// ── A. Employee activity feed ────────────────────────────────────────────
test('W2a4-A: activity text goes to the audience of each entry\'s source; others get neutral entries', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const read = async (viewer: string) => {
    const response = await asViewer(viewer, `/${employeeId}/activity`);
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as Array<{ id: string; kind: string; status: string; error: string | null; detail: string | null }>;
  };
  const admin = await read(ids.admin);
  assert.deepEqual(canaries(JSON.stringify(admin)), [
    'CANARY-CALL', 'CANARY-COOP-LOOSE', 'CANARY-COOP-TURN', 'CANARY-EVENT-DETAIL', 'CANARY-EVENT-ERROR',
    'CANARY-LOOSE-DETAIL', 'CANARY-LOOSE-ERROR', 'CANARY-TURN',
  ], 'owners/admins keep every diagnostic');
  const insider = await read(ids.insider);
  assert.deepEqual(canaries(JSON.stringify(insider)), ['CANARY-COOP-TURN', 'CANARY-EVENT-DETAIL', 'CANARY-EVENT-ERROR', 'CANARY-TURN'],
    'a reader of the source receives the text of entries from that source only');
  for (const viewer of [ids.peer, ids.guest]) {
    const entries = await read(viewer);
    assert.deepEqual(canaries(JSON.stringify(entries)), [], `${roles[viewer]} outside the source receives no run text`);
    // The feed is not narrower: the same entries, with kind, time and status.
    assert.deepEqual(entries.map((entry) => `${entry.id}:${entry.kind}:${entry.status}`).sort(),
      admin.map((entry) => `${entry.id}:${entry.kind}:${entry.status}`).sort());
  }
});

// ── B. Org-wide diagnostics ──────────────────────────────────────────────
test('W2a4-B1: employee statistics return the channel error text to owners/admins only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const read = async (viewer: string) => {
    const response = await asViewer(viewer, '?expand=stats');
    assert.equal(response.status, 200, await response.clone().text());
    const rows = await response.json() as Array<Record<string, unknown>>;
    return rows.find((row) => row.id === employeeId)!;
  };
  const admin = await read(ids.admin);
  assert.equal(admin.channel_last_error, 'CANARY-CONNECTION');
  for (const viewer of [ids.insider, ids.peer, ids.guest]) {
    const row = await read(viewer);
    assert.deepEqual(canaries(JSON.stringify(row)), []);
    assert.equal(row.channel_status, 'degraded', 'the neutral status stays');
    assert.equal(row.channel_has_error, true);
  }
});

let realtime: Awaited<ReturnType<typeof startRealtime>> | undefined;
async function startRealtime() {
  const { createServer } = await import('node:http');
  const { createRequire } = await import('node:module');
  const { setupSocket } = await import('../src/socket.js');
  const { io: connect } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');
  const server = createServer();
  const io = setupSocket(server, {
    verifyAccess: async (token: string) => ({ id: token, org_id: orgId, email: `${token}@example.test`, sid: `sid-${token}`, exp: Math.floor(Date.now() / 1000) + 600 }) as any,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const open = async (userId: string) => {
    const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: userId }, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    const events: Array<{ event: string; data: any }> = [];
    socket.onAny((event: string, data: unknown) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket init timed out')), 5_000);
      socket.once('presence:init', () => { clearTimeout(timer); resolve(); });
    });
    return events;
  };
  return {
    open,
    close: async () => { for (const socket of clients) socket.close(); await new Promise<void>((resolve) => io.close(() => resolve())); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

test('W2a4-B2: agent presence goes out org-wide with neutral status and no error text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  realtime ??= await startRealtime();
  const viewers = { admin: await realtime.open(ids.admin), peer: await realtime.open(ids.peer), guest: await realtime.open(ids.guest) };
  const { touchAgentChannelConnection, getAgentChannelPrincipal } = await import('../src/lib/agent-channel.js');
  const principal = await getAgentChannelPrincipal(employeeId, orgId);
  await touchAgentChannelConnection(principal!, { status: 'degraded', lastError: 'CANARY-PRESENCE' });
  await settle();
  for (const [name, events] of Object.entries(viewers)) {
    const presence = events.filter((entry) => entry.event === 'agent:presence' && entry.data?.employee_id === employeeId);
    assert.equal(presence.length, 1, `${name} receives the presence update`);
    assert.equal(presence[0]!.data.status, 'degraded');
    assert.equal(presence[0]!.data.has_error, true);
    assert.deepEqual(canaries(JSON.stringify(presence)), [], `${name} receives no error text over the org room`);
  }
});

test('W2a4-B3: task progress text goes only to the task source audience; the org gets a neutral update', async (t) => {
  if (unavailable) return t.skip(unavailable);
  realtime ??= await startRealtime();
  const viewers = { admin: await realtime.open(ids.admin), insider: await realtime.open(ids.insider), peer: await realtime.open(ids.peer) };
  await client!.query('INSERT INTO task_watchers(id,task_id,user_id) VALUES($1,$2,$3)', [randomUUID(), taskId, ids.insider]);
  const hono = new Hono();
  hono.route('/api/agent-channel/v1', channelRoutes!);
  const response = await hono.request('/api/agent-channel/v1/status', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: taskEventId, state: 'working', claim_token: claimToken, detail: 'CANARY-PROGRESS' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  await settle();
  const progress = (events: Array<{ event: string; data: any }>) => events.filter((entry) => entry.event === 'task:agent_progress' && entry.data?.task_id === taskId);
  for (const [name, events] of Object.entries(viewers)) assert.equal(progress(events).length, 1, `${name} receives one progress update`);
  assert.deepEqual(canaries(JSON.stringify(progress(viewers.peer))), [], 'a member who cannot read the task receives no progress text');
  assert.equal(progress(viewers.peer)[0]!.data.status, 'started');
  assert.deepEqual(canaries(JSON.stringify(progress(viewers.insider))), ['CANARY-PROGRESS']);
  assert.deepEqual(canaries(JSON.stringify(progress(viewers.admin))), ['CANARY-PROGRESS']);
});

// ── C. References taken from earlier replies ────────────────────────────
test('W2a4-C: references from an earlier reply\'s audience-only citations reach only that reply\'s audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { collectRecentAgentTaskReferences, buildReferentialStatusUpdateFallback } = await import('../src/workers/handlers/agent-reply.js');
  const base = Date.now() - 60_000;
  const at = (offset: number) => new Date(base + offset * 1000).toISOString();
  const aliceAsk = randomUUID();
  const reply = randomUUID();
  const visibleReply = randomUUID();
  const aliceNext = randomUUID();
  const bobNext = randomUUID();
  const insert = (id: string, user: string, content: string, created: string, metadata: unknown = {}) => client!.query(
    'INSERT INTO messages(id,org_id,space_id,user_id,content,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, orgId, publicSpace, user, content, JSON.stringify(metadata), created]);
  await insert(aliceAsk, ids.insider, 'what am I working on?', at(1));
  await insert(reply, ids.defty, 'You have one item in flight.', at(2), {
    is_agent_reply: true, reply_to_message_id: aliceAsk, citations: [{ type: 'task', id: 'hidden-task', title: 'SECRET-12 private plan' }],
  });
  await insert(aliceNext, ids.insider, 'mark it as done', at(3));
  await insert(bobNext, ids.peer, 'mark it as done', at(4));
  const options = (messageId: string, requesterId: string) => ({
    orgId, spaceId: publicSpace, agentUserId: ids.defty, messageId, parentId: null, requesterId,
  });
  assert.deepEqual(await collectRecentAgentTaskReferences({ ...options(aliceNext, ids.insider), promptContent: 'mark it as done' }), ['SECRET-12'],
    'the requester continuing their own conversation keeps the reference');
  assert.deepEqual(await collectRecentAgentTaskReferences({ ...options(bobNext, ids.peer), promptContent: 'mark it as done' }), [],
    'another member\'s compiler prompt receives no reference from audience-only citations');
  const fallback = async (messageId: string, requesterId: string) => JSON.stringify(await buildReferentialStatusUpdateFallback({ ...options(messageId, requesterId), content: 'mark it as done' }));
  assert.match(await fallback(aliceNext, ids.insider), /SECRET-12/);
  assert.doesNotMatch(await fallback(bobNext, ids.peer), /SECRET-12/);
  // A reference in the shared, visible body still serves everyone.
  await insert(visibleReply, ids.defty, 'Updated SHARED-7 for you.', at(5), {
    is_agent_reply: true, reply_to_message_id: aliceAsk, citations: [{ type: 'task', id: 'hidden-task', title: 'SECRET-12 private plan' }],
  });
  const bobLater = randomUUID();
  await insert(bobLater, ids.peer, 'mark it as done', at(6));
  assert.deepEqual(await collectRecentAgentTaskReferences({ ...options(bobLater, ids.peer), promptContent: 'mark it as done' }), ['SHARED-7']);
});

// ── E. Result markers fail closed ───────────────────────────────────────
test('W2a4-E: a run row with malformed or conflicting result markers gives details to owners/admins only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { agentRunDetailAudience } = await import('../src/lib/agent-message-run-details.js');
  const ownAction = randomUUID();
  const otherAction = randomUUID();
  for (const [id, user] of [[ownAction, ids.insider], [otherAction, ids.peer]] as const) {
    await client!.query(`INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source)
      VALUES($1,$2,$3,'create_task','{}','quick','approved','mention')`, [id, orgId, user]);
  }
  const row = (metadata: Record<string, unknown>) => ({
    id: randomUUID(), user_id: ids.insider, space_id: publicSpace,
    metadata: { is_agent_reply: true, citations: [{ type: 'task', id: 'x' }], ...metadata },
  });
  const consistent = row({ approval_execution_result_for_action_id: ownAction, agent_action_id: ownAction });
  const conflicting = row({ approval_execution_result_for_action_id: ownAction, agent_action_id: otherAction });
  const malformed = row({ approval_rejection_result_for_action_id: 42 });
  const blankThenValid = row({ approval_execution_result_for_action_id: '', agent_action_id: ownAction });
  const rows = [consistent, conflicting, malformed, blankThenValid];
  const insider = await agentRunDetailAudience({ id: ids.insider, org_id: orgId, role: 'member' }, rows);
  assert.equal(insider.has(consistent.id), true, 'consistent markers keep the action audience');
  assert.equal(insider.has(conflicting.id), false, 'conflicting markers resolve to no action');
  assert.equal(insider.has(malformed.id), false, 'a malformed marker does not fall through to authorship');
  assert.equal(insider.has(blankThenValid.id), false, 'a malformed marker beside a valid one resolves to no action');
  const admin = await agentRunDetailAudience({ id: ids.admin, org_id: orgId, role: 'admin' }, rows);
  for (const entry of rows) assert.equal(admin.has(entry.id), true);
});
