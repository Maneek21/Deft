import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { AGENT_TOOLS } from '../src/lib/agent-tools.js';
import { createAgentMessage } from '../src/lib/agent-llm.js';
import { closeDb } from '../src/lib/db.js';
import { prepareAgentCurrentTurnMessages } from '../src/lib/agent-runner.js';

after(closeDb);

const baseMessages = [{ role: 'user' as const, content: 'Summarize Cedar Vale.' }];
const moduleListTool = AGENT_TOOLS.find((tool) => tool.name === 'module_list');
assert.ok(moduleListTool);

test('authorized Module discovery reaches the actual provider message with exact IDs', async (t) => {
  let discoveryCalls = 0;
  const messages = await prepareAgentCurrentTurnMessages({
    messages: baseMessages,
    tools: [moduleListTool],
    orgId: 'org-1',
    userId: 'user-1',
    conversationId: 'space-1',
    untrustedContextSections: ['Existing evidence.'],
    executeTool: async (name, input, orgId, userId, conversationId) => {
      discoveryCalls += 1;
      assert.deepEqual([name, input, orgId, userId, conversationId], [
        'module_list', {}, 'org-1', 'user-1', 'space-1',
      ]);
      return {
        result: {
          modules: [{
            module_id: 'org.example.accounts',
            name: 'Accounts',
            manifest_digest: `sha256:${'1'.repeat(64)}`,
            slug: 'accounts',
            collections: [{ key: 'companies', name: 'Companies' }],
          }],
        },
        citations: [],
      };
    },
  });
  assert.equal(discoveryCalls, 1);

  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const providerContent = String(body.input[0].content);
    assert.match(providerContent, /Existing evidence/);
    assert.match(providerContent, /org\.example\.accounts/);
    assert.match(providerContent, /"status":"ready"/);
    assert.match(providerContent, /"has_more":false/);
    return Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grounded reply.' }] }],
    });
  });
  await createAgentMessage({
    resolved: { provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'test-key' },
    system: 'Use the supplied tools and evidence.',
    messages,
    tools: [moduleListTool],
    maxTokens: 256,
  });
});

test('disabled Module discovery performs no prefetch', async () => {
  let discoveryCalls = 0;
  const messages = await prepareAgentCurrentTurnMessages({
    messages: baseMessages,
    tools: AGENT_TOOLS.filter((tool) => tool.name !== 'module_list'),
    orgId: 'org-1',
    userId: 'user-1',
    untrustedContextSections: [],
    executeTool: async () => {
      discoveryCalls += 1;
      throw new Error('must not execute');
    },
  });
  assert.equal(discoveryCalls, 0);
  assert.equal(messages[0]?.content, baseMessages[0]?.content);
});

test('discovery failure is explicit and cannot look like a successful empty catalog', async () => {
  const messages = await prepareAgentCurrentTurnMessages({
    messages: baseMessages,
    tools: [moduleListTool],
    orgId: 'org-1',
    userId: 'user-1',
    untrustedContextSections: [],
    executeTool: async () => { throw new Error('database detail must stay private'); },
  });
  const content = String(messages[0]?.content);
  assert.match(content, /"status":"unavailable"/);
  assert.match(content, /Retry module_list/);
  assert.doesNotMatch(content, /database detail/);
  assert.doesNotMatch(content, /"status":"ready"/);
});

test('prefetched catalog is deterministically bounded and advertises more results', async () => {
  const messages = await prepareAgentCurrentTurnMessages({
    messages: baseMessages,
    tools: [moduleListTool],
    orgId: 'org-1',
    userId: 'user-1',
    untrustedContextSections: [],
    executeTool: async () => ({
      result: {
        modules: Array.from({ length: 21 }, (_, index) => ({
          module_id: `org.example.module-${String(index).padStart(2, '0')}`,
          name: `Module ${index}`,
          manifest_digest: `sha256:${String(index % 10).repeat(64)}`,
          slug: `module-${index}`,
          collections: [{ key: 'items', name: 'Items' }],
        })),
      },
      citations: [],
    }),
  });
  const content = String(messages[0]?.content);
  assert.match(content, /"has_more":true/);
  assert.match(content, /org\.example\.module-19/);
  assert.doesNotMatch(content, /org\.example\.module-20/);
});
