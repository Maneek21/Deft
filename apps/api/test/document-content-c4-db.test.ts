/**
 * M7's rule C4 carry-forwards (the F15 and M3 reviews): document text from
 * Defty's and the MCP note tools is shown only to people who can open the
 * document now.
 *
 * - Plan steps: a completed step of a document tool keeps references only,
 *   in its params, its result and the plan's context, so a plan's creator who
 *   loses the document sees none of it (a plan stored before keeps none
 *   either: every step and context entry is read back from the allowlist).
 *   Literal text written for a step is kept like a pending draft, for the
 *   plan's creator and approvers, until the step completes (fix round 2); a
 *   read's text is never kept, and a later run reads it again.
 * - MCP replay: a note tool's idempotent answer is stored as references, and
 *   a replay reads the note again with the caller's access now.
 *
 * Run: pnpm --filter @deft/api test test/document-content-c4-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { closeDb } from '../src/lib/db.js';
import { createPlanRow, executePlan } from '../src/lib/agent-plans.js';
import { ensureDeftyDm, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { humanNoteCreate, humanNoteUpdate, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { agentRoutes } from '../src/routes/agent.js';
import { agentPlanRoutes } from '../src/routes/agent-plans.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const skip = !url;
const run = randomUUID().replace(/-/g, '').slice(0, 10);
let fx: DrivesFixture;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('m7c4', { routes: [{ path: '/api/agent-plans', app: agentPlanRoutes }, { path: '/api/agent', app: agentRoutes }] });
  await ensureDeftyMembership(fx.orgId);
});

after(async () => {
  if (skip) return;
  if (fx) {
    for (const table of ['attention_events', 'attention_items', 'action_receipts', 'agent_action_approvers', 'agent_actions', 'agent_plans', 'job_queue', 'messages']) {
      await fx.client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [[fx.orgId, fx.otherOrgId]]);
    }
    await fx.teardown();
  }
  await closeDb();
});

const text = (value: unknown) => JSON.stringify(value) ?? '';
const token = (label: string) => `m7c4${label}${run}`;
const paragraph = (id: string, body: string) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: body }] });

test('a completed plan step keeps document references only: the creator who lost the document sees no content', { skip }, async () => {
  const { member } = fx.people;
  await fx.client.query('UPDATE orgs SET trust_level = $1 WHERE id = $2', ['standard', fx.orgId]);
  const phrase = token('plan');
  const title = `Plan source ${token('title')}`;
  const drive = await fx.insertDrive({ kind: 'private', name: 'M7 C4 private' });
  // Block ids are references (kept); the text is not.
  const doc = await fx.insertDocument({ driveId: drive, title, json: { type: 'doc', content: [paragraph(`c4p-${run}`, `The plan says ${phrase}`)] } });
  await fx.share(doc, { user: member }, 'view');
  const notePhrase = token('note');
  const dm = (await ensureDeftyDm(fx.orgId, member))!;
  // A private DM: the reads are not held to anyone, so the full text reaches the step.
  const { plan_id: planId } = await createPlanRow({
    org_id: fx.orgId, user_id: member, conversation_id: dm, title: 'Read and note',
    steps: [
      { id: 'read', description: 'Read the plan', tool: 'read_document', params: { document_id: doc } },
      { id: 'search', description: 'Search for it', tool: 'search_documents', params: { query: phrase } },
      // Fix round 1 (I2): document text reaches a write step only by reference, resolved when it runs.
      { id: 'note', description: 'Note it', tool: 'create_note', params: { title: '$step.read.result.title', content: '$step.read.result.markdown' } },
    ],
  });
  await fx.client.query(`UPDATE agent_plans SET status = 'approved' WHERE id = $1`, [planId]);
  await executePlan(planId, fx.orgId, member);

  const { rows: [plan] } = await fx.client.query('SELECT status, steps, context FROM agent_plans WHERE id = $1', [planId]);
  assert.equal(plan.status, 'completed', text(plan));
  for (const leaked of [phrase, notePhrase, token('title')]) assert.ok(!text(plan).includes(leaked), `the plan row keeps no ${leaked}`);
  const steps = new Map(plan.steps.map((step: any) => [step.id, step]));
  const read = steps.get('read') as any;
  assert.equal(read.status, 'completed');
  assert.deepEqual(read.params, { document_id: doc });
  assert.equal(read.result.document_id, doc);
  assert.equal(read.result.withheld, false);
  assert.deepEqual(plan.context.read, { result: read.result });
  assert.equal((steps.get('search') as any).params.query_omitted, true);
  const note = steps.get('note') as any;
  assert.equal(note.status, 'completed');
  assert.equal(note.params.content.content_omitted, true);
  assert.equal(typeof note.result.document_id, 'string');
  // The note was made from what the read returned in this run, as the creator.
  const { rows: [made] } = await fx.client.query('SELECT created_by, content_text FROM documents WHERE id = $1', [note.result.document_id]);
  assert.equal(made.created_by, member);
  assert.ok(made.content_text.includes(phrase));

  // The creator loses the document; the plan shows no content.
  await fx.client.query('DELETE FROM document_shares WHERE document_id = $1', [doc]);
  const response = await fx.request(member, 'GET', `/api/agent-plans/${planId}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  for (const leaked of [phrase, notePhrase, token('title')]) assert.ok(!body.includes(leaked), `GET shows no ${leaked}`);

  // A plan stored before this rule (its completed read kept the text) is read back as references.
  const oldPhrase = token('old');
  const { rows: [old] } = await fx.client.query(`INSERT INTO agent_plans (id, org_id, user_id, conversation_id, title, steps, status, context)
    VALUES ($1, $2, $3, $4, 'Old plan', $5::jsonb, 'completed', $6::jsonb) RETURNING id`, [randomUUID(), fx.orgId, member, dm,
    JSON.stringify([{ id: 'r', description: 'Read', tool: 'read_note', status: 'completed', params: { note_id: doc },
      result: { id: doc, document_id: doc, title, content: oldPhrase, url: `/d/${doc}` } }]),
    JSON.stringify({ r: { result: { id: doc, document_id: doc, title, content: oldPhrase } } })]);
  for (const path of [`/api/agent-plans/${old.id}`, '/api/agent-plans']) {
    const listed = await fx.request(member, 'GET', path);
    assert.equal(listed.status, 200, path);
    const shown = await listed.text();
    assert.ok(shown.includes(old.id), path);
    assert.ok(!shown.includes(oldPhrase) && !shown.includes(token('title')), `${path} shows no content of the old plan`);
  }
});

test('fix round 2: a plan makes documents from its literal text across a resume; a read\'s text is never stored, and no literal outlives its step', { skip }, async () => {
  const { member, member2 } = fx.people;
  // Conservative: a step later steps depend on waits for its own approval (a leaf step of the approved plan runs).
  await fx.client.query('UPDATE orgs SET trust_level = $1 WHERE id = $2', ['conservative', fx.orgId]);
  const drive = await fx.insertDrive({ kind: 'private', name: 'M7 C4 literals' });
  const phrase = token('status');
  const doc = await fx.insertDocument({ driveId: drive, title: `Status source ${token('stitle')}`,
    json: { type: 'doc', content: [paragraph(`c4s-${run}`, `Source says ${phrase}`)] } });
  await fx.share(doc, { user: member }, 'view');
  const literal = token('literal');
  const skipped = token('skipped');
  const smuggled = token('smuggled');
  const dm = (await ensureDeftyDm(fx.orgId, member))!;
  const { plan_id: planId } = await createPlanRow({
    org_id: fx.orgId, user_id: member, conversation_id: dm, title: 'Literal plan',
    steps: [
      { id: 'read', description: 'Read', tool: 'read_document', params: { document_id: doc, smuggled } },
      { id: 'never', description: 'Skipped', tool: 'create_note', params: { title: 'Never', content: `<p>${skipped}</p>` },
        condition: { field: '$step.read.result.withheld', operator: 'eq', value: true } },
      // A dependency: it waits for its own approval, so the plan pauses and resumes in a new run.
      { id: 'copy', description: 'Copy', tool: 'create_document', params: { title: `Copy ${literal}`, markdown: `# ${literal}` } },
      // In the next run: a literal title, and the read's text read again as the creator.
      { id: 'note', description: 'Note', tool: 'create_note', depends_on: ['copy'],
        params: { title: `Note ${literal}`, content: '$step.read.result.markdown' } },
      { id: 'final', description: 'Final', tool: 'create_document', params: { title: `Final ${literal}`, markdown: `Closing ${literal}` } },
    ],
  });
  const stored = async () => (await fx.client.query('SELECT status, error, steps, context FROM agent_plans WHERE id = $1', [planId])).rows[0];
  const docText = [phrase, token('stitle')];
  // The draft keeps the literals written for it (like a pending draft) and nothing else.
  const draft = await stored();
  const draftSteps = new Map(draft.steps.map((step: any) => [step.id, step]));
  assert.equal((draftSteps.get('copy') as any).params.title, `Copy ${literal}`);
  assert.equal((draftSteps.get('note') as any).params.content, '$step.read.result.markdown');
  assert.deepEqual((draftSteps.get('read') as any).params, { document_id: doc });
  for (const leaked of [...docText, smuggled]) assert.ok(!text(draft).includes(leaked), `the draft keeps no ${leaked}`);
  // Shown to its creator; to nobody else in the room.
  const mine = await fx.request(member, 'GET', `/api/agent-plans/${planId}`);
  assert.ok((await mine.text()).includes(literal), 'its creator sees the literal');
  assert.equal((await fx.request(member2, 'GET', `/api/agent-plans/${planId}`)).status, 404);
  assert.ok(!(await (await fx.request(member2, 'GET', '/api/agent-plans')).text()).includes(literal));

  // Run 1: the read completes, the conditional step is skipped, the copy waits for approval.
  await fx.client.query(`UPDATE agent_plans SET status = 'approved' WHERE id = $1`, [planId]);
  await executePlan(planId, fx.orgId, member);
  const paused = await stored();
  assert.equal(paused.status, 'paused', text(paused));
  assert.deepEqual(Object.fromEntries(paused.steps.map((step: any) => [step.id, step.status])),
    { read: 'completed', never: 'skipped', copy: 'waiting_approval', note: 'pending', final: 'pending' });
  for (const leaked of docText) assert.ok(!text(paused).includes(leaked), `the paused plan keeps no ${leaked}`);
  const { rows: [copyAction] } = await fx.client.query(`SELECT id, approval_status FROM agent_actions WHERE org_id = $1 AND plan_id = $2 AND plan_step_id = 'copy'`,
    [fx.orgId, planId]);
  assert.equal(copyAction.approval_status, 'pending');

  // Approved, then resumed: a new run.
  const approved = await fx.request(member, 'POST', `/api/agent/actions/${copyAction.id}/approve`, {});
  assert.ok(approved.status < 300, await approved.clone().text());
  const resumed = await fx.request(member, 'POST', `/api/agent-plans/${planId}/resume`, {});
  assert.equal(resumed.status, 200, await resumed.clone().text());
  await executePlan(planId, fx.orgId, member);

  const done = await stored();
  assert.equal(done.status, 'completed', text(done));
  for (const leaked of [literal, skipped, ...docText]) assert.ok(!text(done).includes(leaked), `the completed plan keeps no ${leaked}`);
  const byId = new Map(done.steps.map((step: any) => [step.id, step]));
  for (const id of ['copy', 'note', 'final']) {
    const step = byId.get(id) as any;
    assert.equal(step.status, 'completed', id);
    assert.equal(typeof step.result.document_id, 'string', `${id} names what it made`);
  }
  const made = async (id: string) => (await fx.client.query('SELECT title, created_by, content_text FROM documents WHERE id = $1',
    [(byId.get(id) as any).result.document_id])).rows[0];
  assert.equal((await made('copy')).title, `Copy ${literal}`);
  assert.equal((await made('final')).title, `Final ${literal}`);
  const note = await made('note');
  assert.equal(note.created_by, member);
  assert.ok(note.content_text.includes(phrase), 'the note was made from the read, read again as the creator');
  const shown = await (await fx.request(member, 'GET', `/api/agent-plans/${planId}`)).text();
  for (const leaked of [literal, ...docText]) assert.ok(!shown.includes(leaked), `the creator sees no ${leaked} once it ran`);
  await fx.client.query('UPDATE orgs SET trust_level = $1 WHERE id = $2', ['standard', fx.orgId]);
});

test('fix round 2 (I2): every step and the plan\'s context are shown from the allowlist, whatever the status or the marks, legacy rows included', { skip }, async () => {
  const { member } = fx.people;
  const dm = (await ensureDeftyDm(fx.orgId, member))!;
  const doc = randomUUID();
  const title = `Legacy ${token('ltitle')}`;
  const markdown = `Legacy body ${token('lbody')}`;
  const leaks = [token('ltitle'), token('lbody')];
  const insert = async (status: string, steps: unknown[], context: unknown) => (await fx.client.query(`INSERT INTO agent_plans
    (id, org_id, user_id, conversation_id, title, steps, status, context) VALUES ($1, $2, $3, $4, 'Legacy plan', $5::jsonb, $6, $7::jsonb) RETURNING id`,
  [randomUUID(), fx.orgId, member, dm, JSON.stringify(steps), status, JSON.stringify(context)])).rows[0].id as string;

  // The tester's case: a read in running, failed or skipped, its text kept in the plan's context.
  for (const stepStatus of ['running', 'failed', 'skipped']) {
    const id = await insert('paused', [{ id: 'r', description: 'Read', tool: 'read_document', status: stepStatus, params: { document_id: doc } }],
      { r: { result: { document_id: doc, title, markdown } } });
    const response = await fx.request(member, 'GET', `/api/agent-plans/${id}`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    for (const leaked of leaks) assert.ok(!text(body).includes(leaked), `${stepStatus}: the payload shows no ${leaked}`);
    assert.equal(body.context.r.result.document_id, doc, `${stepStatus}: the context keeps the reference`);
  }

  // A completed step marked as kept that still held its text (rows written before the rule): rebuilt anyway.
  const marked = await insert('completed', [
    { id: 'n', description: 'Note', tool: 'create_note', status: 'completed', content_omitted: true,
      params: { title, content: markdown }, result: { note_id: doc, document_id: doc, title } },
    { id: 'r', description: 'Read', tool: 'read_document', status: 'completed', content_omitted: true,
      params: { document_id: doc }, result: { document_id: doc, title, markdown, withheld: false } },
  ], { n: { result: { document_id: doc, title } }, r: { result: { document_id: doc, title, markdown } } });
  const shown = await (await fx.request(member, 'GET', `/api/agent-plans/${marked}`)).json() as any;
  for (const leaked of leaks) assert.ok(!text(shown).includes(leaked), `a marked step shows no ${leaked}: ${text(shown)}`);
  assert.equal(shown.steps[0].result.document_id, doc);
  assert.equal(shown.steps[1].result.document_id, doc);

  // A plan that ended shows no literal, even to its creator.
  const ended = await insert('failed', ['pending', 'running', 'waiting_approval', 'failed', 'skipped'].map((status) => ({
    id: status, description: status, tool: 'create_note', status, params: { title, content: markdown },
  })), {});
  const endedText = await (await fx.request(member, 'GET', `/api/agent-plans/${ended}`)).text();
  assert.ok(endedText.includes(ended));
  for (const leaked of leaks) assert.ok(!endedText.includes(leaked), `an ended plan shows no ${leaked}`);
});

test('an MCP note tool\'s replay never serves stored content: it reads the note again with the caller\'s access now', { skip }, async () => {
  const { member } = fx.people;
  const ctx: HumanToolContext = { org_id: fx.orgId, user_id: member, role: 'member', scopes: ['read:workspace', 'write:workspace'], client_id: `m7c4-${run}` };
  const drive = await fx.insertDrive({ kind: 'private', name: 'M7 C4 MCP' });
  const title = `MCP note ${token('mcptitle')}`;
  const doc = await fx.insertDocument({ driveId: drive, title, json: { type: 'doc', content: [paragraph(`${run}-m`, 'Before')] } });
  await fx.share(doc, { user: member }, 'edit');
  const phrase = token('update');
  const args = { note_id: doc, content: `<p>${phrase}</p>`, idempotency_key: `m7c4-update-${run}` };
  const first = await humanNoteUpdate(args, ctx);
  assert.notEqual(first.isError, true, text(first));
  assert.ok(text(first).includes(phrase), 'the caller gets the note as it is now');

  const stored = async () => (await fx.client.query(`SELECT id, metadata FROM oauth_audit_events WHERE org_id = $1 AND user_id = $2
    AND event = 'mcp_idempotency_result' AND metadata->>'idempotency_key' = $3`, [fx.orgId, member, args.idempotency_key])).rows;
  const [row, ...more] = await stored();
  assert.equal(more.length, 0);
  assert.ok(!text(row.metadata).includes(phrase) && !text(row.metadata).includes(token('mcptitle')), 'the stored answer keeps references only');
  assert.ok(text(row.metadata).includes(doc), 'it names the document');

  // A replay while the caller can still open it reads it again.
  const again = await humanNoteUpdate(args, ctx);
  assert.ok(text(again).includes(phrase), 'a replay with access reads the note as it is now');

  // After the caller loses the document, a replay tells nothing of it.
  await fx.client.query('DELETE FROM document_shares WHERE document_id = $1', [doc]);
  const lost = await humanNoteUpdate(args, ctx);
  assert.ok(!text(lost).includes(phrase) && !text(lost).includes(token('mcptitle')), text(lost));
  assert.ok(text(lost).includes(doc));
  // A row stored before this rule (it kept the note) is not served either.
  await fx.client.query(`UPDATE oauth_audit_events SET metadata = jsonb_set(metadata, '{result}', $2::jsonb) WHERE id = $1`, [row.id,
    JSON.stringify(first)]);
  const legacy = await humanNoteUpdate(args, ctx);
  assert.ok(!text(legacy).includes(phrase) && !text(legacy).includes(token('mcptitle')), text(legacy));

  // note_create: stored as references; its replay still finds the same note.
  const createPhrase = token('create');
  const createArgs = { title: `Created ${createPhrase}`, content: `<p>${createPhrase}</p>`, idempotency_key: `m7c4-create-${run}` };
  const created = JSON.parse((await humanNoteCreate(createArgs, ctx)).content[0]!.text);
  const { rows: [createdRow] } = await fx.client.query(`SELECT metadata FROM oauth_audit_events WHERE org_id = $1 AND user_id = $2
    AND event = 'mcp_idempotency_result' AND metadata->>'idempotency_key' = $3`, [fx.orgId, member, createArgs.idempotency_key]);
  assert.ok(!text(createdRow.metadata).includes(createPhrase), 'the stored create keeps references only');
  const replayed = JSON.parse((await humanNoteCreate(createArgs, ctx)).content[0]!.text);
  assert.equal(replayed.note.id, created.note.id);
  assert.equal(replayed.document_id, created.document_id);
});
