/**
 * M3: Defty's document read tools and the shared-chat rule (spec 5.7; plan
 * Task M3 with the 25 Nov consult's changes; consult rule C4).
 *
 * - search_documents, read_document and list_drive read with the access of
 *   the person who asked (lib/document-access.ts).
 * - In a shared conversation (a chat with an active member other than the
 *   asker and Defty: a person, or an agent user whose employee is active),
 *   every result is held to that audience: what not everyone there can open
 *   comes back as { id, withheld: true }, and the asker is told privately, in
 *   their own DM with Defty, once per reply.
 * - What a run stores keeps references only, and run details name a
 *   document only to a viewer who can open it now, owners and admins
 *   included (lib/agent-message-run-details.ts).
 *
 * The model is a stub (agent-llm's createAgentMessage); the tools run for
 * real against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-document-read-tools-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

let nextResponses: Array<{ content: any[]; stop_reason: string }> = [];
/** What the model was sent on each call of the run, as JSON. */
const providerCalls: string[] = [];

const actualLlm = await import('../src/lib/agent-llm.js');
mock.module(new URL('../src/lib/agent-llm.ts', import.meta.url).href, { namedExports: {
  ...actualLlm,
  createAgentMessage: async (params: { messages: unknown }) => {
    providerCalls.push(JSON.stringify(params.messages));
    const next = nextResponses.shift() ?? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
    return { ...next, usage: { input_tokens: 5, output_tokens: 5 } };
  },
} });
const actualDiscovery = await import('../src/lib/app-installed-tool-discovery.js');
mock.module(new URL('../src/lib/app-installed-tool-discovery.ts', import.meta.url).href, { namedExports: {
  ...actualDiscovery,
  installedToolSchemas: async () => [],
} });
const actualMcp = await import('../src/lib/mcp-tools.js');
mock.module(new URL('../src/lib/mcp-tools.ts', import.meta.url).href, { namedExports: {
  ...actualMcp,
  getMCPToolsForAgent: async () => [],
} });
const actualRetrieve = await import('../src/lib/retrieve-context.js');
mock.module(new URL('../src/lib/retrieve-context.ts', import.meta.url).href, { namedExports: {
  ...actualRetrieve,
  retrieveContext: async () => [],
} });
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  resolveReasonProvider: async () => ({ provider: 'anthropic', model: 'test-model', apiKey: 'test-key' }),
  getOrgAIConfig: async () => ({ api_keys: { anthropic: 'test-key' } }),
} });

const { runAgentQuery } = await import('../src/lib/agent-runner.js');
const { executeToolCall } = await import('../src/lib/agent-context.js');
const { projectMessagesForViewer } = await import('../src/lib/agent-message-run-details.js');
const { ensureDeftyDm, ensureDeftyMembership } = await import('../src/lib/ensure-defty-membership.js');
const { closeDb } = await import('../src/lib/db.js');

const url = safeTestDatabaseUrl();
const skip = !url;
const run = randomUUID().replace(/-/g, '').slice(0, 10);
let fx: DrivesFixture;
let deftyId: string;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('m3');
  deftyId = await ensureDeftyMembership(fx.orgId);
});

after(async () => {
  if (skip) return;
  if (fx) {
    const q = (text: string) => fx.client.query(text, [[fx.orgId, fx.otherOrgId]]);
    await q('DELETE FROM action_receipts WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM agent_actions WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM job_queue WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM messages WHERE org_id = ANY($1::text[])');
    await fx.teardown();
  }
  await closeDb();
});

const text = (value: unknown) => JSON.stringify(value) ?? '';

/** A document whose blocks carry ids, with `phrase` in its text. */
function docJson(phrase: string) {
  return { type: 'doc', content: [
    { type: 'heading', attrs: { id: 'm3-heading', level: 1 }, content: [{ type: 'text', text: 'Launch plan' }] },
    { type: 'paragraph', attrs: { id: 'm3-body' }, content: [{ type: 'text', text: `The plan: ${phrase} ships first.` }] },
  ] };
}

const token = (label: string) => `m3${label}${run}`;

