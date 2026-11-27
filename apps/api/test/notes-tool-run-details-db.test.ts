/**
 * F15 fix round 2 (B-I1, at write time): a background run that executes
 * create_note records the call without its content wherever the run keeps
 * it: the assistant blocks a caller stores as a message's `agent_blocks`,
 * and the executed actions. So the run details an owner or admin receives
 * (lib/agent-message-run-details.ts) hold no copy of a note they can't open.
 *
 * The model is a stub (agent-llm's createAgentMessage); the action runs for
 * real against a disposable DB:
 *   pnpm --filter @deft/api test test/notes-tool-run-details-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

let nextResponses: Array<{ content: any[]; stop_reason: string }> = [];

const actualLlm = await import('../src/lib/agent-llm.js');
mock.module(new URL('../src/lib/agent-llm.ts', import.meta.url).href, { namedExports: {
  ...actualLlm,
  createAgentMessage: async () => {
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
const { agentRunDetailAudience, projectAgentMessageMetadata } = await import('../src/lib/agent-message-run-details.js');
const { documentRoleFor } = await import('../src/lib/document-access.js');
const { ensureDeftyMembership } = await import('../src/lib/ensure-defty-membership.js');
const { closeDb } = await import('../src/lib/db.js');

const url = safeTestDatabaseUrl();
const skip = !url;
let fx: DrivesFixture;
let deftyId: string;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('f15r2');
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

test('a background run that executes create_note stores no content in its run details, so an admin who can\'t open the note sees none', { skip }, async () => {
  const { member, admin } = fx.people;
  const phrase = `f15r2secret${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const input = { title: 'Background note', content: `<p>${phrase} written in the background</p>` };
  nextResponses = [{ content: [{ type: 'text', text: 'Saving it.' }, { type: 'tool_use', id: 'toolu_bg_note', name: 'create_note', input }], stop_reason: 'tool_use' }];

  const result = await runAgentQuery({
    content: 'Save a note with the launch plan.',
    orgId: fx.orgId,
    userId: member,
    orgName: 'Run details org',
    mode: 'background',
    trustLevelOverride: 'autonomous',
    skipVerification: true,
    durableNotes: false,
    maxIterations: 1,
    systemPromptOverride: 'Save notes when asked.',
  });

  const executed = result.executedActions.find((action: any) => action.action === 'create_note');
  assert.ok(executed, 'the run executed create_note');
  assert.equal(executed.success, true, executed.error);
  const documentId = executed.result.document_id as string;
  assert.ok(documentId);
  assert.deepEqual(executed.params.content, { document_id: documentId, content_omitted: true, content_bytes: Buffer.byteLength(input.content) });
  assert.ok(!JSON.stringify(result.executedActions).includes(phrase), 'the executed actions keep no copy');
  const toolUse = (result.assistantBlocks ?? []).find((block: any) => block.type === 'tool_use') as any;
  assert.equal(toolUse?.input?.content?.content_omitted, true, 'the stored tool call names the document');
  assert.ok(!JSON.stringify(result.assistantBlocks).includes(phrase), 'the assistant blocks keep no copy');
  // The stored action keeps none either.
  const { rows: actions } = await fx.client.query('SELECT params FROM agent_actions WHERE org_id = $1 AND action = $2', [fx.orgId, 'create_note']);
  assert.equal(actions.length, 1);
  assert.ok(!JSON.stringify(actions[0].params).includes(phrase));

  // The reply as a caller stores it (agent-reply.ts: agent_blocks from the run), answering the member's request.
  const requestId = randomUUID();
  const replyId = randomUUID();
  await fx.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [requestId, fx.orgId, fx.spaces.team, member, '<p>Save a note with the launch plan.</p>']);
  const metadata = { is_agent_reply: true, reply_to_message_id: requestId, agent_blocks: result.assistantBlocks };
  await fx.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [replyId, fx.orgId, fx.spaces.team, deftyId, '<p>Saving it.</p>', JSON.stringify(metadata)]);
  const { rows: [stored] } = await fx.client.query('SELECT user_id, space_id, metadata FROM messages WHERE id = $1', [replyId]);

  // An admin receives the run details, and can't open the note: nothing of its content is in them.
  assert.equal(await documentRoleFor(admin, fx.orgId, documentId), null, 'the admin was never given the note');
  const audience = await agentRunDetailAudience({ id: admin, org_id: fx.orgId, role: 'admin' }, [{ id: replyId, ...stored }]);
  assert.ok(audience.has(replyId), 'the admin is in the run-detail audience');
  const shown = projectAgentMessageMetadata(stored.metadata, true);
  assert.ok(JSON.stringify(shown).includes('content_omitted'));
  assert.ok(!JSON.stringify(shown).includes(phrase), 'the admin sees no content');
});
