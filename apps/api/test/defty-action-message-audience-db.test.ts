/**
 * Item W2a3-1: the details of a Defty run that are copied into chat message
 * metadata (tool arguments and results in agent_blocks, the action graph,
 * clarification drafts, pending-action params) reach only the action audience:
 * the requester, an assigned approver, and org owners/admins; a guest only for
 * its own request. Every other space member still receives Defty's reply text
 * and a neutral marker of each proposed action (id, action name, tier, status).
 * The rule holds for the message list (all modes), threads, the live socket
 * broadcast and agent conversation reads.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = {
  requester: randomUUID(), peer: randomUUID(), approver: randomUUID(), admin: randomUUID(),
  guestApprover: randomUUID(), guestRequester: randomUUID(), agent: randomUUID(),
};
const roles: Record<string, string> = {
  [ids.requester]: 'member', [ids.peer]: 'member', [ids.approver]: 'member', [ids.admin]: 'admin',
  [ids.guestApprover]: 'guest', [ids.guestRequester]: 'guest', [ids.agent]: 'member',
};
const spaceId = randomUUID();
const conversationId = randomUUID();
const triggerId = randomUUID();
const replyId = randomUUID();
const threadReplyId = randomUUID();
const toolResultId = randomUUID();
const orphanId = randomUUID();
const draftId = randomUUID();
const guestTriggerId = randomUUID();
const guestReplyId = randomUUID();
const actionId = randomUUID();
const guestActionId = randomUUID();
const conversationTriggerId = randomUUID();
const conversationReplyId = randomUUID();
const conversationResultId = randomUUID();
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;

function app(viewerId: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: orgId, email: `${viewerId}@example.test`, role: roles[viewerId] } as any);
    await next();
  });
  return hono;
}
let routes: { messageRoutes: Hono; agentRoutes: Hono } | undefined;
async function request(viewerId: string, path: string) {
  const hono = app(viewerId);
  hono.route('/api/messages', routes!.messageRoutes);
  hono.route('/api/agent', routes!.agentRoutes);
  const response = await hono.request(path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.text();
}

const replyMetadata = (canary: string, triggerMessageId: string) => ({
  is_agent_reply: true,
  reply_to_message_id: triggerMessageId,
  agent_blocks: [
    { type: 'text', text: 'Drafted for approval.' },
    { type: 'tool_use', id: `toolu_${canary.slice(-1).toLowerCase()}`, name: 'create_task', input: { title: `${canary}-TOOL-ARG` } },
  ],
  pending_actions: [{ id: actionId, action: 'create_task', params: { title: `${canary}-PARAMS` }, approval_tier: 'quick', status: 'pending' }],
  action_graph: { summary: 'Drafted for approval.', actions: [{ id: 'n1', tool: 'create_task', params: { title: `${canary}-GRAPH` } }] },
});

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Action audience', `action-audience-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    const agent = name === 'agent';
    await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,$4,$5)', [id, `${id}@example.test`, agent ? 'Defty' : name, agent ? 'agent' : 'human', agent]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'public\',$4)', [spaceId, orgId, `room-${spaceId}`, ids.requester]);
  await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'agent_conversation\',$4)', [conversationId, orgId, 'Conversation', ids.requester]);
  for (const id of Object.values(ids)) await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, id]);
  // The conversation's user added a teammate through the space member route.
  for (const id of [ids.requester, ids.agent, ids.peer]) await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), conversationId, id]);

  const insert = (id: string, space: string, user: string, content: string, metadata: unknown, parent: string | null = null) =>
    client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,metadata,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, orgId, space, user, content, JSON.stringify(metadata ?? {}), parent]);
  await insert(triggerId, spaceId, ids.requester, '@Defty draft the launch task', {});
  await insert(replyId, spaceId, ids.agent, 'Drafted for approval.', replyMetadata('CANARY-A', triggerId));
  await insert(threadReplyId, spaceId, ids.agent, 'Drafted in thread.', replyMetadata('CANARY-T', triggerId), triggerId);
  await insert(toolResultId, spaceId, ids.requester, '', { kind: 'tool_result', hidden: true, agent_blocks: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '{"note":"CANARY-RESULT"}' }] });
  // A reply stored before reply_to_message_id existed: requester unknown.
  await insert(orphanId, spaceId, ids.agent, 'Older reply.', { is_agent_reply: true, agent_blocks: [{ type: 'text', text: 'Older reply.' }, { type: 'tool_use', id: 'toolu_old', name: 'wiki_read', input: { slug: 'CANARY-ORPHAN' } }] });
  await insert(draftId, spaceId, ids.agent, 'Which project?', {
    is_agent_reply: true, reply_to_message_id: triggerId,
    defty_pending: { kind: 'action_draft', request_message_id: triggerId, request_text: 'draft it', question: 'Which project?', created_at: new Date().toISOString(),
      draft: { actions: [{ action: 'create_task', params: { title: 'CANARY-DRAFT' } }] } },
  });
  await insert(guestTriggerId, spaceId, ids.guestRequester, '@Defty note this', {});
  await insert(guestReplyId, spaceId, ids.agent, 'Drafted for approval.', replyMetadata('CANARY-G', guestTriggerId));
  await insert(conversationTriggerId, conversationId, ids.requester, 'Find the launch page', {});
  await insert(conversationReplyId, conversationId, ids.agent, 'Here it is.', { is_agent_reply: true, reply_to_message_id: conversationTriggerId, agent_blocks: [{ type: 'text', text: 'Here it is.' }, { type: 'tool_use', id: 'toolu_conv', name: 'wiki_read', input: { slug: 'CANARY-CONV-ARG' } }], tool_calls: [{ tool: 'wiki_read', params: { slug: 'CANARY-CONV-CALL' } }] });
  await insert(conversationResultId, conversationId, ids.requester, '', { kind: 'tool_result', hidden: true, agent_blocks: [{ type: 'tool_result', tool_use_id: 'toolu_conv', content: 'CANARY-CONV-RESULT' }] });

  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,conversation_id,message_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,$5,'create_task',$6,'quick','pending','mention')`, [actionId, orgId, ids.requester, spaceId, replyId, JSON.stringify({ title: 'CANARY-A-PARAMS' })]);
  await client.query(`INSERT INTO agent_actions(id,org_id,user_id,conversation_id,message_id,action,params,approval_tier,approval_status,source)
    VALUES($1,$2,$3,$4,$5,'create_task',$6,'quick','pending','mention')`, [guestActionId, orgId, ids.guestRequester, spaceId, guestReplyId, JSON.stringify({ title: 'CANARY-G-PARAMS' })]);
  for (const user of [ids.approver, ids.guestApprover]) {
    await client.query('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, actionId, user]);
  }
  const messageModule = await import('../src/routes/messages.js');
  const agentModule = await import('../src/routes/agent.js');
  routes = { messageRoutes: messageModule.messageRoutes, agentRoutes: agentModule.agentRoutes };
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM job_queue WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_action_approvers WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const listPath = `/api/messages/${spaceId}`;
const canaries = (body: string) => [...new Set(body.match(/CANARY-[A-Z]+(?:-[A-Z]+)*/g) ?? [])].sort();

