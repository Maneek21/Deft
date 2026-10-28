import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import { normalizeCompiledToolCalls } from '../src/lib/agent-action-proposals.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID(), ownerId = randomUUID(), rahulId = randomUUID();
let client: pg.Client | undefined;
let unavailable: string | undefined;
let ready = false;
const suffix = randomUUID();
const result = (text: string, pendingActions: any[] = []) => ({ text, pendingActions, executedActions: [], citations: [], assistantBlocks: [], model: 'stub', tokensIn: 0, tokensOut: 0 });

before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Lane U worker', `lane-u-${suffix}`]);
  for (const [id, name] of [[ownerId, 'Priya Shah'], [rahulId, 'Rahul Mehta']]) {
    await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,\'human\',false)', [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'owner\')', [randomUUID(), orgId, id]);
  }
  for (const [name, prefix] of [['Deft v1','DEFT'],['Deft v2','NEXT']]) {
    await client.query('INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(),orgId,name,prefix,ownerId]);
  }
  ready = true;
});

after(async () => {
  if (ready && client) {
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM projects WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[ownerId,rahulId]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

async function space() {
  const id = randomUUID();
  await client!.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'public\',$4)', [id,orgId,`room-${id}`,ownerId]);
  for (const userId of [ownerId,rahulId]) await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(),id,userId]);
  return id;
}
async function message(spaceId: string, userId: string, content: string, time: Date, parentId: string | null = null) {
  const id = randomUUID();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content,created_at,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,orgId,spaceId,userId,content,time,parentId]);
  return id;
}
function job(spaceId: string, messageId: string, content: string, parentId?: string) {
  return { id: randomUUID(), name: 'agent-reply', attempts: 1, data: { orgId, spaceId, messageId, parentId, userId: ownerId, orgName: 'Lane U worker', content } };
}

test('room context pack includes preceding channel discussion in the runner input for a fresh top-level mention', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const now = Date.now();
  const bodies = Array.from({length:5}, (_,i) => `Discussion point ${i}`);
  const sourceIds: string[] = [];
  for (const [i,body] of bodies.entries()) sourceIds.push(await message(spaceId,rahulId,body,new Date(now - 10000 + i * 100)));
  const content = '@Defty catch me up on this channel';
  const triggerId = await message(spaceId,ownerId,content,new Date(now - 1000));
  await message(spaceId,rahulId,'AFTER_TRIGGER',new Date(now));
  let captured: any;
  await handleAgentReply(job(spaceId,triggerId,content), { runQuery: (async (input: any) => { captured=input; return result('Here is the discussion.'); }) as any });
  const context = captured.untrustedContextSections.join('\n');
  let previous = -1;
  for (const body of bodies) { const index=context.indexOf(body); assert.ok(index>previous); previous=index; }
  assert.match(context,/Rahul Mehta/);
  assert.doesNotMatch(context,/AFTER_TRIGGER/);
  const storedReply = (await client!.query('SELECT metadata FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3)', [spaceId, ownerId, rahulId])).rows[0];
  for (const id of sourceIds) assert.ok(storedReply.metadata.citations?.some((source: any) => source.id === id), 'room source must enter reply citation metadata');
});

test('pending module drafts expose no raw record values in stored or broadcast metadata', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty update the record note';
  const triggerId = await message(spaceId, ownerId, content, new Date());
  const events: any[] = [];
  await handleAgentReply(job(spaceId, triggerId, content), {
    io: { to() { return { emit(event: string, payload: unknown) { events.push({event,payload}); } }; } },
    runQuery: (async () => result('Which record?', [{ action:'module_record_update',params:{record_id:'missing',changes:{private_note:'PRIVATE-DRAFT-CANARY'},expected_revision:1},approval_tier:'full'}])) as any,
    compileDraft: (async () => null) as any,
  } as any);
  const reply = (await client!.query('SELECT metadata FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3)', [spaceId, ownerId, rahulId])).rows[0];
  assert.ok(reply.metadata.defty_pending);
  assert.doesNotMatch(JSON.stringify(reply.metadata), /PRIVATE-DRAFT-CANARY/);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-DRAFT-CANARY/);
});

