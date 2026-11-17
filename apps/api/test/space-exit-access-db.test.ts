/**
 * Before-strangers fix 1: access that must end when a person leaves a space.
 *
 * PRIVATE space. After a person leaves or is removed from it:
 *   - Defty's turn history shows them no content of a turn they requested there;
 *   - notifications that name the space or one of its messages are hidden;
 *   - the messages they had scheduled for it are cancelled and no longer listed.
 * Content from spaces they are still in, and notifications that name no space,
 * are unaffected.
 *
 * PUBLIC space. A member of the workspace may read a public space without
 * being in it (fix 4), so a member who leaves one keeps reading what any member
 * may: their turn and their notifications from it. A guest may not, so a
 * removed guest sees nothing from it. Posting needs membership for everyone,
 * so the scheduled messages of both are cancelled.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/space-exit-access-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { sweepExpiredStagedAttachments } from '../src/lib/attachment-retention.js';
import { sendScheduledMessage } from '../src/workers/handlers/scheduled-message-send.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = { creator: randomUUID(), leaver: randomUUID(), quitter: randomUUID(), guest: randomUUID(), defty: randomUUID(), racer: randomUUID() };
const roles: Record<string, 'member' | 'guest'> = {
  [ids.creator]: 'member', [ids.leaver]: 'member', [ids.quitter]: 'member', [ids.guest]: 'guest', [ids.defty]: 'member', [ids.racer]: 'member',
};
const employeeId = randomUUID();
const S = { priv: randomUUID(), other: randomUUID(), pub: randomUUID(), stale: randomUUID() };
const M = {
  request: randomUUID(), peer: randomUUID(), otherRequest: randomUUID(),
  pub: randomUUID(), pubRequest: randomUUID(), pubGuestRequest: randomUUID(),
};
const N = { mention: randomUUID() };
const scheduled = {
  priv: randomUUID(), other: randomUUID(), quit: randomUUID(), stale: randomUUID(),
  pub: randomUUID(), pubGuest: randomUUID(),
};
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let app: Hono | undefined;

async function call(actor: string, method: string, path: string, body?: unknown) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: actor, org_id: orgId, email: `${actor}@example.test`, sid: `exit-${actor}`, role: roles[actor] } as any);
    await next();
  });
  hono.route('/', app!);
  const response = await hono.request(path, body === undefined
    ? { method }
    : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const text = await response.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, json, text };
}

const canaries = (value: unknown) => [...new Set(JSON.stringify(value).match(/CANARY-[A-Z-]+/g) ?? [])].sort();
// The inbox lists the same notifications except huddle and system notices, which it never shows.
const inInbox = (tags: string[]) => tags.filter((tag) => !['CANARY-N-HUDDLE', 'CANARY-N-KEPT-SYSTEM'].includes(tag));

/** Everything the reader gets from the surfaces this fix covers, as canaries. */
async function seenBy(actor: string) {
  const [turns, activity, notifications, inbox, pending] = await Promise.all([
    call(actor, 'GET', `/api/agent-employees/${employeeId}/turns`),
    call(actor, 'GET', `/api/agent-employees/${employeeId}/activity`),
    call(actor, 'GET', '/api/notifications'),
    call(actor, 'GET', '/api/inbox?include_read=1'),
    call(actor, 'GET', '/api/scheduled-messages'),
  ]);
  for (const response of [turns, activity, notifications, inbox, pending]) assert.equal(response.status, 200, response.text);
  return {
    turns: canaries(turns.json),
    activity: canaries(activity.json),
    notifications: canaries(notifications.json),
    unread: notifications.json.unread_count as number,
    inbox: canaries(inbox.json),
    scheduled: canaries(pending.json),
  };
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Space exit', `space-exit-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    const agent = name === 'defty';
    await q('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,$4,$5)', [id, `${id}@example.test`, name, agent ? 'agent' : 'human', agent]);
    await q('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, id, roles[id]]);
  }
  await q(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,trust_level,runtime_kind,is_byoa,is_active,is_deleted,created_by)
    VALUES($1,$2,$3,'Defty','defty-system','superintendent','test','conservative','defty_system',false,true,true,$4)`, [employeeId, orgId, ids.defty, ids.creator]);

  const spaces: Array<[string, 'private' | 'public', string[]]> = [
    [S.priv, 'private', [ids.creator, ids.leaver, ids.quitter, ids.defty]],
    [S.other, 'private', [ids.creator, ids.leaver, ids.defty]],
    [S.pub, 'public', [ids.creator, ids.leaver, ids.guest]],
    [S.stale, 'private', [ids.creator]],
  ];
  for (const [id, type, members] of spaces) {
    await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [id, orgId, `${type}-${id}`, type, ids.creator]);
    for (const member of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, member]);
  }
  const messages: Array<[string, string, string]> = [
    [M.request, S.priv, ids.leaver], [M.peer, S.priv, ids.creator], [M.otherRequest, S.other, ids.leaver], [M.pub, S.pub, ids.creator],
    [M.pubRequest, S.pub, ids.leaver], [M.pubGuestRequest, S.pub, ids.guest],
  ];
  for (const [id, space, author] of messages) {
    await q('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [id, orgId, space, author, 'fixture message']);
  }

  // One Defty turn the leaver requested in each space, and one the guest requested in the public space.
  const turn = (message: string, space: string, tag: string) => q(
    `INSERT INTO agent_session_turns(id,org_id,employee_id,trigger_kind,triggering_message_id,space_id,input_messages_json,tool_calls_json,raw_reply_text,latency_ms,result,error)
     VALUES($1,$2,$3,'mention',$4,$5,$6::jsonb,$7::jsonb,$8,12,'error',$9)`,
    [randomUUID(), orgId, employeeId, message, space,
      JSON.stringify([{ role: 'user', content: `CANARY-${tag}-INPUT` }]), JSON.stringify([{ name: 'search', output: `CANARY-${tag}-TOOL` }]),
      `CANARY-${tag}-REPLY`, `CANARY-${tag}-ERROR`]);
  await turn(M.request, S.priv, 'PRIV');
  await turn(M.otherRequest, S.other, 'OTHER');
  await turn(M.pubRequest, S.pub, 'PUB');
  await turn(M.pubGuestRequest, S.pub, 'GUEST');

  // Notifications, in each shape the product writes them.
  const notify = (user: string, type: string, tag: string, link: string | null, metadata: unknown, id = randomUUID()) => q(
    'INSERT INTO notifications(id,org_id,user_id,type,title,body,link,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [id, orgId, user, type, 'fixture', `CANARY-N-${tag}`, link, metadata === null ? null : JSON.stringify(metadata)]);
  await notify(ids.leaver, 'mention', 'MENTION', `/chat?space=${S.priv}&message=${M.peer}`, null, N.mention);
  await notify(ids.leaver, 'message', 'MESSAGE', `/chat?space=${S.priv}&message=${M.peer}`, { message_id: M.peer, space_id: S.priv, is_direct_message: false });
  await notify(ids.leaver, 'huddle_started', 'HUDDLE', `/chat?space=${S.priv}`, { huddle_id: 'h1', space_id: S.priv });
  await notify(ids.leaver, 'agent_suggestion', 'BLOCKED', `/chat?space=${S.priv}&message=${M.peer}`, { nudge_type: 'blocked' });
  await notify(ids.leaver, 'mention', 'OLDLINK', `/spaces/${S.priv}`, null);
  await notify(ids.leaver, 'mention', 'KEPT-SPACE', `/chat?space=${S.other}&message=${M.otherRequest}`, null);
  await notify(ids.leaver, 'task_assigned', 'KEPT-TASK', '/tasks?task=T-1', { task_id: 'not-a-space' });
  await notify(ids.leaver, 'system', 'KEPT-SYSTEM', null, null);
  await notify(ids.leaver, 'mention', 'PUBLIC', `/chat?space=${S.pub}&message=${M.pub}`, null);
  await notify(ids.guest, 'mention', 'GUEST', `/chat?space=${S.pub}&message=${M.pub}`, null);

  const schedule = (id: string, user: string, space: string, tag: string) => q(
    `INSERT INTO scheduled_messages(id,org_id,user_id,space_id,content,scheduled_for) VALUES($1,$2,$3,$4,$5,now() + interval '1 day')`,
    [id, orgId, user, space, `CANARY-S-${tag}`]);
  await schedule(scheduled.priv, ids.leaver, S.priv, 'PRIV');
  await schedule(scheduled.other, ids.leaver, S.other, 'OTHER');
  await schedule(scheduled.quit, ids.quitter, S.priv, 'QUIT');
  // Left behind by an exit that happened before this fix: still pending, for a space the leaver is not in.
  await schedule(scheduled.stale, ids.leaver, S.stale, 'STALE');
  await schedule(scheduled.pub, ids.leaver, S.pub, 'PUB');
  await schedule(scheduled.pubGuest, ids.guest, S.pub, 'GUEST');

  app = new Hono()
    .route('/api/agent-employees', (await import('../src/routes/agent-employees.js')).agentEmployeeRoutes)
    .route('/api/notifications', (await import('../src/routes/notifications.js')).notificationRoutes)
    .route('/api/inbox', (await import('../src/routes/inbox.js')).inboxRoutes)
    .route('/api/scheduled-messages', (await import('../src/routes/scheduled.js')).scheduledRoutes)
    .route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM message_attachments WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM files WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM job_queue WHERE org_id=$1', [orgId]).catch(() => undefined);
    for (const table of ['scheduled_messages', 'notifications', 'attention_events', 'attention_items', 'agent_session_turns', 'agent_actions']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
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

const turnCanaries = (...tags: string[]) =>
  tags.flatMap((tag) => ['ERROR', 'INPUT', 'REPLY', 'TOOL'].map((part) => `CANARY-${tag}-${part}`)).sort();
const scheduledStatus = async (id: string) =>
  (await client!.query('SELECT status FROM scheduled_messages WHERE id=$1', [id])).rows[0].status as string;

test('while still a member, the person sees their turn, notifications and scheduled messages', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const seen = await seenBy(ids.leaver);
  // Their own three turns; the guest's turn is never theirs to read.
  assert.deepEqual(seen.turns, turnCanaries('OTHER', 'PRIV', 'PUB'));
  assert.deepEqual(seen.activity, ['CANARY-OTHER-ERROR', 'CANARY-PRIV-ERROR', 'CANARY-PUB-ERROR']);
  const all = ['BLOCKED', 'HUDDLE', 'KEPT-SPACE', 'KEPT-SYSTEM', 'KEPT-TASK', 'MENTION', 'MESSAGE', 'OLDLINK', 'PUBLIC'].map((tag) => `CANARY-N-${tag}`);
  assert.deepEqual(seen.notifications, all);
  assert.equal(seen.unread, all.length);
  assert.deepEqual(seen.inbox, inInbox(all));
  // The stale row is for a space the leaver is not in: never listed.
  assert.deepEqual(seen.scheduled, ['CANARY-S-OTHER', 'CANARY-S-PRIV', 'CANARY-S-PUB']);
});

test('removed from a private space: no turn, notification or scheduled message from it', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const removed = await call(ids.creator, 'DELETE', `/api/spaces/${S.priv}/members/${ids.leaver}`);
  assert.equal(removed.status, 200, removed.text);

  const seen = await seenBy(ids.leaver);
  assert.deepEqual(seen.turns, turnCanaries('OTHER', 'PUB'));
  assert.deepEqual(seen.activity, ['CANARY-OTHER-ERROR', 'CANARY-PUB-ERROR']);
  const kept = ['KEPT-SPACE', 'KEPT-SYSTEM', 'KEPT-TASK', 'PUBLIC'].map((tag) => `CANARY-N-${tag}`);
  assert.deepEqual(seen.notifications, kept);
  assert.equal(seen.unread, kept.length, 'hidden notifications are not counted');
  assert.deepEqual(seen.inbox, inInbox(kept));
  assert.deepEqual(seen.scheduled, ['CANARY-S-OTHER', 'CANARY-S-PUB']);

  // Every turn is still listed; the private-space turn (and the guest's) has its content withheld.
  const turns = await call(ids.leaver, 'GET', `/api/agent-employees/${employeeId}/turns`);
  assert.equal(turns.json.turns.length, 4);
  const withheld = turns.json.turns.filter((turn: any) => turn.input_messages_json === null);
  assert.equal(withheld.length, 2, turns.text);
  for (const turn of withheld) assert.deepEqual([turn.tool_calls_json, turn.raw_reply_text, turn.error], [null, null, null]);

  // A hidden notification cannot be acted on either.
  const markRead = await call(ids.leaver, 'PATCH', `/api/notifications/${N.mention}/read`);
  assert.equal(markRead.status, 404, markRead.text);
  await call(ids.leaver, 'POST', '/api/notifications/read-all');
  const { rows } = await client!.query('SELECT is_read FROM notifications WHERE id=$1', [N.mention]);
  assert.equal(rows[0].is_read, false, 'read-all leaves a hidden notification untouched');

  assert.equal(await scheduledStatus(scheduled.priv), 'cancelled');
  assert.equal(await scheduledStatus(scheduled.other), 'pending');
  assert.equal(await scheduledStatus(scheduled.quit), 'pending', 'another member\'s scheduled message is untouched');
  // A person still in the space keeps everything.
  assert.deepEqual((await seenBy(ids.quitter)).scheduled, ['CANARY-S-QUIT']);
});

test('leaving a space cancels the leaver\'s own scheduled messages for it', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const left = await call(ids.quitter, 'DELETE', `/api/spaces/${S.priv}/members/me`);
  assert.equal(left.status, 200, left.text);
  assert.equal(await scheduledStatus(scheduled.quit), 'cancelled');
  assert.deepEqual((await seenBy(ids.quitter)).scheduled, []);
});

test('a public space: a member who leaves still reads what any member may; a removed guest sees nothing', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // While in the space, the guest sees their own turn, notification and scheduled message.
  const guestBefore = await seenBy(ids.guest);
  assert.deepEqual(guestBefore.turns, turnCanaries('GUEST'));
  assert.deepEqual(guestBefore.activity, ['CANARY-GUEST-ERROR']);
  assert.deepEqual(guestBefore.notifications, ['CANARY-N-GUEST']);
  assert.deepEqual(guestBefore.scheduled, ['CANARY-S-GUEST']);

  for (const user of [ids.leaver, ids.guest]) {
    const removed = await call(ids.creator, 'DELETE', `/api/spaces/${S.pub}/members/${user}`);
    assert.equal(removed.status, 200, removed.text);
  }

  // The member is no longer in the space but, as a member of the workspace, may still read it.
  const member = await seenBy(ids.leaver);
  assert.deepEqual(member.turns, turnCanaries('OTHER', 'PUB'));
  assert.deepEqual(member.activity, ['CANARY-OTHER-ERROR', 'CANARY-PUB-ERROR']);
  const kept = ['KEPT-SPACE', 'KEPT-SYSTEM', 'KEPT-TASK', 'PUBLIC'].map((tag) => `CANARY-N-${tag}`);
  assert.deepEqual(member.notifications, kept);
  assert.deepEqual(member.inbox, inInbox(kept));

  // The guest may not read a public space they are not in.
  const guest = await seenBy(ids.guest);
  assert.deepEqual(guest.turns, []);
  assert.deepEqual(guest.activity, []);
  assert.deepEqual(guest.notifications, []);
  assert.equal(guest.unread, 0);
  assert.deepEqual(guest.inbox, []);

  // Posting needs membership for everyone, so neither keeps a scheduled message for the space.
  assert.deepEqual(member.scheduled, ['CANARY-S-OTHER']);
  assert.deepEqual(guest.scheduled, []);
  assert.equal(await scheduledStatus(scheduled.pub), 'cancelled');
  assert.equal(await scheduledStatus(scheduled.pubGuest), 'cancelled');
});

test('an archived public space: someone who is not in it loses its notifications, someone still in it keeps them', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // The leaver left the public space in the test above; the creator is still in it.
  await client!.query(
    `INSERT INTO notifications(id,org_id,user_id,type,title,body,link) VALUES($1,$2,$3,'mention','fixture','CANARY-N-CREATOR',$4)`,
    [randomUUID(), orgId, ids.creator, `/chat?space=${S.pub}&message=${M.pub}`]);
  // The creator asked Defty something in the public space (the creator is a plain member of the workspace).
  await client!.query(
    `INSERT INTO agent_session_turns(id,org_id,employee_id,trigger_kind,triggering_message_id,space_id,input_messages_json,raw_reply_text,latency_ms,result,error)
     VALUES($1,$2,$3,'mention',$4,$5,'[]'::jsonb,'CANARY-CREATOR-REPLY',12,'error','CANARY-CREATOR-ERROR')`,
    [randomUUID(), orgId, employeeId, M.pub, S.pub]);
  assert.ok((await seenBy(ids.leaver)).notifications.includes('CANARY-N-PUBLIC'));
  assert.ok((await seenBy(ids.leaver)).turns.includes('CANARY-PUB-REPLY'), 'a public space is readable without being in it');
  assert.deepEqual((await seenBy(ids.creator)).notifications, ['CANARY-N-CREATOR']);
  assert.deepEqual((await seenBy(ids.creator)).turns, ['CANARY-CREATOR-ERROR', 'CANARY-CREATOR-REPLY']);
  assert.equal((await call(ids.leaver, 'GET', `/api/spaces/${S.pub}`)).status, 200);

  await client!.query('UPDATE spaces SET is_archived=true WHERE id=$1', [S.pub]);

  // The notification follows the same rule as opening the space.
  assert.equal((await call(ids.leaver, 'GET', `/api/spaces/${S.pub}`)).status, 403);
  const leaver = await seenBy(ids.leaver);
  assert.ok(!leaver.notifications.includes('CANARY-N-PUBLIC'), leaver.notifications.join(','));
  assert.ok(!leaver.inbox.includes('CANARY-N-PUBLIC'));
  assert.equal((await call(ids.creator, 'GET', `/api/spaces/${S.pub}`)).status, 200);
  assert.deepEqual((await seenBy(ids.creator)).notifications, ['CANARY-N-CREATOR']);
  // Turn history follows the same rule: gone for someone not in the archived space, kept for someone in it.
  assert.ok(!leaver.turns.includes('CANARY-PUB-REPLY') && !leaver.activity.includes('CANARY-PUB-ERROR'), leaver.turns.join(','));
  const creator = await seenBy(ids.creator);
  assert.deepEqual(creator.turns, ['CANARY-CREATOR-ERROR', 'CANARY-CREATOR-REPLY']);
  assert.deepEqual(creator.activity, ['CANARY-CREATOR-ERROR']);
});

test('scheduling a message at the same moment as being removed never leaves a pending message behind', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const space = randomUUID();
  await client!.query(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'private',$4)`, [space, orgId, `race-${space}`, ids.creator]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, ids.creator]);
  const outcomes = new Set<number>();
  for (let round = 0; round < 12; round += 1) {
    await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, ids.racer]);
    const schedule = () => call(ids.racer, 'POST', '/api/scheduled-messages', { space_id: space, content: `CANARY-S-RACE ${round}`, scheduled_for: '2999-01-01T00:00:00.000Z' });
    const remove = () => call(ids.creator, 'DELETE', `/api/spaces/${space}/members/${ids.racer}`);
    // Alternate which request is issued first so both orders are exercised.
    const [scheduled, removed] = round % 2 === 0
      ? await Promise.all([schedule(), remove()])
      : (await Promise.all([remove(), schedule()])).reverse() as [Awaited<ReturnType<typeof schedule>>, Awaited<ReturnType<typeof remove>>];
    assert.equal(removed.status, 200, removed.text);
    assert.ok(scheduled.status === 201 || scheduled.status === 403, `${scheduled.status} ${scheduled.text}`);
    outcomes.add(scheduled.status);
    const { rows } = await client!.query(
      `SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id=$1 AND user_id=$2 AND status='pending'`, [space, ids.racer]);
    assert.equal(rows[0].n, 0, `round ${round}: a pending message survived the removal (schedule answered ${scheduled.status})`);
  }
  assert.deepEqual((await seenBy(ids.racer)).scheduled, []);
  // Once removed, scheduling is refused outright.
  const late = await call(ids.racer, 'POST', '/api/scheduled-messages', { space_id: space, content: 'late', scheduled_for: '2999-01-01T00:00:00.000Z' });
  assert.equal(late.status, 403, late.text);
  t.diagnostic(`schedule answered: ${[...outcomes].sort().join(', ')}`);
});


