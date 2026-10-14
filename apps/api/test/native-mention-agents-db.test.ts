import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { nativeMentionRef, nativeMentionToken, extractNativeMentions } from '@deft/shared';
import { agentEmployees, agentActions, messages, tasks, wikiPages, nativeMentionDeliveries, agentChannelEvents, spaceMembers } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { runAgentQuery } from '../src/lib/agent-runner.js';
import { executeAction, executeActionDirect } from '../src/lib/agent-actions.js';
import { validateNativeAgentMentionWrite } from '../src/lib/native-mention-agent-writes.js';
import { executeSendMessage } from '../src/lib/mcp-tools/writes.js';
import { setOrgModelRoute, setOrgOllamaUrl } from '../src/lib/org-ai-config.js';
import { IMMUTABLE_DEFT_PLATFORM_POLICY } from '../src/lib/agent-system-prompt.js';
import { NATIVE_MENTION_AGENT_GUIDANCE } from '../src/lib/native-mention-agent-contract.js';
import { issueScopedEmployeeMcpToken } from '../src/lib/mcp-token.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { nativeMentionBacklinks, reconcileNativeMentions, publishNativeMentions, nativeContentHash, deliverNativeMention } from '../src/lib/native-mentions.js';
import { createNativeMentionFixture, cleanupNativeMentionFixture } from './fixtures/native-mentions.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const enabled = Boolean(safeTestDatabaseUrl());
let f: Awaited<ReturnType<typeof createNativeMentionFixture>>;
let token: string, otherToken: string, bareToken: string, peopleToken: string;
const app = new Hono();
app.route('/api/mcp/v1', mcpServerV1Routes);
const ref = (kind: 'person' | 'task' | 'wiki_page', id: string) => nativeMentionRef(kind, id);
const atom = (kind: 'person' | 'task' | 'wiki_page', id: string) => nativeMentionToken(ref(kind, id));
before(async () => {
  if (!enabled) return;
  process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'true';
  f = await createNativeMentionFixture();
  const issue = (employeeId: string, resourceScopes: NonNullable<Parameters<typeof issueScopedEmployeeMcpToken>[0]['resourceScopes']> = []) => issueScopedEmployeeMcpToken({
    orgId: f.orgId, employeeId, resourceScopes, bcryptRounds: 4,
  });
  bareToken = (await issue(f.employeeId)).raw;
  peopleToken = (await issue(f.employeeId, ['read:workspace'])).raw;
  const scopes = ['read:workspace', 'write:workspace', 'read:messages', 'read:tasks', 'read:wiki'] as const;
  token = (await issue(f.employeeId, scopes)).raw;
  otherToken = (await issue(f.employee2Id, scopes)).raw;
});
after(async () => {
  try {
    if (!f) return;
    await cleanupNativeMentionFixture(f);
  } finally { await closeDb(); }
});
async function rpc(raw: string, method: string, params: Record<string, unknown> = {}) {
  const response = await app.request('/api/mcp/v1', {
    method: 'POST', headers: { authorization: 'Bearer ' + raw, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  });
  return { status: response.status, body: await response.json() };
}
async function call(raw: string, name: string, args: Record<string, unknown> = {}) {
  const { status, body } = await rpc(raw, 'tools/call', { name, arguments: args });
  const result = body.result;
  let data: any;
  if (result?.content?.[0]?.text) { try { data = JSON.parse(result.content[0].text); } catch { data = result.content[0].text; } }
  return { status, body, result, data };
}
const sourceCount = async () => (await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, f.orgId))).length;