test('answer to a Defty clarification completes the original draft', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const now = Date.now();
  const sourceId = await message(spaceId,rahulId,'I will write the rollback script by October 29.',new Date(now-10000));
  const content = '@Defty make a task for what Rahul said';
  const requestId = await message(spaceId,ownerId,content,new Date(now-5000));
  await handleAgentReply(job(spaceId,requestId,content), { runQuery: (async () => result('Which project?', [{ action:'create_task', params:{ title:'Write rollback script', assignee_name:'Rahul Mehta', due_date:'2026-10-29', source_message_id:sourceId }, approval_tier:'quick' }])) as any });
  const question = (await client!.query('SELECT id,metadata,created_at FROM messages WHERE org_id=$1 AND space_id=$2 AND user_id<>$3 AND user_id<>$4 ORDER BY created_at DESC LIMIT 1',[orgId,spaceId,ownerId,rahulId])).rows[0];
  assert.equal(question.metadata.defty_pending.request_message_id,requestId);
  assert.match(question.metadata.defty_pending.question,/Deft v1/);
  assert.match(question.metadata.defty_pending.question,/Deft v2/);
  const answerId=await message(spaceId,ownerId,'Deft v1',new Date(new Date(question.created_at).getTime()+1000),requestId);
  await handleAgentReply(job(spaceId,answerId,'Deft v1',requestId), {
    runQuery: (async () => { throw new Error('The preserved draft should compile directly'); }) as any,
    compileDraft: (async (input: any) => {
      assert.equal(input.pendingDraft.request_text,'make a task for what Rahul said');
      assert.equal(input.pendingDraft.answer,'Deft v1');
      return { ...normalizeCompiledToolCalls([{name:'create_task',input:{project_name:'Deft v1'}}],input), metrics:{model:'stub',tokens_in:0,tokens_out:0,duration_ms:0} };
    }) as any,
  });
  const proposal=(await client!.query('SELECT params,approval_status FROM agent_actions WHERE org_id=$1 AND action=\'create_task\'',[orgId])).rows[0];
  assert.equal(proposal.approval_status,'pending');
  assert.equal(proposal.params.assignee_name,'Rahul Mehta');
  assert.equal(proposal.params.due_date,'2026-10-29');
  assert.equal(proposal.params.source_message_id,sourceId);
  assert.equal(proposal.params.project_name,'Deft v1');
  const resolved=(await client!.query('SELECT metadata FROM messages WHERE id=$1',[question.id])).rows[0];
  assert.ok(resolved.metadata.defty_pending_resolved_at);
});

for (const fails of [false, true]) {
  test(`actual reply handler emits working started then finished${fails ? ' when reasoning fails' : ''}`, { skip: !url }, async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const spaceId = await space();
    const content = '@Defty what is happening here?';
    const triggerId = await message(spaceId, ownerId, content, new Date());
    const events: any[] = [];
    const io = { to(room: string) { return { emit(event: string, payload: unknown) { events.push({ room, event, payload }); } }; } };
    await handleAgentReply(job(spaceId, triggerId, content), {
      io,
      runQuery: (async () => {
        assert.equal(events[0]?.payload.state, 'started');
        if (fails) throw new Error('reasoning failed');
        return result('Here is the update.');
      }) as any,
    } as any);
    const signals = events.filter(event => event.event === 'agent:working');
    assert.deepEqual(signals.map(event => [event.room, event.payload.state]), [
      [`space:${spaceId}`, 'started'], [`space:${spaceId}`, 'finished'],
    ]);
    assert.equal(signals[0].payload.label, 'Reading the conversation…');
    assert.equal(signals[0].payload.thread_id, null);
    assert.equal(signals[0].payload.agent_name, 'Defty');
    assert.ok(events.some(event => event.event === 'message:new'));
  });
}

test('a followed NO_REPLY turn posts nothing and finishes its working signal', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const parentId = await message(spaceId, ownerId, 'Pairing plans', new Date(Date.now() - 1000));
  const content = 'Rahul, can you update the task tomorrow?';
  const triggerId = await message(spaceId, ownerId, content, new Date(), parentId);
  const inputJob = job(spaceId, triggerId, content, parentId);
  Object.assign(inputJob.data, { followed: true });
  const events: any[] = [];
  let compileCalls = 0;
  await handleAgentReply(inputJob, {
    io: { to() { return { emit(event: string, payload: unknown) { events.push({ event, payload }); } }; } },
    runQuery: (async (input: any) => { assert.equal(input.followed, true); return result('NO_REPLY'); }) as any,
    compileDraft: (async () => { compileCalls += 1; throw new Error('An abstaining turn must not compile writes'); }) as any,
  } as any);
  assert.deepEqual(events.filter(event => event.event === 'agent:working').map(event => event.payload.state), ['started', 'finished']);
  assert.equal(events.some(event => event.event === 'message:new'), false);
  assert.equal(compileCalls, 0);
  assert.equal((await client!.query('SELECT count(*)::int AS count FROM messages WHERE space_id=$1', [spaceId])).rows[0].count, 2);
});

