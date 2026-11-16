import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, createConnection } from 'node:net';
import {
  isKnownPushService,
  pinnedPushAgent,
  PushEndpointRefusedError,
  pushAgentFor,
  resolvePushEndpoint,
} from '../src/lib/push-endpoint.js';
import { publicFetchDeps } from '../src/lib/public-http-fetch.js';

function setHosted(t: test.TestContext, on: boolean) {
  const old = process.env.DEFT_HOSTED;
  if (on) process.env.DEFT_HOSTED = 'true'; else delete process.env.DEFT_HOSTED;
  t.after(() => { if (old === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = old; });
}

function fakeDns(t: test.TestContext, answers: Record<string, string[]>) {
  const original = publicFetchDeps.lookup;
  publicFetchDeps.lookup = async (hostname) => {
    const found = answers[hostname];
    if (!found) throw new Error('ENOTFOUND');
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  t.after(() => { publicFetchDeps.lookup = original; });
}

const refuses = (endpoint: string) => assert.rejects(resolvePushEndpoint(endpoint), PushEndpointRefusedError, endpoint);

test('every mode: only https endpoints on port 443 that resolve to public addresses', async (t) => {
  setHosted(t, false);
  fakeDns(t, {
    'internal.example.test': ['10.1.2.3'],
    'mixed.example.test': ['93.184.216.34', '192.168.1.10'],
    'metadata.example.test': ['169.254.169.254'],
    'push.example.test': ['93.184.216.34'],
  });
  for (const endpoint of [
    'http://push.example.test/send/1',
    'ftp://push.example.test/send/1',
    'not a url',
    'https://user:pw@push.example.test/send/1',
    'https://push.example.test:8443/send/1',
    'https://10.0.0.5/send/1',
    'https://127.0.0.1/send/1',
    'https://[::1]/send/1',
    'https://internal.example.test/send/1',
    'https://mixed.example.test/send/1',
    'https://metadata.example.test/send/1',
    'https://unresolvable.example.test/send/1',
  ]) await refuses(endpoint);
  assert.deepEqual(await resolvePushEndpoint('https://push.example.test/send/1'), [{ address: '93.184.216.34', family: 4 }]);
});

test('hosted: only the known browser push services', async (t) => {
  setHosted(t, true);
  fakeDns(t, {
    'push.example.test': ['93.184.216.34'],
    'fcm.googleapis.com': ['142.250.1.1'],
    'updates.push.services.mozilla.com': ['34.1.1.1'],
    'web.push.apple.com': ['17.1.1.1'],
    'api.push.apple.com': ['17.1.1.2'],
    'wns2-par02p.notify.windows.com': ['20.1.1.1'],
    'notify.windows.com.attacker.test': ['93.184.216.35'],
    'fcm.googleapis.com.attacker.test': ['93.184.216.36'],
  });
  await refuses('https://push.example.test/send/1');
  await refuses('https://notify.windows.com.attacker.test/send/1');
  await refuses('https://fcm.googleapis.com.attacker.test/send/1');
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://api.push.apple.com/3/device/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) await resolvePushEndpoint(endpoint);
  assert.equal(isKnownPushService('notify.windows.com'), false, 'the bare suffix is not a host');
  assert.equal(isKnownPushService('FCM.googleapis.com.'), true);
});

test('hosted: a known service that resolves to an internal address is still refused', async (t) => {
  setHosted(t, true);
  fakeDns(t, { 'fcm.googleapis.com': ['10.0.0.1'] });
  await refuses('https://fcm.googleapis.com/fcm/send/abc');
});

test('the send agent connects only to the checked address', async (t) => {
  setHosted(t, false);
  fakeDns(t, { 'push.example.test': ['93.184.216.34'] });
  const agent = await pushAgentFor('https://push.example.test/send/1') as unknown as {
    options: { lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void };
  };
  const one = await new Promise<unknown[]>((resolve) => agent.options.lookup('push.example.test', {}, (...a) => resolve(a)));
  assert.deepEqual(one, [null, '93.184.216.34', 4]);
  const all = await new Promise<unknown[]>((resolve) => agent.options.lookup('anything.else', { all: true }, (...a) => resolve(a)));
  assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]]);
  const v6 = pinnedPushAgent([{ address: '2606:4700::1', family: 6 }]) as unknown as typeof agent;
  const six = await new Promise<unknown[]>((resolve) => v6.options.lookup('x', {}, (...a) => resolve(a)));
  assert.deepEqual(six, [null, '2606:4700::1', 6]);
});

test('the web-push library accepts the pinned agent (it ignores anything that is not an https.Agent)', async () => {
  const webpush = (await import('web-push')).default;
  const keys = webpush.generateVAPIDKeys();
  const agent = pinnedPushAgent([{ address: '93.184.216.34', family: 4 }]);
  const details = webpush.generateRequestDetails(
    { endpoint: 'https://push.example.test/send/1', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } },
    'x', { agent, vapidDetails: { subject: 'mailto:t@example.test', publicKey: keys.publicKey, privateKey: keys.privateKey } },
  ) as { agent?: unknown };
  assert.equal(details.agent, agent);
});

test('push lookup preserves every validated address without resolving again', async (t) => {
  setHosted(t, false);
  const addresses = [{ address: '2606:4700::1', family: 6 }, { address: '93.184.216.34', family: 4 }];
  let lookups = 0;
  t.mock.method(publicFetchDeps, 'lookup', async () => { lookups += 1; return addresses; });
  const agent = await pushAgentFor('https://push.example.test/send/1');
  const lookup = agent.options.lookup!;
  try {
    const all = await new Promise((resolve, reject) => lookup('push.example.test', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
    assert.deepEqual(all, addresses);
    await new Promise((resolve, reject) => lookup('push.example.test', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
    assert.equal(lookups, 1, 'connection attempts reuse only the checked addresses');
  } finally { agent.destroy(); }
});

test('pinned lookup lets Node fall back from an unreachable address to a reachable address', { timeout: 5000 }, async () => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  // Local transport fixture: IPv6 loopback has no listener, IPv4 does.
  const agent = pinnedPushAgent([
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ]);
  const socket = createConnection({
    host: 'checked-push.example.test', port: (server.address() as { port: number }).port,
    lookup: agent.options.lookup, autoSelectFamily: true,
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    assert.equal(socket.remoteAddress, '127.0.0.1');
  } finally {
    socket.destroy(); agent.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
