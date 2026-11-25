/**
 * The anonymous install ping (telemetry contract, section 3).
 *
 * - Self-hosted production builds only: never in hosted mode, never with
 *   DEFT_TELEMETRY=off, never from a development build, never when paused.
 * - Exactly `{ install_id, event, version, sent_at }`, under 1 KB, to
 *   https://get.deft.ing/v1/installs/ping, with no credentials.
 * - install_id: a UUID v4, the same every time for one install, never the
 *   workspace's own ID.
 * - A failure is dropped and counted: no retry, no error.
 *
 * Signup and invite acceptance sending it once each: install-ping-db.test.ts.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/install-ping.test.ts
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  INSTALL_PING_URL,
  installIdFromWorkspaceId,
  installPingCounters,
  installPingDeps,
  resetInstallPingForTest,
  sendInstallPing,
} from '../src/lib/telemetry/install-ping.js';
import { HOSTED_ENV, SELF_HOSTED_ENV, recordingFetch } from './fixtures/telemetry.js';

const saved = { ...installPingDeps };
afterEach(() => {
  Object.assign(installPingDeps, saved);
  resetInstallPingForTest();
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID = 'org_tz4a98xxat96iws9zmbrgj3a';
const SECRET = 'install-secret-for-tests-0123456789abcdef';

function useNetwork(env: NodeJS.ProcessEnv, status: number | 'throw' = 202) {
  const network = recordingFetch(status);
  Object.assign(installPingDeps, {
    env,
    fetch: network.fetch,
    firstWorkspaceId: async () => WORKSPACE_ID,
    version: async () => '0.3.0-preview.152',
    installSecret: async () => SECRET,
    now: () => Date.parse('2026-11-25T10:00:00.000Z'),
    isPaused: () => false,
  });
  return network;
}

test('a self-hosted production install sends exactly the four fields, anonymously', async () => {
  const network = useNetwork(SELF_HOSTED_ENV);
  await sendInstallPing('installed', WORKSPACE_ID);
  await sendInstallPing('person_added');
  assert.equal(network.sent.length, 2);
  for (const [request, event] of [[network.sent[0]!, 'installed'], [network.sent[1]!, 'person_added']] as const) {
    assert.equal(request.url, INSTALL_PING_URL);
    assert.equal(request.url, 'https://get.deft.ing/v1/installs/ping');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'error');
    const headers = new Headers(request.init.headers);
    assert.deepEqual([...headers.keys()], ['content-type'], 'no authorization, no identifying headers');
    assert.deepEqual(request.body, {
      install_id: installIdFromWorkspaceId(WORKSPACE_ID, SECRET),
      event,
      version: '0.3.0-preview.152',
      sent_at: '2026-11-25T10:00:00.000Z',
    });
    assert.ok(Buffer.byteLength(String(request.init.body)) <= 1024);
  }
  assert.deepEqual(installPingCounters(), { sent: 2, failed: 0 });
});

test('install_id is a UUID v4, stable per install, and needs the install key', () => {
  const id = installIdFromWorkspaceId(WORKSPACE_ID, SECRET);
  assert.match(id, UUID_V4);
  assert.equal(installIdFromWorkspaceId(WORKSPACE_ID, SECRET), id, 'the same install, the same ID, after a restart');
  assert.notEqual(installIdFromWorkspaceId('org_another_install_entirely0', SECRET), id);
  // Knowing the workspace ID is not enough to compute it.
  assert.notEqual(installIdFromWorkspaceId(WORKSPACE_ID, 'some-other-key-0123456789abcdef0123'), id);
  assert.ok(!id.replaceAll('-', '').includes(WORKSPACE_ID.replace(/[^0-9a-f]/g, '').slice(0, 8)));
});

test('never in hosted mode, never with DEFT_TELEMETRY=off, never from a development build, never when paused', async () => {
  const cases: NodeJS.ProcessEnv[] = [
    HOSTED_ENV,
    { ...SELF_HOSTED_ENV, DEFT_TELEMETRY: 'off' },
    { ...SELF_HOSTED_ENV, DEFT_TELEMETRY: 'false' },
    { ...SELF_HOSTED_ENV, DEFT_TELEMETRY: '0' },
    { NODE_ENV: 'development' },
    {},
  ];
  for (const env of cases) {
    const network = useNetwork(env);
    await sendInstallPing('installed', WORKSPACE_ID);
    await sendInstallPing('person_added');
    assert.equal(network.sent.length, 0, JSON.stringify(env));
  }
  const network = useNetwork(SELF_HOSTED_ENV);
  installPingDeps.isPaused = () => true;
  await sendInstallPing('installed', WORKSPACE_ID);
  assert.equal(network.sent.length, 0, 'paused');
});

test('a failed ping is dropped and counted: one attempt, no retry, no error', async () => {
  for (const status of [500, 429, 'throw'] as const) {
    resetInstallPingForTest();
    const network = useNetwork(SELF_HOSTED_ENV, status);
    await assert.doesNotReject(sendInstallPing('person_added'));
    assert.equal(network.sent.length, 1, String(status));
    assert.deepEqual(installPingCounters(), { sent: 0, failed: 1 });
  }
});

test('a version that is not a plain release number is sent as unknown', async () => {
  const network = useNetwork(SELF_HOSTED_ENV);
  installPingDeps.version = async () => '0.3.0-acme-robotics-custom';
  await sendInstallPing('person_added');
  assert.equal((network.sent[0]!.body as { version: string }).version, 'unknown');
});

test('an install with no workspace yet sends nothing', async () => {
  const network = useNetwork(SELF_HOSTED_ENV);
  installPingDeps.firstWorkspaceId = async () => null;
  await sendInstallPing('person_added');
  assert.equal(network.sent.length, 0);
});
