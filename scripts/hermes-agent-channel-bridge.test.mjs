import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HermesAgentChannelBridge,
  buildEventPrompt,
  conversationKey,
  extractHermesText,
  parseHermesDecision,
} from './hermes-agent-channel-bridge.mjs';

const event = {
  id: 'event-1',
  kind: 'message.created',
  source_kind: 'message',
  source_id: 'message-1',
  space_id: 'space-1',
  thread_id: 'thread-1',
  claim_token: 'claim-event-1',
  delivery_count: 1,
  payload: { content: '@Maya summarize this launch blocker', reply_thread_id: 'thread-1' },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function config() {
  return {
    channelUrl: 'https://deft.test/api/agent-channel/v1',
    channelToken: 'channel-secret',
    employeeSlug: 'maya',
    hermesApiUrl: 'http://127.0.0.1:8642',
    hermesApiKey: 'hermes-secret',
    hermesModel: 'Maya',
    pollMs: 1,
    limit: 10,
    maxRetries: 2,
    retryBaseMs: 5,
    heartbeatMs: 60000,
    leaseMs: 120000,
    leaseHeartbeatMs: 40000,
    workerId: 'bridge-worker-test',
    once: true,
  };
}

const compatibleConnection = {
  ok: true,
  protocol_version: 'deft.agent_channel.v2',
  server_release: '0.3.0-preview.6',
  capabilities: [
    'single_flight_claims',
    'renewable_leases',
    'fencing_tokens',
    'terminal_outcomes',
    'identity_bound_mcp',
    'wiki_memory_sync_v1',
    'runtime_reconciliation_v1',
    'runtime_attestation_v1',
  ],
  employee: { slug: 'maya' },
};

test('buildEventPrompt preserves the event and pins the employee identity', () => {
  const prompt = buildEventPrompt(event, 'maya');
  assert.match(prompt, /bearer token binds your employee identity/);
  assert.match(prompt, /message\.created/);
  assert.match(prompt, /summarize this launch blocker/);
  assert.match(prompt, /Do not call message_post, send_message, post_thread_reply/);
  assert.match(prompt, /bridge is the sole writer/);
  assert.match(prompt, /different named destination/);
  assert.doesNotMatch(prompt, /channel-secret/);
});

test('buildEventPrompt marks the source thread as the primary evidence boundary', () => {
  const prompt = buildEventPrompt(event, 'maya');
  const contextLine = prompt
    .split('\n')
    .find((line) => line.startsWith('DEFT_PRIMARY_EVIDENCE_JSON='));

  assert.ok(contextLine, 'prompt must include a machine-readable primary evidence envelope');
  assert.deepEqual(JSON.parse(contextLine.slice('DEFT_PRIMARY_EVIDENCE_JSON='.length)), {
    event_id: 'event-1',
    event_kind: 'message.created',
    source_kind: 'message',
    source_id: 'message-1',
    space_id: 'space-1',
    thread_id: 'thread-1',
    triggering_message_id: 'message-1',
    retrieval_query: '@Maya summarize this launch blocker',
  });
  assert.match(prompt, /source thread is the primary evidence boundary/i);
  assert.match(prompt, /fetch the source thread before broad workspace search/i);
  assert.match(prompt, /label.*outside the source space or thread/i);
});

test('buildEventPrompt gives task events a bounded task-specific retrieval query', () => {
  const prompt = buildEventPrompt({
    ...event,
    kind: 'task.assigned',
    source_kind: 'task',
    source_id: 'task-1',
    space_id: null,
    thread_id: null,
    payload: {
      task_id: 'task-1',
      title: 'Research qualified grocers',
      description: 'Use the buyer criteria and create a sourced shortlist.',
    },
  }, 'maya');
  const contextLine = prompt
    .split('\n')
    .find((line) => line.startsWith('DEFT_PRIMARY_EVIDENCE_JSON='));
  const context = JSON.parse(contextLine.slice('DEFT_PRIMARY_EVIDENCE_JSON='.length));

  assert.equal(context.source_kind, 'task');
  assert.equal(context.source_id, 'task-1');
  assert.equal(context.triggering_message_id, null);
  assert.equal(
    context.retrieval_query,
    'Research qualified grocers\nUse the buyer criteria and create a sourced shortlist.',
  );
});

test('extractHermesText and parseHermesDecision accept Responses API output', () => {
  const text = extractHermesText({
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: '```json\n{"reply":"On it.","summary":"Queued a task proposal.","outcome":"needs_human"}\n```' }],
    }],
  });
  assert.deepEqual(parseHermesDecision(text), {
    reply: 'On it.',
    summary: 'Queued a task proposal.',
    outcome: 'needs_human',
  });
});