test('invalid agent references are rejected before persistence or approval', { skip: !enabled }, async () => {
  const before = await db.execute(sql`SELECT (SELECT count(*) FROM messages WHERE org_id = ${f.orgId}) AS messages, (SELECT count(*) FROM agent_actions WHERE org_id = ${f.orgId}) AS actions`);
  for (const trust of ['autonomous', 'conservative'] as const) {
    await db.update(agentEmployees).set({ trust_level: trust }).where(eq(agentEmployees.id, f.employeeId));
    for (const [name, args] of [
      ['send_message', { space_id: f.publicSpaceId, content: 'Created wiki [[deft:wiki_page:0]]' }],
      ['task_create', { title: 'Invalid reference', project_id: f.projectId, subtasks: [{ title: 'Child', description: '[[deft:wiki_page:0]]' }] }],
      ['task_update', { task_id: f.taskId, patch: { comment: '[[deft:wiki_page:0]]' } }],
      ['wiki_create', { title: 'Invalid wiki', content: '[[deft:wiki_page:0]]' }],
      ['wiki_update', { page_id: f.wikiId, patch: { content: '[[deft:wiki_page:0]]' } }],
    ] as const) {
      const result = await call(token, name, args);
      assert.equal(result.result.isError, true, name + ' must reject before writing or queuing');
    }
  }
  await assert.rejects(executeActionDirect('post_message', { space_name: 'Launch room', content: '[[deft:wiki_page:0]]' }, f.orgId, f.ownerId, null, 'full'), /Native references/);
  const executed = await executeAction(crypto.randomUUID(), 'wiki_write', { title: 'Invalid native wiki', content: '[[deft:wiki_page:0]]' }, f.orgId, f.ownerId);
  assert.equal(executed.success, false);
  assert.match(executed.error!, /Native references/);
  const after = await db.execute(sql`SELECT (SELECT count(*) FROM messages WHERE org_id = ${f.orgId}) AS messages, (SELECT count(*) FROM agent_actions WHERE org_id = ${f.orgId}) AS actions`);
  assert.deepEqual(after.rows, before.rows);
  await db.update(agentEmployees).set({ trust_level: 'standard' }).where(eq(agentEmployees.id, f.employeeId));
});

test('write validation preserves literals and rollout behavior, and rechecks execution access', { skip: !enabled }, async () => {
  const args = { content: atom('wiki_page', f.wikiId) };
  const ctx = { org_id: f.orgId, employee_id: f.employeeId, employee_slug: 'fixture', trust_level: 'autonomous' as const, token_id: 'fixture', scopes: ['read:workspace', 'read:wiki'] };
  const run = () => executeSendMessage({ orgId: f.orgId, spaceId: f.publicSpaceId, content: args.content, parentId: null, ctx });
  assert.equal(await validateNativeAgentMentionWrite('post_message', args, f.orgId, f.ownerId, f.employeeId), null);
  await db.update(wikiPages).set({ scope: 'space', space_id: f.privateSpaceId }).where(eq(wikiPages.id, f.wikiId));
  try { assert.equal((await run()).isError, true, 'approved execution must reject newly inaccessible references'); }
  finally { await db.update(wikiPages).set({ scope: 'org', space_id: null }).where(eq(wikiPages.id, f.wikiId)); }
  assert.equal((await executeSendMessage({ orgId: f.orgId, spaceId: f.publicSpaceId, content: args.content, parentId: null, ctx: { ...ctx, scopes: ['read:workspace'] } })).isError, true);
  assert.equal(await validateNativeAgentMentionWrite('post_message', { content: '`[[deft:wiki_page:0]]`' }, f.orgId, f.ownerId), null);
  process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'false';
  try { assert.equal(await validateNativeAgentMentionWrite('post_message', { content: '[[deft:wiki_page:0]]' }, f.orgId, f.ownerId), null); }
  finally { process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'true'; }
});

