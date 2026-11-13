import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import { icsPublicRoutes, icsRoutes } from '../src/routes/ics.js';

const FEED = 'https://calendar.example.test/private/SECRETTOKEN123/basic.ics?key=QUERYSECRET456';

function mount() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: 'user-1', org_id: 'org-1' } as never);
    await next();
  });
  app.route('/', icsRoutes);
  app.route('/pub', icsPublicRoutes);
  return app;
}

function failingChain(): unknown {
  const boom = () => Promise.reject(new Error(`insert into ics_subscriptions params: ${FEED}`));
  const chain: Record<string, unknown> = {};
  for (const k of ['values', 'set', 'where', 'from', 'limit', 'returning']) chain[k] = () => chain;
  chain.then = (res: unknown, rej: unknown) => boom().then(res as never, rej as never);
  return chain;
}

test('calendar feed route failures return and log a neutral message', async () => {
  const logged: unknown[][] = [];
  const origs = { error: console.error, warn: console.warn, log: console.log, insert: db.insert, update: db.update, del: db.delete, select: db.select };
  console.error = (...a: unknown[]) => void logged.push(a);
  console.warn = (...a: unknown[]) => void logged.push(a);
  console.log = (...a: unknown[]) => void logged.push(a);
  (db as any).insert = failingChain;
  (db as any).update = failingChain;
  (db as any).delete = failingChain;
  (db as any).select = failingChain;
  try {
    const app = mount();
    const json = { 'content-type': 'application/json' };
    const calls: Array<[string, string, string | undefined]> = [
      ['POST', '/subscriptions', JSON.stringify({ ics_url: FEED })],
      ['PATCH', '/subscriptions/sub-1', JSON.stringify({ label: 'x' })],
      ['DELETE', '/subscriptions/sub-1', undefined],
      ['POST', '/subscriptions/sub-1/sync', undefined],
      ['GET', '/subscriptions', undefined],
      ['GET', '/my-feed-url', undefined],
      ['POST', '/my-feed-url/regenerate', undefined],
      ['GET', '/pub/feed/' + 'T'.repeat(20), undefined],
      ['PATCH', '/subscriptions/' + encodeURIComponent(FEED), JSON.stringify({ label: 'x' })],
    ];
    for (const [method, path, body] of calls) {
      const res = await app.request(path, { method, headers: json, body });
      const text = await res.text();
      assert.equal(res.status, 500, `${method} ${path}`);
      assert.deepEqual(JSON.parse(text), { error: 'Calendar feed request failed', code: 'ICS_ROUTE_FAILED' });
      assert.doesNotMatch(text, /SECRETTOKEN123|QUERYSECRET456|calendar\.example\.test/);
    }
    const all = JSON.stringify(logged.map((l) => l.map((x) => (x instanceof Error ? `${x.message}${x.stack}` : x))));
    assert.ok(logged.length >= calls.length, 'failures are logged');
    assert.doesNotMatch(all, /SECRETTOKEN123|QUERYSECRET456|calendar\.example\.test/);
    assert.match(all, /user-1/);
  } finally {
    Object.assign(console, { error: origs.error, warn: origs.warn, log: origs.log });
    (db as any).insert = origs.insert; (db as any).update = origs.update; (db as any).delete = origs.del; (db as any).select = origs.select;
  }
});