test('W2a3-1: a space member outside the audience receives the reply text and action markers, never run details', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const body = await request(ids.peer, listPath);
  assert.deepEqual(canaries(body), []);
  const parsed = JSON.parse(body) as { messages: Array<{ id: string; content: string; metadata: any }> };
  const reply = parsed.messages.find((message) => message.id === replyId)!;
  assert.equal(reply.content, 'Drafted for approval.');
  assert.deepEqual(reply.metadata.pending_actions, [{ id: actionId, action: 'create_task', approval_tier: 'quick', status: 'pending' }]);
  assert.deepEqual(reply.metadata.agent_blocks, [
    { type: 'text', text: 'Drafted for approval.' },
    { type: 'tool_use', id: 'toolu_a', name: 'create_task' },
  ]);
  assert.equal(reply.metadata.action_graph, undefined);
  const draft = parsed.messages.find((message) => message.id === draftId)!;
  assert.equal(draft.metadata.defty_pending.question, 'Which project?');
  assert.equal(draft.metadata.defty_pending.draft, undefined);
});

test('W2a3-1: the requester keeps every run detail except pending-action params, which no message carries', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(canaries(await request(ids.requester, listPath)), ['CANARY-A-GRAPH', 'CANARY-A-TOOL-ARG', 'CANARY-DRAFT', 'CANARY-RESULT']);
});

test('W2a3-1: an assigned approver sees the details of the reply that anchors the action', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(canaries(await request(ids.approver, listPath)), ['CANARY-A-GRAPH', 'CANARY-A-TOOL-ARG']);
});

test('W2a3-1: owners and admins see every run detail, including replies with no known requester', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(canaries(await request(ids.admin, listPath)), ['CANARY-A-GRAPH', 'CANARY-A-TOOL-ARG', 'CANARY-DRAFT', 'CANARY-G-GRAPH', 'CANARY-G-TOOL-ARG', 'CANARY-ORPHAN', 'CANARY-RESULT']);
});

test('W2a3-1: a guest sees only its own request; an approver assignment opens nothing', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(canaries(await request(ids.guestApprover, listPath)), []);
  assert.deepEqual(canaries(await request(ids.guestRequester, listPath)), ['CANARY-G-GRAPH', 'CANARY-G-TOOL-ARG']);
});

test('W2a3-1: thread and around reads apply the same rule', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.deepEqual(canaries(await request(ids.peer, `/api/messages/${triggerId}/thread`)), []);
  assert.deepEqual(canaries(await request(ids.requester, `/api/messages/${triggerId}/thread`)), ['CANARY-T-GRAPH', 'CANARY-T-TOOL-ARG']);
  assert.deepEqual(canaries(await request(ids.peer, `${listPath}?around=${replyId}`)), []);
  assert.deepEqual(canaries(await request(ids.requester, `${listPath}?around=${replyId}`)), ['CANARY-A-GRAPH', 'CANARY-A-TOOL-ARG', 'CANARY-DRAFT', 'CANARY-RESULT']);
});