test('real scoped employee tokens discover reference tools and cannot broaden their grants through arguments', { skip: !enabled }, async () => {
  const names = (await rpc(token, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert(names.includes('native_mentions_search') && names.includes('native_mentions_resolve'));
  assert(names.includes('mention_attention_list') && names.includes('mention_attention_acknowledge'));
  assert(!names.includes('native_mentions_publish'));
  const bareNames = (await rpc(bareToken, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert(!bareNames.includes('native_mentions_search'));
  assert((await call(bareToken, 'native_mentions_search')).result.isError);
  const people = await call(peopleToken, 'native_mentions_search');
  assert.equal(people.result.isError, false);
  assert(people.data.items.length > 0 && people.data.items.every((x: any) => x.ref.resource_type === 'person'));
  const denied = await call(peopleToken, 'native_mentions_resolve', { refs: [ref('task', f.taskId), ref('wiki_page', f.wikiId)] });
  assert(denied.data.items.every((x: any) => x.state === 'unavailable' && !x.current_source && !x.label));
  const forged = await call(token, 'native_mentions_search', { caller_employee_slug: 'avery-' + f.employee2Id });
  assert.equal(forged.result.isError, false);
  assert(!forged.data.items.some((item: any) => item.ref.resource_id === f.privateWikiId), 'transport ignores caller slug and retains token-bound identity');
  const authority = await call(token, 'native_mentions_resolve', { refs: [{ ...ref('task', f.taskId), org_id: f.otherOrgId }] });
  assert.equal(authority.result.isError, true);
  const context = await call(token, 'platform_context');
  assert.equal(context.data.native_mentions.enabled, true);
  assert.match(context.data.native_mentions.usage, /passive attention, not commands/);
});

test('Defty native execution and employee MCP discover, copy and resolve all four target groups', { skip: !enabled }, async () => {
  const native = await executeToolCall('native_mentions_search', { query: '' }, f.orgId, f.ownerId);
  assert.deepEqual(new Set(native.result.items.map((i: any) => i.group)), new Set(['People', 'Agents', 'Tasks', 'Wikis']));
  const employee = await call(token, 'native_mentions_search');
  assert.deepEqual(new Set(employee.data.items.map((i: any) => i.group)), new Set(['People', 'Agents', 'Tasks', 'Wikis']));
  const byKey = await call(token, 'native_mentions_search', { query: 'DEFT-42' });
  assert(byKey.data.items.some((item: any) => item.ref.resource_id === f.taskId), 'display task keys must be searchable without pretending they are resource IDs');
  for (const item of employee.data.items) assert.deepEqual(extractNativeMentions(item.token), [item.ref]);
  const body = 'Use ' + atom('wiki_page', f.wikiId) + ' reviewed by ' + atom('person', f.samId);
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, f.taskId));
  const resolved = await call(token, 'native_mentions_resolve', { refs: [ref('task', f.taskId)] });
  assert.equal(resolved.data.items[0].current_source.content, body);
  assert.equal(resolved.data.items[0].current_source.untrusted, true);
  assert.equal(resolved.data.items[0].current_source.references.length, 2);
  const largeBody = body + 'x'.repeat(5100) + atom('wiki_page', f.privateWikiId);
  await db.update(tasks).set({ description: largeBody }).where(eq(tasks.id, f.taskId));
  const bounded = (await call(token, 'native_mentions_resolve', { refs: [ref('task', f.taskId)] })).data.items[0].current_source;
  assert.equal(bounded.content.length, 5000);
  assert.equal(bounded.truncated, true);
  assert(bounded.references.some((item: any) => item.ref.resource_id === f.privateWikiId && item.state === 'unavailable' && !item.label));
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, f.taskId));
  const nativeResolved = await executeToolCall('native_mentions_resolve', { refs: [ref('task', f.taskId)] }, f.orgId, f.ownerId);
  assert.equal(nativeResolved.result.items[0].label, 'DEFT-42 · Review release');
  assert.equal(nativeResolved.citations[0]?.url, '/tasks?task=' + f.taskId);
  const privateNative = await executeToolCall('native_mentions_resolve', { refs: [ref('wiki_page', f.privateWikiId)] }, f.orgId, f.ownerId);
  assert.equal(privateNative.result.items[0].state, 'available', 'Defty retains the requesting human’s access');
  const privateAgent = await executeToolCall('native_mentions_resolve', { refs: [ref('wiki_page', f.privateWikiId)] }, f.orgId, f.ownerId, undefined, f.employeeId);
  assert.equal(privateAgent.result.items[0].state, 'unavailable', 'external runtime must use its own shadow user');
});