test('a followed answer to Defty still gets a reply', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const parentId = await message(spaceId, ownerId, 'Planning the work', new Date(Date.now() - 1000));
  const content = 'Yes, Monday works for the review.';
  const triggerId = await message(spaceId, ownerId, content, new Date(), parentId);
  const inputJob = job(spaceId, triggerId, content, parentId);
  Object.assign(inputJob.data, { followed: true });
  await handleAgentReply(inputJob, { runQuery: (async (input: any) => {
    assert.equal(input.followed, true);
    return result('Got it, the review is on Monday.');
  }) as any });
  const replies = await client!.query('SELECT content FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3)', [spaceId, ownerId, rahulId]);
  assert.deepEqual(replies.rows.map(row => row.content), ['Got it, the review is on Monday.']);
});

test('discussion task clarification persists owners dates and sources until project answer', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const sourceId = await message(spaceId, rahulId, 'I will write the rollback script by October 29.', new Date(Date.now() - 2000));
  const content = '@Defty make tasks from this discussion';
  const requestId = await message(spaceId, ownerId, content, new Date(Date.now() - 1000));
  await handleAgentReply(job(spaceId, requestId, content), { runQuery: (async () => result('Which project?', [{
    action: 'create_task', params: { title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29', source_message_id: sourceId }, approval_tier: 'quick',
  }])) as any });
  const question = (await client!.query('SELECT id,metadata,created_at FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3) ORDER BY created_at DESC LIMIT 1', [spaceId, ownerId, rahulId])).rows[0];
  assert.equal(question.metadata.defty_pending?.request_message_id, requestId);
  const savedDraft = question.metadata.defty_pending.draft.actions.find((action: any) => action.action === 'create_task');
  assert.ok(savedDraft, 'the discussion draft survives the project question');
  assert.equal(savedDraft.params.assignee_name, 'Rahul Mehta');
  assert.equal(savedDraft.params.due_date, '2026-10-29');
  assert.equal(savedDraft.params.source_message_id, sourceId);
  const answerId = await message(spaceId, ownerId, 'Deft v1', new Date(new Date(question.created_at).getTime() + 1000), requestId);
  await handleAgentReply(job(spaceId, answerId, 'Deft v1', requestId), {
    runQuery: (async () => { throw new Error('The saved discussion draft should compile directly'); }) as any,
    compileDraft: (async (input: any) => ({ ...normalizeCompiledToolCalls([{ name: 'create_task', input: { project_name: 'Deft v1' } }], input), metrics: { model: 'stub', tokens_in: 0, tokens_out: 0, duration_ms: 0 } })) as any,
  });
  const proposals = (await client!.query('SELECT params FROM agent_actions WHERE org_id=$1 AND action=\'create_task\'', [orgId])).rows;
  const proposal = proposals.find(row => row.params.source_message_id === sourceId);
  assert.ok(proposal);
  assert.equal(proposal.params.assignee_name, 'Rahul Mehta');
  assert.equal(proposal.params.due_date, '2026-10-29');
  assert.equal(proposal.params.project_name, 'Deft v1');
});

test('compiler-only clarification drafts validate source IDs before saving continuity', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty create a task for the rollback script';
  const requestId = await message(spaceId, ownerId, content, new Date());
  await handleAgentReply(job(spaceId, requestId, content), {
    runQuery: (async () => result('Which project?')) as any,
    compileDraft: (async () => ({
      actions: [], pendingActions: [{ action:'create_task', params:{title:'Write rollback script',source_message_id:'unreadable-source'},approval_tier:'quick' }],
      clarification:'Which project?',metrics:{model:'stub',tokens_in:0,tokens_out:0,duration_ms:0},
    })) as any,
  });
  const reply = (await client!.query('SELECT metadata FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3)', [spaceId, ownerId, rahulId])).rows[0];
  assert.equal(reply.metadata.defty_pending.draft.actions[0].params.source_message_id, requestId);
  assert.equal(reply.metadata.defty_pending.draft.actions[0].params.metadata.command_message_id, requestId);
});