/** A chat of the workspace with these members (Defty is added where a test needs it). */
async function insertChat(name: string, members: string[], type: 'public' | 'private' = 'public'): Promise<string> {
  const id = randomUUID();
  await fx.client.query('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, fx.orgId, name, type, fx.people.owner]);
  for (const user of members) {
    await fx.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  }
  return id;
}

/** Defty's messages in a chat, oldest first. */
async function deftyMessages(spaceId: string): Promise<Array<{ content: string; metadata: any }>> {
  const { rows } = await fx.client.query(
    'SELECT content, metadata FROM messages WHERE org_id = $1 AND space_id = $2 AND user_id = $3 ORDER BY created_at, id',
    [fx.orgId, spaceId, deftyId]);
  return rows;
}

/**
 * Asks Defty in `spaceId` with a stubbed model that calls the tools in
 * `calls` once and then answers. Returns the run and what the model was sent
 * after the tools ran (the tool results).
 */
async function askDefty(i: {
  asker: string; spaceId: string; spaceName: string; spaceType?: 'public' | 'private' | 'dm';
  calls: Array<{ name: string; input: Record<string, unknown> }>; maxIterations?: number; sourceMessageId?: string;
}) {
  providerCalls.length = 0;
  nextResponses = [
    { content: i.calls.map((call, at) => ({ type: 'tool_use', id: `toolu_m3_${at}_${randomUUID().slice(0, 8)}`, name: call.name, input: call.input })),
      stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Here is what I found.' }], stop_reason: 'end_turn' },
  ];
  const result = await runAgentQuery({
    content: 'What does the launch plan say?',
    orgId: fx.orgId,
    userId: i.asker,
    orgName: 'M3 org',
    conversationId: i.spaceId,
    sourceMessageId: i.sourceMessageId,
    spaceContext: { type: i.spaceType ?? 'public', name: i.spaceName },
    skipVerification: true,
    durableNotes: false,
    maxIterations: i.maxIterations ?? 2,
  });
  return { result, toModel: providerCalls.slice(1).join('\n') };
}

test('read_document returns Markdown with block ids for a document the asker can open, and an error for one they can\'t', { skip }, async () => {
  const { member, member2 } = fx.people;
  const phrase = token('read');
  const myDrive = await fx.insertDrive({ kind: 'personal', ownerUserId: member, name: `My drive ${run}` });
  const documentId = await fx.insertDocument({ driveId: myDrive, title: `Launch plan ${run}`, json: docJson(phrase) });

  const read = await executeToolCall('read_document', { document_id: documentId }, fx.orgId, member);
  const result = read.result as any;
  assert.equal(result.error, undefined, text(result));
  assert.equal(result.id, documentId);
  assert.equal(result.title, `Launch plan ${run}`);
  assert.equal(result.role, 'full');
  assert.deepEqual(result.drive, { id: myDrive, name: `My drive ${run}` });
  assert.match(result.markdown, /<!-- block:m3-heading -->\n# Launch plan/);
  assert.match(result.markdown, new RegExp(`<!-- block:m3-body -->\\nThe plan: ${phrase} ships first\\.`));
  assert.deepEqual(read.citations.map((citation: any) => [citation.type, citation.id, citation.title]),
    [['document', documentId, `Launch plan ${run}`]]);

  const refused = await executeToolCall('read_document', { document_id: documentId }, fx.orgId, member2);
  assert.equal((refused.result as any).code, 'DOCUMENT_NOT_FOUND');
  assert.ok(!text(refused).includes(phrase), 'someone who can\'t open it gets none of it');
  assert.ok(!text(refused).includes('Launch plan'), 'nor its title');
  assert.deepEqual(refused.citations, []);
});

test('search_documents finds a document shared only with the asker', { skip }, async () => {
  const { member, member2, guest } = fx.people;
  const word = token('needle');
  const theirDrive = await fx.insertDrive({ kind: 'private', name: `Member2 only ${run}` });
  await fx.addDriveMember(theirDrive, { user: member2 }, 'full');
  const documentId = await fx.insertDocument({ driveId: theirDrive, title: `Budget ${run}`, json: docJson(word) });
  await fx.share(documentId, { user: member }, 'view');

  const found = await executeToolCall('search_documents', { query: word }, fx.orgId, member);
  const hits = (found.result as any).documents as any[];
  assert.ok(Array.isArray(hits), text(found.result));
  assert.equal(hits.length, 1, text(hits));
  assert.equal(hits[0].id, documentId);
  assert.equal(hits[0].title, `Budget ${run}`);
  assert.ok(String(hits[0].snippet).includes(word), `the snippet shows the match: ${hits[0].snippet}`);
  assert.equal(hits[0].drive_name, null, 'a drive the asker can\'t see stays unnamed');
  assert.ok(!text(found).includes(`Member2 only ${run}`));
  assert.ok(found.citations.some((citation: any) => citation.type === 'document' && citation.id === documentId));

  const asGuest = await executeToolCall('search_documents', { query: word }, fx.orgId, guest);
  assert.deepEqual((asGuest.result as any).documents, []);
  assert.ok(!text(asGuest).includes(word));
});

test('list_drive with no drive lists the asker\'s drives', { skip }, async () => {
  const { member, member2, guest } = fx.people;
  const mine = await fx.insertDrive({ kind: 'personal', ownerUserId: member2, name: `Member2's drive ${run}` });
  const notMine = await fx.insertDrive({ kind: 'private', name: `Not member2's ${run}` });
  await fx.addDriveMember(notMine, { user: member }, 'full');

  const listed = await executeToolCall('list_drive', {}, fx.orgId, member2);
  const drives = (listed.result as any).drives as any[];
  assert.ok(Array.isArray(drives), text(listed.result));
  const byId = new Map(drives.map((drive) => [drive.id, drive]));
  assert.equal(byId.get(fx.workspaceDriveId)?.name, 'Workspace');
  assert.equal(byId.get(fx.workspaceDriveId)?.kind, 'open');
  assert.equal(byId.get(mine)?.name, `Member2's drive ${run}`);
  assert.equal(byId.get(mine)?.role, 'full');
  assert.ok(!byId.has(notMine), 'a drive they can\'t open isn\'t listed');
  assert.ok(!text(listed).includes(`Not member2's ${run}`));

  const asGuest = await executeToolCall('list_drive', {}, fx.orgId, guest);
  assert.ok(!((asGuest.result as any).drives as any[]).some((drive) => drive.id === fx.workspaceDriveId),
    'a guest gets nothing through an open drive');
});

test('in a chat where a guest can\'t open the document, the room reply withholds it and the asker gets a DM naming it', { skip }, async () => {
  const { member, member2, guest } = fx.people;
  const phrase = token('guestroom');
  const title = `Roadmap ${run}`;
  const roomName = `launch-${run}`;
  const room = await insertChat(roomName, [member, member2, guest, deftyId]);
  // In the open Workspace drive: both members can open it, the guest can't.
  const documentId = await fx.insertDocument({ driveId: fx.workspaceDriveId, title, json: docJson(phrase) });
  const triggerId = randomUUID();
  await fx.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [triggerId, fx.orgId, room, member, 'What does the roadmap say?']);

  const { result, toModel } = await askDefty({
    asker: member, spaceId: room, spaceName: roomName, sourceMessageId: triggerId,
    calls: [{ name: 'read_document', input: { document_id: documentId } }, { name: 'search_documents', input: { query: 'roadmap' } }],
  });

  // The model is given the reference only, so the room reply can't quote it.
  assert.ok(toModel.includes(documentId), 'the model is told which document was withheld');
  assert.match(toModel, /\\"withheld\\":true/);
  assert.ok(!toModel.includes(phrase), 'none of its text reaches the model');
  assert.ok(!toModel.includes(title), 'nor its title');
  assert.ok(!text(result).includes(phrase) && !text(result).includes(title), 'nor anything the run returns to be stored');
  assert.ok(!result.citations.some((citation: any) => citation.id === documentId), 'and it is not cited');

  // The asker hears about it privately, once, in their DM with Defty.
  const dm = await ensureDeftyDm(fx.orgId, member);
  const notices = (await deftyMessages(dm)).filter((message) => message.content.includes(roomName));
  assert.equal(notices.length, 1, text(notices));
  assert.equal(notices[0]!.content, `I didn't quote ${title} in #${roomName} because not everyone there can open it.`);
  assert.ok(!text(notices[0]!.metadata).includes(title), 'the notice keeps references in its metadata');
  assert.equal((await deftyMessages(room)).length, 0, 'nothing about it is posted in the room');

  // A redelivered run for the same message doesn't tell them twice.
  await askDefty({
    asker: member, spaceId: room, spaceName: roomName, sourceMessageId: triggerId,
    calls: [{ name: 'read_document', input: { document_id: documentId } }],
  });
  assert.equal((await deftyMessages(dm)).filter((message) => message.content.includes(roomName)).length, 1);
});

test('in a DM with Defty, nothing is withheld', { skip }, async () => {
  const { member2 } = fx.people;
  const phrase = token('dm');
  const title = `Hiring plan ${run}`;
  const documentId = await fx.insertDocument({ driveId: fx.workspaceDriveId, title, json: docJson(phrase) });
  const dm = await ensureDeftyDm(fx.orgId, member2);
  const before = (await deftyMessages(dm)).length;

  const direct = await executeToolCall('read_document', { document_id: documentId }, fx.orgId, member2, dm);
  assert.equal((direct.result as any).withheld, undefined);
  assert.ok(String((direct.result as any).markdown).includes(phrase));

  const { toModel } = await askDefty({
    asker: member2, spaceId: dm, spaceName: 'DM', spaceType: 'dm', sourceMessageId: randomUUID(),
    calls: [{ name: 'read_document', input: { document_id: documentId } }],
  });
  assert.ok(toModel.includes(phrase), 'the asker\'s own DM gets the document');
  assert.ok(toModel.includes(title));
  assert.doesNotMatch(toModel, /\\"withheld\\":true/);
  assert.equal((await deftyMessages(dm)).length, before, 'no notice');
});

test('in a room with an employee who can\'t open the document, the room reply withholds it', { skip }, async () => {
  const { member } = fx.people;
  const phrase = token('employee');
  const title = `Pricing ${run}`;
  const employeeId = randomUUID();
  const employeeUser = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  const roomName = `with-agent-${run}`;
  const room = await insertChat(roomName, [member, employeeUser, deftyId], 'private');
  const memberDrive = await fx.insertDrive({ kind: 'private', name: `Member's drive (employee) ${run}` });
  await fx.addDriveMember(memberDrive, { user: member }, 'full');
  const documentId = await fx.insertDocument({ driveId: memberDrive, title, json: docJson(phrase) });

  const { result, toModel } = await askDefty({
    asker: member, spaceId: room, spaceName: roomName, spaceType: 'private', sourceMessageId: randomUUID(),
    calls: [{ name: 'read_document', input: { document_id: documentId } }],
  });
  assert.match(toModel, /\\"withheld\\":true/);
  assert.ok(!toModel.includes(phrase) && !toModel.includes(title), 'the employee in the room can\'t open it, so the model gets none of it');
  assert.ok(!text(result).includes(phrase));

  // A paused employee isn't in the audience: with only the asker left, the room is private.
  await fx.client.query('UPDATE agent_employees SET is_active = false WHERE id = $1', [employeeId]);
  const paused = await executeToolCall('read_document', { document_id: documentId }, fx.orgId, member, room);
  assert.ok(String((paused.result as any).markdown).includes(phrase), text(paused.result));
});

test('list_drive in a shared room hides drives some members can\'t see', { skip }, async () => {
  const { member, member2, guest } = fx.people;
  const roomName = `drives-${run}`;
  const room = await insertChat(roomName, [member, member2, guest, deftyId]);
  const roomDrive = await fx.insertDrive({ kind: 'private', name: `Room drive ${run}` });
  await fx.addDriveMember(roomDrive, { space: room }, 'view');
  const privateName = `Member only ${run}`;
  const memberOnly = await fx.insertDrive({ kind: 'private', name: privateName });
  await fx.addDriveMember(memberOnly, { user: member }, 'full');

  const inRoom = await executeToolCall('list_drive', {}, fx.orgId, member, room);
  const drives = (inRoom.result as any).drives as any[];
  const byId = new Map(drives.map((drive) => [drive.id, drive]));
  assert.equal(byId.get(roomDrive)?.name, `Room drive ${run}`, 'a drive everyone in the room can see is shown');
  assert.deepEqual(byId.get(memberOnly), { id: memberOnly, withheld: true });
  // The guest gets nothing through the open Workspace drive.
  assert.deepEqual(byId.get(fx.workspaceDriveId), { id: fx.workspaceDriveId, withheld: true });
  assert.ok(!text(inRoom).includes(privateName), 'a withheld drive carries no name');
  assert.deepEqual(inRoom.withheld?.filter((ref: any) => ref.id === memberOnly), [{ type: 'drive', id: memberOnly }]);

  const listing = await executeToolCall('list_drive', { drive_id: memberOnly }, fx.orgId, member, room);
  assert.deepEqual(listing.result, { id: memberOnly, withheld: true });

  // Out of the room, the asker sees their own drives by name.
  const alone = await executeToolCall('list_drive', {}, fx.orgId, member);
  assert.ok(text(alone).includes(privateName));
});

test('an admin viewing run details of a private-drive read sees no document text', { skip }, async () => {
  const { member, member2, admin } = fx.people;
  const phrase = token('admin');
  const title = `Reorg ${run}`;
  // Both people in the room can open the document, so the room reply may use it; the admin can't.
  const privateDrive = await fx.insertDrive({ kind: 'private', name: `Leadership ${run}` });
  await fx.addDriveMember(privateDrive, { user: member }, 'full');
  await fx.addDriveMember(privateDrive, { user: member2 }, 'view');
  const documentId = await fx.insertDocument({ driveId: privateDrive, title, json: docJson(phrase) });
  const roomName = `leads-${run}`;
  const room = await insertChat(roomName, [member, member2, deftyId]);
  const requestId = randomUUID();
  await fx.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [requestId, fx.orgId, room, member, 'What does the reorg doc say?']);

  // One iteration: the run's last response is the tool calls, as a caller stores it.
  const { result } = await askDefty({
    asker: member, spaceId: room, spaceName: roomName, sourceMessageId: requestId, maxIterations: 1,
    calls: [{ name: 'read_document', input: { document_id: documentId } }, { name: 'search_documents', input: { query: phrase } }],
  });
  // Everyone in the room can open it, so it was read; the run keeps only a reference to what it read.
  const executed = result.executedActions.find((action: any) => action.action === 'read_document');
  assert.deepEqual(executed?.result, { document_id: documentId, block_ids: ['m3-heading', 'm3-body'], withheld: false });
  assert.ok(!text(result.executedActions).includes(phrase));

  // The reply as agent-reply.ts stores it.
  const replyId = randomUUID();
  const metadata = { is_agent_reply: true, reply_to_message_id: requestId, agent_blocks: result.assistantBlocks, citations: result.citations };
  await fx.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [replyId, fx.orgId, room, deftyId, 'Here is what I found.', JSON.stringify(metadata)]);
  const { rows: [stored] } = await fx.client.query('SELECT id, user_id, space_id, metadata FROM messages WHERE id = $1', [replyId]);
  assert.ok(!text(stored.metadata).includes(phrase), 'the stored run keeps no document text');
  assert.ok(!text(stored.metadata).includes(title), 'nor its title');
  const toolUses = (stored.metadata.agent_blocks as any[]).filter((block) => block.type === 'tool_use');
  assert.deepEqual(toolUses.find((block) => block.name === 'read_document')?.input, { document_id: documentId });

  // An admin receives run details, and can't open the document: none of it is in them.
  const [asAdmin] = await projectMessagesForViewer({ id: admin, org_id: fx.orgId, role: 'admin' }, [stored]);
  assert.ok(Array.isArray((asAdmin!.metadata as any).agent_blocks), 'the admin is in the run-detail audience');
  assert.ok(!text(asAdmin).includes(phrase), 'no document text for the admin');
  assert.ok(!text(asAdmin).includes(title), 'no title either');
  assert.ok(!((asAdmin!.metadata as any).citations ?? []).some((citation: any) => citation.id === documentId));

  // The person who asked can open it, and gets the source with its title.
  const [asMember] = await projectMessagesForViewer({ id: member, org_id: fx.orgId, role: 'member' }, [stored]);
  assert.ok(((asMember!.metadata as any).citations as any[]).some((citation) =>
    citation.type === 'document' && citation.id === documentId && citation.title === title));
});
