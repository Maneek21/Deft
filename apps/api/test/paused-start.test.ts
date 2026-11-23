import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setPausedStartForTest, assertPausedStartSettingValid, isRefusedWhilePaused,
  parsePausedStartSetting, pausedGuardedFetch, PausedStartError, serverStartupPlan,
  PAUSED_ALLOWED_WRITES, pausedNotice,
} from '../src/lib/paused-start.js';

afterEach(() => _setPausedStartForTest(false));
after(async () => { const { closeDb } = await import('../src/lib/db.js'); await closeDb(); });

test('the start-time setting accepts only unset, true and false; malformed values fail closed', () => {
  for (const raw of [undefined, 'false']) assert.deepEqual(parsePausedStartSetting(raw), { paused: false, invalid: null, reason: 'restore_review', invalidReason: null });
  assert.deepEqual(parsePausedStartSetting('true'), { paused: true, invalid: null, reason: 'restore_review', invalidReason: null });
  for (const raw of ['', 'TRUE', '1', ' true', 'true\r', 'false ']) {
    const parsed = parsePausedStartSetting(raw);
    assert.equal(parsed.paused, true);
    assert.throws(() => assertPausedStartSettingValid(parsed), /Refusing to start/);
  }
});

test('DEFT_PAUSED_REASON defaults to restore_review and accepts only restore_review, billing or emergency_stop', () => {
  assert.equal(parsePausedStartSetting('true').reason, 'restore_review');
  assert.equal(parsePausedStartSetting('true', undefined).reason, 'restore_review');
  for (const reason of ['restore_review', 'billing', 'emergency_stop'] as const) {
    const parsed = parsePausedStartSetting('true', reason);
    assert.equal(parsed.reason, reason);
    assert.doesNotThrow(() => assertPausedStartSettingValid(parsed));
  }
  // A bad reason stops startup, paused or not, like the other strict settings.
  for (const start of ['true', 'false', undefined]) {
    for (const raw of ['', 'Billing', 'billing ', 'restore', 'overdue', 'billing\r']) {
      assert.throws(() => assertPausedStartSettingValid(parsePausedStartSetting(start, raw)), /DEFT_PAUSED_REASON must be one of/);
    }
  }
});

test('the notice for signed-in people is null unless paused, and names the reason', () => {
  _setPausedStartForTest(false, 'billing');
  assert.equal(pausedNotice(), null);
  _setPausedStartForTest(true);
  assert.deepEqual(pausedNotice(), { reason: 'restore_review' });
  _setPausedStartForTest(true, 'billing');
  assert.deepEqual(pausedNotice(), { reason: 'billing' });
  _setPausedStartForTest(true, 'emergency_stop');
  assert.deepEqual(pausedNotice(), { reason: 'emergency_stop' });
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

test('paused two-step sign-in is admitted exactly; two-step security changes stay refused', () => {
  _setPausedStartForTest(true);
  for (const path of ['/api/auth/two-step/verify', '/api/auth/two-step/enrol/start', '/api/auth/two-step/enrol/confirm']) {
    assert.ok(PAUSED_ALLOWED_WRITES.some((route) => route.method === 'POST' && route.path === path), path);
    assert.equal(isRefusedWhilePaused('POST', path), false, path);
    assert.equal(isRefusedWhilePaused('POST', `${path}/extra`), true, path);
    assert.equal(isRefusedWhilePaused('PUT', path), true, path);
  }
  for (const path of ['/api/auth/two-step/disable', '/api/auth/two-step/recovery-codes', '/api/auth/two-step', '/api/auth/two-step/enrol']) {
    assert.equal(isRefusedWhilePaused('POST', path), true, path);
  }
  assert.equal(isRefusedWhilePaused('GET', '/api/auth/two-step'), false, 'the status read stays open');
});

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

test('paused seat refresher performs no fetch, timer registration or statement intake', async (t) => {
  const seats = await import('../src/lib/seat-limit.js');
  const names = ['DEFT_HOSTED', 'DEFT_CELL_ID', 'DEFT_SEAT_PUBLIC_KEYS', 'DEFT_SEAT_STATEMENT_URL', 'DEFT_SEAT_FETCH_TOKEN'];
  const previous = names.map((name) => process.env[name]);
  const fetcher = seats.seatFetchDeps.fetch;
  const interval = t.mock.method(globalThis, 'setInterval');
  let calls = 0;
  Object.assign(process.env, { DEFT_HOSTED: 'true', DEFT_CELL_ID: 'paused-seat-test',
    DEFT_SEAT_PUBLIC_KEYS: Buffer.alloc(32, 1).toString('base64url'),
    DEFT_SEAT_STATEMENT_URL: 'https://example.invalid/seats', DEFT_SEAT_FETCH_TOKEN: 'synthetic-token' });
  seats.seatFetchDeps.fetch = async () => { calls++; return new Response(null, { status: 503 }); };
  _setPausedStartForTest(true);
  try {
    seats.startSeatStatementRefresher();
    assert.equal(calls, 0, 'startup sent a seat-statement fetch while paused');
    assert.equal(interval.mock.callCount(), 0, 'startup registered a background timer while paused');
    await assert.rejects(async () => seats.refreshSeatStatement(), PausedStartError);
    await assert.rejects(seats.acceptSeatStatementToken('synthetic'), PausedStartError);
    assert.equal(calls, 0);
  } finally {
    seats.stopSeatStatementRefresher();
    seats.seatFetchDeps.fetch = fetcher;
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});