test('W2a3-1: agent conversation messages and trace give tool arguments only to the conversation audience', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const path of [`/api/agent/conversations/${conversationId}/messages`, `/api/agent/conversations/${conversationId}/trace.json`]) {
    assert.deepEqual(canaries(await request(ids.peer, path)), [], path);
  }
  assert.deepEqual(canaries(await request(ids.requester, `/api/agent/conversations/${conversationId}/trace.json`)), ['CANARY-CONV-ARG', 'CANARY-CONV-CALL', 'CANARY-CONV-RESULT']);
});

type FakeSocket = { userId: string; rooms: Set<string>; received: Array<{ event: string; data: unknown }> };
function fakeIo(sockets: FakeSocket[]) {
  const deliver = (rooms: string[], excluded: string[], event: string, data: unknown) => {
    for (const socket of sockets) {
      if (!rooms.some((room) => socket.rooms.has(room)) || excluded.some((room) => socket.rooms.has(room))) continue;
      socket.received.push({ event, data: JSON.parse(JSON.stringify(data)) });
    }
  };
  const operator = (rooms: string[], excluded: string[] = []): any => ({
    to: (room: string | string[]) => operator([...rooms, ...([] as string[]).concat(room)], excluded),
    except: (room: string | string[]) => operator(rooms, [...excluded, ...([] as string[]).concat(room)]),
    emit: (event: string, data: unknown) => deliver(rooms, excluded, event, data),
    fetchSockets: async () => sockets.filter((socket) => rooms.some((room) => socket.rooms.has(room))).map((socket) => ({
      rooms: socket.rooms,
      emit: (event: string, data: unknown) => { socket.received.push({ event, data: JSON.parse(JSON.stringify(data)) }); },
    })),
  });
  return { to: (room: string) => operator([room]), in: (room: string) => operator([room]) };
}

test('W2a3-1: the live reply broadcast sends run details only to audience sockets in the space', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const content = '@Defty what changed today?';
  const trigger = randomUUID();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [trigger, orgId, spaceId, ids.requester, content]);
  const socket = (userId: string): FakeSocket => ({ userId, rooms: new Set([`space:${spaceId}`, `org-user:${orgId}:${userId}`, `org:${orgId}`]), received: [] });
  const sockets = [socket(ids.requester), socket(ids.peer), socket(ids.admin), socket(ids.guestApprover)];
  const runQuery = (async () => ({
    text: 'Nothing new.', pendingActions: [], executedActions: [], citations: [], model: 'stub', tokensIn: 0, tokensOut: 0,
    assistantBlocks: [{ type: 'text', text: 'Nothing new.' }, { type: 'tool_use', id: 'toolu_live', name: 'search_messages', input: { query: 'CANARY-SOCKET' } }],
  })) as any;
  await handleAgentReply({ id: randomUUID(), name: 'agent-reply', attempts: 1, data: { orgId, spaceId, messageId: trigger, userId: ids.requester, orgName: 'Action audience', content } } as any,
    { io: fakeIo(sockets), runQuery } as any);
  const delivered = (s: FakeSocket) => s.received.filter((entry) => entry.event === 'message:new');
  for (const s of sockets) assert.equal(delivered(s).length, 1, `one message:new for ${roles[s.userId]} socket`);
  assert.match(JSON.stringify(delivered(sockets[0]!)), /CANARY-SOCKET/);
  assert.match(JSON.stringify(delivered(sockets[2]!)), /CANARY-SOCKET/);
  for (const s of [sockets[1]!, sockets[3]!]) {
    assert.doesNotMatch(JSON.stringify(delivered(s)), /CANARY-SOCKET/);
    assert.equal((delivered(s)[0]!.data as any).content, 'Nothing new.');
  }
});

test('W2a3-1: a new proposal stores only action markers in the message; params stay on the action row', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { persistAgentReplyWithActions } = await import('../src/lib/agent-action-proposals.js');
  const persisted = await persistAgentReplyWithActions({
    orgId, spaceId, userId: ids.requester, agentUserId: ids.agent, content: 'Drafted for approval.',
    metadata: { is_agent_reply: true, reply_to_message_id: triggerId },
    pendingActions: [{ action: 'create_reminder', params: { content: 'CANARY-STORED', remind_at: '2030-01-01T09:00:00Z' }, approval_tier: 'quick', source: 'mention' }],
  });
  const stored = (await client!.query('SELECT metadata FROM messages WHERE id=$1', [persisted.message.id])).rows[0].metadata;
  assert.deepEqual(stored.pending_actions, [{ id: persisted.actions[0]!.id, action: 'create_reminder', approval_tier: 'quick', status: 'pending' }]);
  assert.doesNotMatch(JSON.stringify(persisted.message), /CANARY-STORED/);
  const row = (await client!.query('SELECT params FROM agent_actions WHERE id=$1', [persisted.actions[0]!.id])).rows[0];
  assert.equal(row.params.content, 'CANARY-STORED');
});
