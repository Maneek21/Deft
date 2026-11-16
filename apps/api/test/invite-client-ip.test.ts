import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createInviteClientKey } from '../src/lib/invite-client-ip.js';

function keyReader(configured: string, lookup?: Parameters<typeof createInviteClientKey>[1]) {
  const key = createInviteClientKey(configured, lookup);
  const app = new Hono();
  app.get('/', async c => c.text(await key(c)));
  return async (peer?: string, headers: Record<string, string> = {}) => {
    const response = await app.fetch(new Request('http://api.test/', { headers }),
      peer ? { incoming: { socket: { remoteAddress: peer } } } : {});
    return response.text();
  };
}

test('unset proxy trust ignores forwarding headers, including on private peers', async () => {
  const read = keyReader('');
  assert.equal(await read('10.0.0.7', { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' }), '10.0.0.7');
  assert.equal(await read('127.0.0.1', { 'x-forwarded-for': '198.51.100.3' }), '127.0.0.1');
  assert.equal(await read(undefined, { 'x-forwarded-for': '198.51.100.3' }), 'unknown');
});

test('only exact configured peers can supply the rightmost forwarded client', async () => {
  const read = keyReader(' 10.0.0.2 , 10.0.0.3 ');
  assert.equal(await read('10.0.0.2', { 'x-forwarded-for': '198.51.100.99, 198.51.100.7' }), '198.51.100.7');
  assert.equal(await read('10.0.0.3', { 'x-forwarded-for': 'changed-by-caller, 198.51.100.7' }), '198.51.100.7');
  assert.equal(await read('10.0.0.4', { 'x-forwarded-for': '198.51.100.8' }), '10.0.0.4');
});

test('missing or invalid final XFF entry falls back to the configured socket peer', async () => {
  const read = keyReader('10.0.0.2');
  for (const value of ['', 'unknown', '198.51.100.7,', '198.51.100.7:1234', '[2001:db8::7]', 'fe80::1%eth0']) {
    assert.equal(await read('10.0.0.2', { 'x-forwarded-for': value, 'x-real-ip': '198.51.100.99' }), '10.0.0.2', value);
  }
  assert.equal(await read('10.0.0.2', { 'x-real-ip': '198.51.100.99' }), '10.0.0.2');
});

test('equivalent IPv6 and IPv4-mapped addresses cannot create alternate keys', async () => {
  const read = keyReader('2001:0db8:0:0:0:0:0:2, 10.0.0.2');
  assert.equal(await read('2001:db8::2', { 'x-forwarded-for': '2001:0DB8:0:0:0:0:0:7' }), '2001:db8::7');
  assert.equal(await read('::ffff:a00:2', { 'x-forwarded-for': '0:0:0:0:0:ffff:c633:6407' }), '198.51.100.7');
  assert.equal(await read('::ffff:10.0.0.2'), '10.0.0.2');
});

test('configured proxy DNS matches current answers and drops trust in replaced container IPs', async () => {
  let address = '10.0.0.2';
  const names: string[] = [];
  const read = keyReader('caddy', async name => { names.push(name); return [{ address: '2001:db8::2' }, { address }]; });
  const headers = { 'x-forwarded-for': '198.51.100.7' };
  assert.equal(await read('10.0.0.2', headers), '198.51.100.7');
  address = '10.0.0.3';
  assert.equal(await read('10.0.0.2', headers), '10.0.0.2');
  assert.equal(await read('10.0.0.3', headers), '198.51.100.7');
  assert.equal(await read('2001:0db8::2', headers), '198.51.100.7');
  assert.deepEqual(names, ['caddy', 'caddy', 'caddy', 'caddy']);
});

test('unresolvable proxy names and malformed configuration never grant forwarding trust', async () => {
  const read = keyReader('missing,10.0.0.0/8,*', async () => { throw new Error('unresolved'); });
  assert.equal(await read('10.0.0.2', { 'x-forwarded-for': '198.51.100.7' }), '10.0.0.2');
});