test('conversationKey keeps a stable thread-scoped Hermes conversation', () => {
  assert.equal(conversationKey(event, 'maya'), 'deft:maya:thread-1');
});

test('runtime preflight reports Hermes reachability and only high-level toolset names', async () => {
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) {
        return jsonResponse({ status: 'ok', platform: 'hermes-agent', version: '0.16.0' });
      }
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'Maya' }] });
      }
      if (url.endsWith('/v1/capabilities')) {
        return jsonResponse({ features: { responses_api: true, skills_api: true } });
      }
      if (url.endsWith('/v1/toolsets')) {
        return jsonResponse({
          data: [
            { name: 'web', enabled: true, configured: true, tools: ['browser', 'search'] },
            { name: 'email', enabled: true, configured: false, tools: ['send_email'] },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const attestation = await bridge.preflightHermesRuntime();

  assert.equal(attestation.ready, true);
  assert.equal(attestation.hermes_version, '0.16.0');
  assert.equal(attestation.configured_model, 'Maya');
  assert.deepEqual(attestation.available_models, ['Maya']);
  assert.deepEqual(attestation.enabled_toolsets, ['web']);
  assert.equal(JSON.stringify(attestation).includes('browser'), false, 'Deft must not copy Hermes tool catalogs');
});

test('processEvent acks, marks working, invokes Hermes, replies once, and returns idle', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/v1/responses')) {
      return jsonResponse({
        id: 'resp-1',
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: '{"reply":"I created a governed proposal.","summary":"Proposal queued.","outcome":"needs_human"}',
          }],
        }],
      });
    }
    return jsonResponse({ ok: true });
  };
  const bridge = new HermesAgentChannelBridge(config(), { fetchImpl, logger: { info() {}, error() {} } });
  await bridge.processEvent(event);

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/api/agent-channel/v1/ack',
    '/api/agent-channel/v1/status',
    '/v1/responses',
    '/api/agent-channel/v1/reply',
    '/api/agent-channel/v1/status',
  ]);
  assert.equal(calls[0].body.state, 'received');
  assert.equal(calls[0].body.claim_token, 'claim-event-1');
  assert.equal(calls[1].body.state, 'working');
  assert.equal(calls[3].body.idempotency_key, 'hermes-channel:event-1');
  assert.equal(calls[3].body.outcome, 'needs_human');
  assert.equal(calls[4].body.state, 'idle');
  assert.equal('event_id' in calls[4].body, false);
  assert.equal(calls[2].init.headers['X-Hermes-Session-Key'], 'deft:maya:thread-1');
  assert.equal(calls[2].init.headers['Idempotency-Key'], 'deft-channel:event-1:attempt:1');
});

test('processEvent reports runtime failures to the channel', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/v1/responses')) return jsonResponse({ error: { message: 'provider offline' } }, 503);
    return jsonResponse({ ok: true });
  };
  const bridge = new HermesAgentChannelBridge(config(), { fetchImpl, logger: { info() {}, error() {} } });
  await assert.rejects(() => bridge.processEvent(event), /provider offline/);
  const terminalCalls = calls.slice(-2);
  assert.equal(terminalCalls[0].body.state, 'failed');
  assert.equal(terminalCalls[1].body.state, 'degraded');
});

test('processEvent safely recovers an ambiguous Hermes transport failure with the same request identity', async () => {
  const responseByKey = new Map();
  const requestKeys = [];
  let inferenceExecutions = 0;
  let responseAttempts = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/v1/responses')) {
      responseAttempts += 1;
      const key = init.headers['Idempotency-Key'];
      requestKeys.push(key);
      if (!responseByKey.has(key)) {
        inferenceExecutions += 1;
        responseByKey.set(key, {
          id: 'resp-recovered',
          output_text: '{"reply":"The buyer record is updated.","summary":"Updated BUY-10.","outcome":"completed"}',
        });
        throw new Error('connection closed after request');
      }
      return jsonResponse(responseByKey.get(key));
    }
    return jsonResponse({ ok: true });
  };
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl,
    sleep: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await bridge.processEvent(event);

  assert.equal(result.responseId, 'resp-recovered');
  assert.equal(responseAttempts, 2, 'one bounded recovery request is allowed');
  assert.equal(inferenceExecutions, 1, 'Hermes must join/cache the original idempotent run');
  assert.deepEqual(requestKeys, [
    'deft-channel:event-1:attempt:1',
    'deft-channel:event-1:attempt:1',
  ]);
});

