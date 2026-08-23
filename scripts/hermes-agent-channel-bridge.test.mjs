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
  assert.equal(calls[4].body.event_id, null);
  assert.equal(calls[2].init.headers['X-Hermes-Session-Key'], 'deft:maya:thread-1');
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
    return jsonResponse({ ok: true, employee: { slug: 'maya' } });
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

test('pollOnce claims only one event so queued leases cannot expire behind active work', async () => {
  const urls = [];
  const bridge = new HermesAgentChannelBridge(config(), {
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({ ok: true, events: [] });
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