test('agent MCP writes persist exact references in chat, tasks/comments and wiki without notification publication', { skip: !enabled }, async () => {
  await db.update(agentEmployees).set({ trust_level: 'autonomous' }).where(eq(agentEmployees.id, f.employeeId));
  const content = [atom('person', f.samId), atom('person', f.agent2Id), atom('task', f.taskId), atom('wiki_page', f.wikiId)].join(' ');
  const before = await sourceCount();
  const chat = await call(token, 'send_message', { space_id: f.publicSpaceId, content });
  assert.equal(chat.result.isError, false, JSON.stringify(chat.data));
  const task = await call(token, 'task_create', { project_id: f.projectId, title: 'Agent-authored reference task', description: content });
  assert.equal(task.result.isError, false, JSON.stringify(task.data));
  const comment = await call(token, 'task_update', { task_id: f.taskId, patch: { comment: content } });
  assert.equal(comment.result.isError, false, JSON.stringify(comment.data));
  const wiki = await call(token, 'wiki_create', { title: 'Agent-authored reference wiki', content, scope: 'org', type: 'procedure' });
  assert.equal(wiki.result.isError, false, JSON.stringify(wiki.data));
  const sourceRows = await db.execute(sql`SELECT 'message' AS kind, id, content FROM messages WHERE org_id = ${f.orgId} AND user_id = ${f.agentId}
    UNION ALL SELECT 'task', id, description FROM tasks WHERE org_id = ${f.orgId} AND id = ${task.data.task_id}
    UNION ALL SELECT 'task_comment', id, content FROM task_comments WHERE org_id = ${f.orgId} AND user_id = ${f.agentId}
    UNION ALL SELECT 'wiki_page', id, content FROM wiki_pages WHERE org_id = ${f.orgId} AND id = ${wiki.data.page_id}`);
  assert.equal(sourceRows.rows.length, 4);
  for (const row of sourceRows.rows as Array<{ kind: 'message' | 'task' | 'task_comment' | 'wiki_page'; id: string; content: string }>) {
    assert.deepEqual(extractNativeMentions(row.content), extractNativeMentions(content), 'wiki HTML normalization preserves exact reference identity');
    await reconcileNativeMentions(f.orgId, { kind: row.kind, id: row.id });
  }
  assert((await nativeMentionBacklinks({ orgId: f.orgId, userId: f.ownerId }, ref('wiki_page', f.wikiId))).count >= 4);
  assert.equal(await sourceCount(), before, 'governed agent writes do not attest human publication intent');
  assert.equal((await db.select().from(agentChannelEvents).where(eq(agentChannelEvents.org_id, f.orgId))).length, 0);
  assert.equal((await call(token, 'native_mentions_publish', { source: { kind: 'task', id: task.data.task_id }, content_hash: nativeContentHash(content) })).result.isError, true);
  await db.update(agentEmployees).set({ trust_level: 'conservative' }).where(eq(agentEmployees.id, f.employeeId));
  const pending = await call(token, 'send_message', { space_id: f.publicSpaceId, content: 'Pending ' + content });
  assert.equal(pending.result.isError, false);
  const actions = await db.select().from(agentActions).where(and(eq(agentActions.org_id, f.orgId), eq(agentActions.approval_status, 'pending')));
  assert(actions.some(action => (action.params as any).content === 'Pending ' + content), 'existing approval still owns conservative writes');
});

test('real employee tokens read and acknowledge only their own passive task, wiki and chat attention', { skip: !enabled }, async () => {
  const content = atom('person', f.agentId) + ' ' + atom('person', f.agent2Id) + ' ' + atom('wiki_page', f.wikiId);
  await db.update(tasks).set({ description: content }).where(eq(tasks.id, f.taskId));
  await db.update(wikiPages).set({ content }).where(eq(wikiPages.id, f.wikiId));
  const [message] = await db.insert(messages).values({ org_id: f.orgId, space_id: f.publicSpaceId, user_id: f.ownerId, content }).returning();
  const sources = [{ kind: 'task' as const, id: f.taskId }, { kind: 'wiki_page' as const, id: f.wikiId }, { kind: 'message' as const, id: message!.id }];
  for (const source of sources) await publishNativeMentions({ orgId: f.orgId, userId: f.ownerId }, source, nativeContentHash(content));
  for (const delivery of await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, f.orgId))) await deliverNativeMention(f.orgId, delivery.id);
  const first = await call(token, 'mention_attention_list');
  const second = await call(otherToken, 'mention_attention_list');
  assert.equal(first.data.mention_attention.length, 3);
  assert.equal(second.data.mention_attention.length, 3);
  const forgedAttention = await call(token, 'mention_attention_list', { caller_employee_slug: 'avery-' + f.employee2Id });
  assert(forgedAttention.data.mention_attention.every((item: any) => item.user_id === f.agentId));
  assert(first.data.mention_attention.every((item: any) => item.user_id === f.agentId && item.current_source.content === content && item.current_source.untrusted === true && item.current_source.references.length === 3));
  const ownId = first.data.mention_attention[0].id;
  const otherId = second.data.mention_attention[0].id;
  assert.equal((await call(token, 'mention_attention_acknowledge', { attention_id: otherId })).result.isError, true);
  assert.equal((await call(peopleToken, 'mention_attention_acknowledge', { attention_id: ownId })).result.isError, true);
  assert.equal((await call(token, 'mention_attention_acknowledge', { attention_id: ownId })).data.acknowledged, true);
  assert.equal((await call(token, 'mention_attention_list')).data.mention_attention.length, 2);
  assert.equal((await db.select().from(agentChannelEvents).where(eq(agentChannelEvents.org_id, f.orgId))).length, 0);
});

