/**
 * M7's rule C4 carry-forwards (the F15 and M3 reviews): document text from
 * Defty's and the MCP note tools is shown only to people who can open the
 * document now.
 *
 * - Plan steps: a completed step of a document tool keeps references only,
 *   in its params, its result and the plan's context, so a plan's creator who
 *   loses the document sees none of it (a plan stored before keeps none
 *   either: completed steps are read back as references).
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
import { agentPlanRoutes } from '../src/routes/agent-plans.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const skip = !url;
const run = randomUUID().replace(/-/g, '').slice(0, 10);
let fx: DrivesFixture;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('m7c4', { routes: [{ path: '/api/agent-plans', app: agentPlanRoutes }] });
  await ensureDeftyMembership(fx.orgId);
});

after(async () => {
  if (skip) return;
  if (fx) {
    for (const table of ['action_receipts', 'agent_actions', 'agent_plans', 'job_queue', 'messages']) {
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
      { id: 'note', description: 'Note it', tool: 'create_note', params: { title: 'Plan note', content: `<p>${notePhrase}</p>` } },
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
