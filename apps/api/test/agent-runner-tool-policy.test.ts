/**
 * W2-a6-Y: a runner call with toolPolicy 'none' advertises no tools, runs no
 * tool discovery or workspace retrieval, and fails instead of dispatching any
 * tool call the model returns. The default policy is unchanged.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, mock, test } from 'node:test';

type Call = { tools: Array<{ name: string }>; messages: unknown[]; system: string };
const providerCalls: Call[] = [];
let nextResponses: Array<{ content: any[]; stop_reason: string } | Error> = [];
const counters = { installed: 0, mcp: 0, execute: 0, retrieve: 0 };

const actualLlm = await import('../src/lib/agent-llm.js');
mock.module(new URL('../src/lib/agent-llm.ts', import.meta.url).href, { namedExports: {
  ...actualLlm,
  createAgentMessage: async (p: any) => {
    providerCalls.push({ tools: p.tools.map((t: any) => ({ name: t.name })), messages: p.messages, system: p.system });
    const next = nextResponses.shift() ?? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
    if (next instanceof Error) throw next;
    return { ...next, usage: { input_tokens: 11, output_tokens: 7 } };
  },
} });
const actualDiscovery = await import('../src/lib/app-installed-tool-discovery.js');
mock.module(new URL('../src/lib/app-installed-tool-discovery.ts', import.meta.url).href, { namedExports: {
  ...actualDiscovery,
  installedToolSchemas: async () => { counters.installed++; return []; },
} });
const actualMcp = await import('../src/lib/mcp-tools.js');
mock.module(new URL('../src/lib/mcp-tools.ts', import.meta.url).href, { namedExports: {
  ...actualMcp,
  getMCPToolsForAgent: async () => { counters.mcp++; return []; },
} });
const actualPolicy = await import('../src/lib/agent-tool-policy.js');
mock.module(new URL('../src/lib/agent-tool-policy.ts', import.meta.url).href, { namedExports: {
  ...actualPolicy,
  getActiveAgentToolPolicy: async () => ({ disabledTools: [] }),
  // First step of executeToolCall for every tool: counts executor entries.
  agentToolPolicyError: async () => { counters.execute++; return 'tool executor reached in test'; },
} });
const actualRetrieve = await import('../src/lib/retrieve-context.js');
mock.module(new URL('../src/lib/retrieve-context.ts', import.meta.url).href, { namedExports: {
  ...actualRetrieve,
  retrieveContext: async () => { counters.retrieve++; return []; },
} });
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  resolveReasonProvider: async () => ({ provider: 'anthropic', model: 'test-model', apiKey: 'test-key' }),
} });

const { runAgentQuery, isDeftyChatReadAllowed } = await import('../src/lib/agent-runner.js');
const { AGENT_TOOLS, CALENDAR_READ_TOOLS } = await import('../src/lib/agent-tools.js');
const { nativeMentionsEnabled } = await import('../src/lib/native-mentions.js');
const { closeDb } = await import('../src/lib/db.js');

after(closeDb);

const orgId = randomUUID();
const userId = randomUUID();

beforeEach(() => {
  providerCalls.length = 0;
  nextResponses = [];
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
});

function toolUse(name: string, input: Record<string, unknown>) {
  return { content: [{ type: 'tool_use', id: `tu-${name}`, name, input }], stop_reason: 'tool_use' };
}

const standupLikeCall = {
  orgId,
  userId,
  orgName: 'Tool policy org',
  mode: 'chat_mention' as const,
  skipVerification: true,
  maxIterations: 2,
  systemPromptOverride: 'Use only the supplied evidence. Return JSON only.',
  content: 'Return JSON only. Evidence: [{"source_id":"task:1","text":"Ship the login fix"}]',
};

test('W2-a6-Y: toolPolicy none sends zero tools and runs no discovery, retrieval or executor', async () => {
  nextResponses = [{ content: [{ type: 'text', text: '{"done":[],"in_progress":[],"blocked":[]}' }], stop_reason: 'end_turn' }];
  const response = await runAgentQuery({ ...standupLikeCall, agentEmployeeId: randomUUID(), toolPolicy: 'none' } as any);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0]!.tools, [], 'the provider receives an empty tool list');
  assert.deepEqual(counters, { installed: 0, mcp: 0, execute: 0, retrieve: 0 });
  assert.equal(response.text, '{"done":[],"in_progress":[],"blocked":[]}');
  assert.equal(response.model, 'test-model', 'provider/model resolution is unchanged');
  assert.equal(response.tokensIn, 11);
  assert.equal(response.tokensOut, 7);
});

for (const [label, name, input] of [
  ['read tool', 'search_messages', { query: 'secret' }],
  ['task read tool', 'search_tasks', { query: 'secret' }],
  ['write tool', 'create_task', { title: 'Injected', project_name: '' }],
  ['incidental write tool', 'remember', { key: 'k', value: 'v' }],
] as const) {
  test(`W2-a6-Y: toolPolicy none rejects a returned ${label} before dispatch`, async () => {
    nextResponses = [toolUse(name, input), { content: [{ type: 'text', text: 'after tool' }], stop_reason: 'end_turn' }];
    await assert.rejects(
      runAgentQuery({ ...standupLikeCall, toolPolicy: 'none' } as any),
      /no tools/i,
    );
    assert.equal(providerCalls.length, 1, 'no follow-up model call after a rejected tool call');
    assert.equal(counters.execute, 0, 'no tool executor call');
  });
}

test('W2-a6-Y: toolPolicy none rejects a tool call even when the model marks the turn finished', async () => {
  nextResponses = [{ content: [{ type: 'text', text: 'draft' }, { type: 'tool_use', id: 'tu-1', name: 'search_messages', input: {} }], stop_reason: 'end_turn' }];
  await assert.rejects(runAgentQuery({ ...standupLikeCall, toolPolicy: 'none' } as any), /no tools/i);
  assert.equal(counters.execute, 0);
});

test('W2-a6-Y: toolPolicy none passes a provider failure (e.g. a malformed tool call) to the caller', async () => {
  nextResponses = [new Error('OpenAI Responses function_call arguments are not valid JSON')];
  await assert.rejects(runAgentQuery({ ...standupLikeCall, toolPolicy: 'none' } as any), /not valid JSON/);
  assert.equal(counters.execute, 0);
});

test('W2-a6-Y: the default policy still answers a provider failure with the retry text', async () => {
  nextResponses = [new Error('provider down')];
  const response = await runAgentQuery({ ...standupLikeCall });
  assert.match(response.text, /did not return a usable response/);
});

test('W2-a6-Y: the default policy still advertises the native tool list and dispatches reads', async () => {
  const content = 'What is blocking the login fix?';
  nextResponses = [toolUse('search_tasks', { query: 'login' }), { content: [{ type: 'text', text: 'Nothing is blocked.' }], stop_reason: 'end_turn' }];
  await runAgentQuery({ content, orgId, userId, orgName: 'Tool policy org', maxIterations: 2 });
  const expected = [...AGENT_TOOLS, ...CALENDAR_READ_TOOLS]
    .filter((tool) => nativeMentionsEnabled() || tool.name !== 'native_mentions_search')
    .filter((tool) => isDeftyChatReadAllowed(tool.name))
    .map((tool) => tool.name);
  assert.ok(expected.length > 0);  assert.deepEqual(providerCalls[0]!.tools.map((tool) => tool.name), expected);
  assert.equal(counters.installed, 1, 'installed tool discovery still runs');
  assert.equal(counters.execute, 2, 'the Module discovery prefetch and the read tool call are dispatched');
  assert.equal(providerCalls.length, 2);
});

const groundedBrief = '{"agenda":[{"text":"Review the open login fix","source_ids":["task:1"]}],"decisions":[],"updates":[]}';
const meetingLikeContent = 'Return JSON only with keys agenda, decisions, updates.\n\nEvidence:\n[{"source_id":"event:1","text":"Meeting: Existing tasks review"},{"source_id":"task:1","text":"Ship the login fix"}]';

test('toolPolicy none returns an evidence-grounded draft without a tool-grounding retry', async () => {
  nextResponses = [{ content: [{ type: 'text', text: groundedBrief }], stop_reason: 'end_turn' }];
  const response = await runAgentQuery({ ...standupLikeCall, content: meetingLikeContent, toolPolicy: 'none' } as any);
  assert.equal(providerCalls.length, 1, 'one model call: no retry asking for tool reads');
  assert.equal(response.text, groundedBrief);
  assert.equal(response.tokensIn, 11);
  assert.equal(response.tokensOut, 7);
  assert.deepEqual(counters, { installed: 0, mcp: 0, execute: 0, retrieve: 0 });
});

test('toolPolicy none sends a prompt without tool-use instructions', async () => {
  nextResponses = [{ content: [{ type: 'text', text: groundedBrief }], stop_reason: 'end_turn' }];
  await runAgentQuery({ ...standupLikeCall, content: meetingLikeContent, toolPolicy: 'none' } as any);
  const system = providerCalls[0]!.system;
  for (const toolInstruction of ['use the search/list tools', 'check_calendar', 'Tool responses include', 'native_mentions_search', 'Use wiki_search']) {
    assert.ok(!system.includes(toolInstruction), `no-tools prompt omits: ${toolInstruction}`);
  }
  assert.match(system, /Immutable Deft platform policy/, 'the platform policy is still present');
  assert.match(system, /Use only the supplied evidence/, 'the caller instructions are still present');
  assert.match(system, /untrusted data/, 'the untrusted-data rule is still present');
  assert.match(system, /No tools are available in this run, including any named above/);
});

test('toolPolicy none returns a draft for runtime-discovery-like evidence in one call', async () => {
  const content = 'Return JSON only.\n\nEvidence:\n[{"source_id":"msg:1","text":"Which App actions are available in the CRM app?"}]';
  nextResponses = [{ content: [{ type: 'text', text: groundedBrief }], stop_reason: 'end_turn' }];
  const response = await runAgentQuery({ ...standupLikeCall, content, toolPolicy: 'none' } as any);
  assert.equal(providerCalls.length, 1);
  assert.equal(response.text, groundedBrief);
});

test('toolPolicy none returns an empty reply as empty, without runtime-discovery text', async () => {
  const content = 'Return JSON only.\n\nEvidence:\n[{"source_id":"msg:1","text":"Which App actions are available in the CRM app?"}]';
  nextResponses = [{ content: [{ type: 'text', text: '  ' }], stop_reason: 'end_turn' }];
  const response = await runAgentQuery({ ...standupLikeCall, content, toolPolicy: 'none' } as any);
  assert.equal(providerCalls.length, 1);
  assert.equal(response.text, '');
  assert.equal(counters.execute, 0);
});

test('toolPolicy none rejects an invented approval role on a read-only request in one call', async () => {
  const content = 'Read-only. Return JSON only.\n\nEvidence:\n[{"source_id":"task:1","text":"Ship the login fix"}]';
  nextResponses = [{ content: [{ type: 'text', text: 'Project lead approval is required before shipping.' }], stop_reason: 'end_turn' }];
  await assert.rejects(runAgentQuery({ ...standupLikeCall, content, toolPolicy: 'none' } as any), /could not be verified/i);
  assert.equal(providerCalls.length, 1);
  assert.equal(counters.execute, 0);
});

test('toolPolicy none without a prompt override runs no module prefetch and keeps the followed-turn rule', async () => {
  nextResponses = [{ content: [{ type: 'text', text: 'NO_REPLY' }], stop_reason: 'end_turn' }];
  const response = await runAgentQuery({
    content: 'Find the existing task for the login fix', orgId, userId, orgName: 'Tool policy org',
    maxIterations: 2, followed: true, toolPolicy: 'none',
  } as any);
  assert.equal(response.text, 'NO_REPLY');
  assert.deepEqual(counters, { installed: 0, mcp: 0, execute: 0, retrieve: 0 });
  assert.deepEqual(providerCalls[0]!.tools, []);
  assert.match(providerCalls[0]!.system, /answer exactly NO_REPLY/);
  assert.ok(!providerCalls[0]!.system.includes('before using tools'));
});

test('toolPolicy none still rejects an unverified native link instead of retrying for tools', async () => {
  nextResponses = [{ content: [{ type: 'text', text: 'See [task](/tasks?task=invented)' }], stop_reason: 'end_turn' }];
  await assert.rejects(runAgentQuery({ ...standupLikeCall, content: meetingLikeContent, toolPolicy: 'none' } as any), /could not be verified/i);
  assert.equal(providerCalls.length, 1);
  assert.equal(counters.execute, 0);
});

test('the default policy keeps the tool-use prompt and the grounding retry for workspace requests', async () => {
  nextResponses = [
    { content: [{ type: 'text', text: groundedBrief }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: groundedBrief }], stop_reason: 'end_turn' },
  ];
  const response = await runAgentQuery({ ...standupLikeCall, content: meetingLikeContent });
  assert.match(providerCalls[0]!.system, /ALWAYS use the search\/list tools/);
  assert.match(providerCalls[0]!.system, /Tool responses include result and sources/);
  assert.equal(providerCalls.length, 2, 'the grounding retry still runs');
  assert.match(JSON.stringify(providerCalls[1]!.messages), /Verify this reply before returning it/);
  assert.match(response.text, /could not verify the workspace facts/);
});
