import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setPausedStartForTest, assertPausedStartSettingValid, isRefusedWhilePaused,
  parsePausedStartSetting, pausedGuardedFetch, PausedStartError, serverStartupPlan,
  PAUSED_ALLOWED_WRITES,
} from '../src/lib/paused-start.js';

afterEach(() => _setPausedStartForTest(false));
after(async () => { const { closeDb } = await import('../src/lib/db.js'); await closeDb(); });

test('the start-time setting accepts only unset, true and false; malformed values fail closed', () => {
  for (const raw of [undefined, 'false']) assert.deepEqual(parsePausedStartSetting(raw), { paused: false, invalid: null });
  assert.deepEqual(parsePausedStartSetting('true'), { paused: true, invalid: null });
  for (const raw of ['', 'TRUE', '1', ' true', 'true\r', 'false ']) {
    const parsed = parsePausedStartSetting(raw);
    assert.equal(parsed.paused, true);
    assert.throws(() => assertPausedStartSettingValid(parsed), /Refusing to start/);
  }
});

test('paused startup skips credential migration and scheduling', () => {
  assert.deepEqual(serverStartupPlan(true), { migrateLegacyMcpCredentials: false, initScheduler: false });
  assert.deepEqual(serverStartupPlan(false), { migrateLegacyMcpCredentials: true, initScheduler: true });
});

// C7 can add one exact allowlist row and one test case here, without widening
// the entire auth router (password/security changes must remain refused).
for (const path of ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']) {
  test(`paused login exception is exact: POST ${path}`, () => {
    _setPausedStartForTest(true);
    assert.ok(PAUSED_ALLOWED_WRITES.some((route) => route.method === 'POST' && route.path === path));
    assert.equal(isRefusedWhilePaused('POST', path), false);
    assert.equal(isRefusedWhilePaused('POST', `${path}/`), false);
    assert.equal(isRefusedWhilePaused('POST', `${path}/extra`), true);
    assert.equal(isRefusedWhilePaused('PATCH', path), true);
  });
}

test('read side effects shared with other people are refused; private onboarding remains available', () => {
  _setPausedStartForTest(true);
  for (const path of ['/api/attention', '/api/agent/conversations', '/api/members', '/api/spaces/example/canvas',
    '/api/ics/my-feed-url', '/api/agent-channel/v1/events', '/api/agent-channel/v1/connect', '/api/ics/feed/token']) {
    for (const verb of ['GET', 'HEAD']) assert.equal(isRefusedWhilePaused(verb, path), true, `${verb} ${path}`);
    assert.equal(isRefusedWhilePaused('OPTIONS', path), false);
  }
  assert.equal(isRefusedWhilePaused('GET', '/api/auth/onboarding'), false);
  assert.equal(isRefusedWhilePaused('POST', '/api/auth/reset-password'), true);
  assert.equal(isRefusedWhilePaused('POST', '/health/future-write'), true);
});

test('paused provider and transport entry points refuse before network, files or database work', async () => {
  const [{ llm }, { createAgentMessage }, { embed, embedQuiet }, { transcribe }, { answerImageAttachmentQuestion },
    { fetchPublicHttpText }, { capabilityService }, { sendPushTest, sendAttentionDelivery }, { getMCPToolsForAgent }] = await Promise.all([
    import('../src/lib/llm.js'), import('../src/lib/agent-llm.js'), import('../src/lib/embed.js'),
    import('../src/lib/transcription.js'), import('../src/lib/attachment-vision.js'), import('../src/lib/public-http-fetch.js'),
    import('../src/lib/capability-service.js'), import('../src/lib/web-push.js'), import('../src/lib/mcp-tools.js'),
  ]);
  _setPausedStartForTest(true);
  await assert.rejects(pausedGuardedFetch('https://example.invalid'), PausedStartError);
  await assert.rejects(llm({ task: 'reason', messages: [] }), PausedStartError);
  await assert.rejects(createAgentMessage({} as any), PausedStartError);
  await assert.rejects(embed('private text', 'no-db-org'), PausedStartError);
  assert.equal(await embedQuiet('private text', 'no-db-org'), null);
  await assert.rejects(transcribe('file-that-must-not-be-opened', 'no-db-org'), PausedStartError);
  await assert.rejects(answerImageAttachmentQuestion({ orgId: 'no-db-org', bytes: new Uint8Array([1]), mimeType: 'image/png',
    provider: { ready: true } as any, fetchImpl: async () => { throw new Error('transport called'); } }), PausedStartError);
  await assert.rejects(fetchPublicHttpText('https://example.invalid'), PausedStartError);
  await assert.rejects(capabilityService.discover({} as any), PausedStartError);
  await assert.rejects(capabilityService.invoke({}), PausedStartError);
  assert.deepEqual(await capabilityService.invokePinned({} as any), { status: 'not_attempted' });
  assert.deepEqual(await getMCPToolsForAgent('no-db-org'), []);
  await assert.rejects(sendPushTest({ orgId: 'no-db-org', userId: 'no-db-user' }), PausedStartError);
  await assert.rejects(sendAttentionDelivery('no-db-delivery'), PausedStartError);
});