test('agent reference reads obey live project/space restrictions, pause, deletion and rollout boundaries', { skip: !enabled }, async () => {
  await db.update(agentEmployees).set({ project_ids: [f.projectId + '-not-granted'] }).where(eq(agentEmployees.id, f.employeeId));
  assert.equal((await call(token, 'native_mentions_resolve', { refs: [ref('task', f.taskId)] })).data.items[0].state, 'unavailable');
  await db.update(agentEmployees).set({ project_ids: [], is_active: false }).where(eq(agentEmployees.id, f.employeeId));
  const paused = await call(token, 'native_mentions_search');
  assert(paused.status === 401 || paused.status === 403 || paused.result?.isError);
  await db.update(agentEmployees).set({ is_active: true }).where(eq(agentEmployees.id, f.employeeId));
  await db.update(wikiPages).set({ scope: 'space', space_id: f.privateSpaceId }).where(eq(wikiPages.id, f.wikiId));
  assert.equal((await call(token, 'native_mentions_resolve', { refs: [ref('wiki_page', f.wikiId)] })).data.items[0].state, 'unavailable');
  await db.insert(spaceMembers).values({ space_id: f.privateSpaceId, user_id: f.agentId });
  assert.equal((await call(token, 'native_mentions_resolve', { refs: [ref('wiki_page', f.wikiId)] })).data.items[0].state, 'available');
  await db.update(agentEmployees).set({ space_ids: [f.publicSpaceId] }).where(eq(agentEmployees.id, f.employeeId));
  assert.equal((await call(token, 'native_mentions_resolve', { refs: [ref('wiki_page', f.wikiId)] })).data.items[0].state, 'unavailable');
  await db.update(agentEmployees).set({ space_ids: [] }).where(eq(agentEmployees.id, f.employeeId));
  await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, f.privateSpaceId), eq(spaceMembers.user_id, f.agentId)));
  await db.update(wikiPages).set({ scope: 'org', space_id: null }).where(eq(wikiPages.id, f.wikiId));
  await db.update(agentEmployees).set({ disabled_tools: ['native_mentions_search'] }).where(eq(agentEmployees.id, f.employeeId));
  assert(!(await rpc(token, 'tools/list')).body.result.tools.some((tool: any) => tool.name === 'native_mentions_search'));
  assert((await executeToolCall('native_mentions_search', {}, f.orgId, f.ownerId, undefined, f.employeeId)).result.error);
  await db.update(agentEmployees).set({ disabled_tools: [] }).where(eq(agentEmployees.id, f.employeeId));
  const denied = await call(token, 'native_mentions_resolve', { refs: [ref('task', f.restrictedId), ref('wiki_page', f.privateWikiId), ref('person', f.outsiderId)] });
  assert(denied.data.items.every((item: any) => item.state === 'unavailable' && !item.label && !item.current_source));
  await db.update(agentEmployees).set({ is_deleted: true, runtime_kind: 'defty_system' }).where(eq(agentEmployees.id, f.employeeId));
  const forgedDefty = await executeToolCall('native_mentions_search', {}, f.orgId, f.ownerId, undefined, f.employeeId);
  assert(forgedDefty.result.error);
  await db.update(agentEmployees).set({ is_deleted: false, runtime_kind: 'custom_mcp' }).where(eq(agentEmployees.id, f.employeeId));
  process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'false';
  try {
    assert.equal((await call(token, 'native_mentions_search')).data.enabled, false);
    assert.equal((await call(token, 'mention_attention_list')).data.mention_attention.length, 0);
    assert.equal((await call(token, 'native_mentions_resolve', { refs: [ref('task', f.taskId)] })).data.items[0].state, 'available', 'reader compatibility remains during publication pause');
  } finally { process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'true'; }
});