test('leaving or cancelling one schedule preserves an upload needed by another pending schedule', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const cancel of ['leave', 'cancel']) {
    const firstSpace = randomUUID(), secondSpace = randomUUID(), file = randomUUID();
    for (const space of [firstSpace, secondSpace]) {
      await client!.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'private',$4)", [space, orgId, space, ids.creator]);
      await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, ids.creator]);
    }
    await client!.query("INSERT INTO files(id,org_id,uploaded_by,filename,mime_type,size_bytes,storage_key,staged_expires_at) VALUES($1,$2,$3,'shared.txt','text/plain',5,$4,now()+interval '1 day')", [file, orgId, ids.creator, 'shared-' + file]);
    const content = '[[file:' + file + ':shared.txt:text/plain:5:/api/files/' + file + ']]';
    const create = (space: string, days: number) => call(ids.creator, 'POST', '/api/scheduled-messages', { space_id: space, content, scheduled_for: new Date(Date.now() + days * 86400000).toISOString() });
    const first = await create(firstSpace, 2), second = await create(secondSpace, 7);
    assert.equal(first.status, 201, first.text);
    assert.equal(second.status, 201, second.text);
    const cancelled = cancel === 'leave' ? await call(ids.creator, 'DELETE', '/api/spaces/' + firstSpace + '/members/me')
      : await call(ids.creator, 'DELETE', '/api/scheduled-messages/' + first.json.id);
    assert.equal(cancelled.status, 200, cancelled.text);
    const deleted: string[] = [];
    await sweepExpiredStagedAttachments({ now: new Date(Date.now() + 3 * 86400000), store: { delete: async (key: string) => { deleted.push(key); } } as any });
    assert.equal((await client!.query('SELECT 1 FROM files WHERE id=$1', [file])).rowCount, 1, cancel + " discarded another schedule's upload");
    assert.ok(!deleted.includes('shared-' + file));
    assert.equal(await sendScheduledMessage(second.json.id), true, 'the remaining message can claim its attachment');
  }
});
