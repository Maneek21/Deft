import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import webpush from 'web-push';

// web-push reads its VAPID settings when lib/env.ts first loads.
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:push-test@example.test';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const orgId = `push-endpoint-${randomUUID()}`;
const userId = randomUUID();
let client: pg.Client;
let app: Hono;
let sendPushTest: typeof import('../src/lib/web-push.js')['sendPushTest'];
let deps: typeof import('../src/lib/public-http-fetch.js')['publicFetchDeps'];

before(async () => {
  if (!databaseUrl) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [orgId]);
  await client.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [userId, `${userId}@example.test`]);
  await client.query('INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1,$2,$3,$4)', [randomUUID(), orgId, userId, 'member']);
  const { pushRoutes } = await import('../src/routes/push.js');
  ({ sendPushTest } = await import('../src/lib/web-push.js'));
  ({ publicFetchDeps: deps } = await import('../src/lib/public-http-fetch.js'));
  app = new Hono();
  app.use('*', async (c, next) => { c.set('user', { id: userId, org_id: orgId } as never); await next(); });
  app.route('/api/push', pushRoutes);
});

after(async () => {
  if (!databaseUrl) return;
  await client.query('DELETE FROM web_push_subscriptions WHERE org_id=$1', [orgId]);
  await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
  await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
  await client.query('DELETE FROM users WHERE id=$1', [userId]);
  await client.end();
  (await import('../src/lib/db.js')).closeDb();
});

function setHosted(t: test.TestContext, on: boolean) {
  const old = process.env.DEFT_HOSTED;
  if (on) process.env.DEFT_HOSTED = 'true'; else delete process.env.DEFT_HOSTED;
  t.after(() => { if (old === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = old; });
}

/** DNS answers by hostname; anything else fails to resolve. */
function fakeDns(t: test.TestContext, answers: Record<string, string>) {
  const original = deps.lookup;
  const asked: string[] = [];
  deps.lookup = async (hostname) => {
    asked.push(hostname);
    const address = answers[hostname];
    if (!address) throw new Error('ENOTFOUND');
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  };
  t.after(() => { deps.lookup = original; });
  return asked;
}

const subscribe = (endpoint: string) => app.request('/api/push/subscribe', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ endpoint, keys: { p256dh: keys.publicKey, auth: 'abcdefghijklmnop' } }),
});

async function refused(endpoint: string) {
  const res = await subscribe(endpoint);
  assert.equal(res.status, 400, endpoint);
  assert.equal((await res.json()).code, 'PUSH_ENDPOINT_REFUSED', endpoint);
}

test('subscribe refuses endpoints that are not https or that reach internal addresses (every mode)', { skip: !databaseUrl }, async (t) => {
  setHosted(t, false);
  fakeDns(t, { 'internal.example.test': '10.1.2.3', 'metadata.example.test': '169.254.169.254', 'push.example.test': '93.184.216.34' });
  for (const endpoint of [
    'http://push.example.test/send/1',
    'https://10.0.0.5/send/1',
    'https://127.0.0.1/send/1',
    'https://[::1]/send/1',
    'https://internal.example.test/send/1',
    'https://metadata.example.test/send/1',
    'https://push.example.test:8443/send/1',
    'https://user:pw@push.example.test/send/1',
    'https://unresolvable.example.test/send/1',
  ]) await refused(endpoint);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM web_push_subscriptions WHERE org_id=$1', [orgId]);
  assert.equal(rows[0].n, 0);
  // Self-hosted: any public https push service is accepted.
  assert.equal((await subscribe('https://push.example.test/send/self-hosted')).status, 201);
});

test('hosted: only the known browser push services are accepted', { skip: !databaseUrl }, async (t) => {
  setHosted(t, true);
  fakeDns(t, {
    'push.example.test': '93.184.216.34',
    'fcm.googleapis.com': '142.250.1.1',
    'wns2-par02p.notify.windows.com': '20.1.1.1',
    'api.push.apple.com': '17.1.1.1',
    'notify.windows.com.attacker.test': '93.184.216.35',
  });
  await refused('https://push.example.test/send/hosted');
  await refused('https://notify.windows.com.attacker.test/send/1');
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://api.push.apple.com/3/device/abc',
  ]) assert.equal((await subscribe(endpoint)).status, 201, endpoint);
});

test('sending never contacts an endpoint that now resolves internally, and pins the checked address', { skip: !databaseUrl }, async (t) => {
  setHosted(t, false);
  await client.query('DELETE FROM web_push_subscriptions WHERE org_id=$1', [orgId]);
  fakeDns(t, { 'rebind.example.test': '93.184.216.34' });
  assert.equal((await subscribe('https://rebind.example.test/send/1')).status, 201);

  const calls: Array<{ endpoint: string; agent: unknown }> = [];
  t.mock.method(webpush, 'sendNotification', async (subscription: { endpoint: string }, _payload: unknown, options: { agent?: unknown }) => {
    calls.push({ endpoint: subscription.endpoint, agent: options?.agent });
    return { statusCode: 201, body: '', headers: {} };
  });

  // The name now points inside the network: nothing is sent.
  deps.lookup = async () => [{ address: '10.9.9.9', family: 4 }];
  assert.deepEqual(await sendPushTest({ orgId, userId }), { sent: 0, configured: true });
  assert.equal(calls.length, 0);

  // Public again: sent through an agent that resolves only to the checked address.
  deps.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.deepEqual(await sendPushTest({ orgId, userId }), { sent: 1, configured: true });
  assert.equal(calls.length, 1);
  const agent = calls[0]!.agent as { options: { lookup: (h: string, o: object, cb: (...a: unknown[]) => void) => void } };
  const resolved = await new Promise<unknown[]>((resolve) => agent.options.lookup('rebind.example.test', {}, (...args) => resolve(args)));
  assert.deepEqual(resolved, [null, '93.184.216.34', 4]);
  const all = await new Promise<unknown[]>((resolve) => agent.options.lookup('rebind.example.test', { all: true }, (...args) => resolve(args)));
  assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]]);
});