test('scripted provider fixture exercises the real Defty and employee runner loops without bypassing approval', { skip: !enabled }, async () => {
  // This is deterministic adapter evidence, not a live model comprehension test.
  await setOrgOllamaUrl(f.orgId, 'http://native-mention-provider.test');
  await setOrgModelRoute(f.orgId, 'reason', { provider: 'ollama', model: 'scripted-native-mention-fixture' });
  const originalFetch = globalThis.fetch;
  const content = atom('wiki_page', f.wikiId) + ' reviewed by ' + atom('person', f.samId);
  await db.update(tasks).set({ description: content }).where(eq(tasks.id, f.taskId));
  const beforeMessages = (await db.select().from(messages).where(eq(messages.org_id, f.orgId))).length;
  try {
    for (const employeeId of [undefined, f.employeeId]) {
      let iteration = 0;
      const requests: any[] = [];
      globalThis.fetch = async (input, init) => {
        assert.equal(String(input), 'http://native-mention-provider.test/api/chat', 'fixture permits no external provider calls');
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const system = body.messages.find((message: any) => message.role === 'system')?.content;
        assert(system.includes(NATIVE_MENTION_AGENT_GUIDANCE));
        assert(system.includes(IMMUTABLE_DEFT_PLATFORM_POLICY));
        const names = body.tools.map((tool: any) => tool.function.name);
        for (const name of ['native_mentions_search', 'native_mentions_resolve', 'mention_attention_list', 'mention_attention_acknowledge']) assert(names.includes(name));
        const previousTool = body.messages.filter((message: any) => message.role === 'tool').at(-1);
        const tool = (name: string, args: Record<string, unknown>) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
        let message;
        switch (iteration++) {
          case 0: message = tool('native_mentions_search', { query: 'Review release' }); break;
          case 1: {
            const data = JSON.parse(previousTool.content).result;
            assert.equal(data.items[0].token, atom('task', f.taskId));
            message = tool('native_mentions_resolve', { refs: [data.items[0].ref] }); break;
          }
          case 2: {
            const data = JSON.parse(previousTool.content).result;
            assert.equal(data.items[0].current_source.content, content);
            assert.equal(data.items[0].current_source.untrusted, true);
            assert.equal(data.items[0].current_source.references.length, 2);
            message = tool('post_message', { space_name: 'Launch room', content: 'Created wiki [[deft:wiki_page:0]]' }); break;
          }
          case 3: assert.match(JSON.parse(previousTool.content).error, /Native references/); message = tool('post_message', { space_name: 'Launch room', content: 'Please review ' + atom('task', f.taskId) }); break;
          case 4: assert.equal(JSON.parse(previousTool.content).status, 'skipped'); message = { role: 'assistant', content: 'The message is proposed and awaits your review.' }; break;
          default: throw new Error('Unexpected reasoning iteration');
        }
        return new Response(JSON.stringify({ message, prompt_eval_count: 10, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const result = await runAgentQuery({ content: '@', orgId: f.orgId, userId: f.ownerId, orgName: 'Native mention lab',
        mode: 'chat_mention', agentEmployeeId: employeeId, systemPromptOverride: 'Synthetic runner interface validation.', skipVerification: true, maxIterations: 5 });
      assert.equal(requests.length, 5);
      assert.equal(result.pendingActions.length, 1);
      assert.equal(result.pendingActions[0].action, 'post_message');
      assert.equal(result.pendingActions[0].params.content, 'Please review ' + atom('task', f.taskId));
      assert.equal(result.executedActions.filter(action => action.readOnly && action.success).length, 2);
      assert(result.citations.some(citation => citation.url === '/tasks?task=' + f.taskId));
      assert.match(result.text, /awaits your review/);
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await db.select().from(messages).where(eq(messages.org_id, f.orgId))).length, beforeMessages, 'unapproved chat proposal must not send');
});

test('canonical hidden Defty can consume passive attention through the native runner adapter', { skip: !enabled }, async () => {
  await db.update(agentEmployees).set({ slug: 'defty-system', runtime_kind: 'defty_system', is_byoa: false, is_deleted: true, project_ids: ['not-granted'] }).where(eq(agentEmployees.id, f.employee2Id));
  try {
    const own = await executeToolCall('mention_attention_list', {}, f.orgId, f.ownerId, undefined, f.employee2Id);
    assert.equal(own.result.mention_attention.length, 3);
    assert(own.result.mention_attention.every((item: any) => item.user_id === f.agent2Id));
    const defaultDefty = await executeToolCall('mention_attention_list', {}, f.orgId, f.ownerId);
    assert.equal(defaultDefty.result.mention_attention.length, 3);
    const ack = await executeToolCall('mention_attention_acknowledge', { attention_id: own.result.mention_attention[0].id }, f.orgId, f.ownerId, undefined, f.employee2Id);
    assert.equal(ack.result.acknowledged, true);
    const reads = await executeToolCall('native_mentions_resolve', { refs: [ref('task', f.taskId)] }, f.orgId, f.ownerId, undefined, f.employee2Id);
    assert.equal(reads.result.items[0].state, 'available');
  } finally { await db.update(agentEmployees).set({ slug: 'avery-' + f.employee2Id, runtime_kind: 'custom_mcp', is_byoa: true, is_deleted: false, project_ids: [] }).where(eq(agentEmployees.id, f.employee2Id)); }
});