test('processEvent reports a reconciled uncertain handoff instead of a false failure', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.includes('/v1/responses')) throw new Error('connection closed after durable work');
    if (url.endsWith('/reconcile')) {
      return jsonResponse({
        ok: true,
        has_durable_effects: true,
        effects: {
          task_comments: { count: 1, ids: ['comment-1'] },
          agent_actions: { count: 1, ids: ['action-1'] },
        },
      });
    }
    return jsonResponse({ ok: true });
  };
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl,
    sleep: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await bridge.processEvent(event);

  assert.equal(result.decision.outcome, 'work_completed_handoff_uncertain');
  const reconcileCall = calls.find((call) => call.url.endsWith('/reconcile'));
  assert.equal(reconcileCall.body.runtime_request_key, 'deft-channel:event-1:attempt:1');
  const terminalAck = calls.find((call) => call.url.endsWith('/ack')
    && call.body.state === 'work_completed_handoff_uncertain');
  assert.ok(terminalAck);
  assert.equal(terminalAck.body.runtime_request_key, 'deft-channel:event-1:attempt:1');
  assert.equal(calls.some((call) => call.url.endsWith('/ack') && call.body.state === 'failed'), false);
});

test('top-level DM replies stay in the main conversation instead of opening a thread', async () => {
  const calls = [];
  const dmEvent = {
    ...event,
    id: 'event-dm',
    claim_token: 'claim-event-dm',
    thread_id: null,
    payload: { content: 'hello', is_dm: true, parent_id: null, reply_thread_id: null },
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/v1/responses')) {
      return jsonResponse({
        output_text: '{"reply":"Hello back.","summary":"Replied.","outcome":"completed"}',
      });
    }
    return jsonResponse({ ok: true });
  };
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl,
    logger: { info() {}, error() {} },
  });

  await bridge.processEvent(dmEvent);
  const replyCall = calls.find((call) => call.url.endsWith('/reply'));
  assert.ok(replyCall);
  assert.equal(replyCall.body.thread_id, null);
});

test('request retries a transient channel rate limit instead of killing the bridge', async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return jsonResponse(compatibleConnection);
  };
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await bridge.connect();
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [5]);
});

test('connect rejects a legacy Agent Channel before polling any work', async () => {
  const urls = [];
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({
        ok: true,
        protocol_version: 'deft.agent_channel.v1',
        employee: { slug: 'maya' },
      });
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(
    () => bridge.run(),
    /INCOMPATIBLE_CHANNEL.*deft\.agent_channel\.v1.*deft\.agent_channel\.v2/,
  );
  assert.equal(urls.filter((url) => url.includes('/events')).length, 0, 'an incompatible bridge must stop before GET /events');
  assert.match(urls[0], /protocol_version=deft\.agent_channel\.v2/);
  assert.match(urls[0], /adapter_version=/);
  assert.match(urls[0], /capabilities=/);
});

test('connect rejects a v2 server that omits a required capability', async () => {
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl: async () => jsonResponse({
      ...compatibleConnection,
      capabilities: compatibleConnection.capabilities.filter((name) => name !== 'fencing_tokens'),
    }),
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(() => bridge.connect(), /INCOMPATIBLE_CHANNEL.*fencing_tokens/);
});

test('pollOnce claims only one event so queued leases cannot expire behind active work', async () => {
  const urls = [];
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({ ...compatibleConnection, events: [] });
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(await bridge.pollOnce(), 0);
  const query = new URL(urls[0]).searchParams;
  assert.equal(query.get('limit'), '1');
  assert.equal(query.get('worker_id'), 'bridge-worker-test');
  assert.equal(query.get('lease_ms'), '120000');
});

test('heartbeat is rate-limited while proving the poll loop is alive', () => {
  const messages = [];
  let now = 100000;
  const bridge = new HermesAgentChannelBridge(config(), {
    now: () => now,
    logger: { info: (message) => messages.push(message) },
  });

  bridge.logHeartbeat(0);
  now += 1000;
  bridge.logHeartbeat(0);
  now += 60000;
  bridge.logHeartbeat(2);

  assert.deepEqual(messages, [
    '[deft-channel] heartbeat (0 events)',
    '[deft-channel] heartbeat (2 events)',
  ]);
});
