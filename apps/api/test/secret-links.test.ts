import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { requestLogger } from '../src/lib/request-logger.js';
import { buildInviteUrl, buildRecoveryUrl } from '../src/lib/secret-links.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJ5ZXMifQ.c2lnbmF0dXJlLXNlY3JldA';

test('invite and recovery links carry the token only after #', () => {
  for (const [link, path] of [
    [buildInviteUrl('https://app.example.test', TOKEN), '/invite'],
    [buildRecoveryUrl('https://app.example.test', TOKEN), '/reset-password'],
    [buildInviteUrl('https://app.example.test/', TOKEN), '/invite'],
    [buildRecoveryUrl('https://app.example.test//', TOKEN), '/reset-password'],
  ] as const) {
    const [beforeHash, fragment] = link.split('#');
    assert.equal(beforeHash, `https://app.example.test${path}`);
    assert.ok(!beforeHash!.includes(TOKEN));
    assert.equal(new URLSearchParams(fragment).get('token'), TOKEN);
    const url = new URL(link);
    assert.equal(url.pathname, path);
    assert.equal(url.search, '');
  }
});

test('links encode characters that would break the fragment', () => {
  const link = buildInviteUrl('https://app.example.test', 'a&b=c#d');
  assert.equal(link, 'https://app.example.test/invite#token=a%26b%3Dc%23d');
  assert.equal(new URLSearchParams(new URL(link).hash.slice(1)).get('token'), 'a&b=c#d');
});

test('fragment links and POST bodies keep secrets out of real HTTP request lines and logs', async () => {
  // Transport proof, not a mounted Next page: use the production link builders
  // and logger, with landing/body handlers that only verify the wire contents.
  const proxyLines: string[] = [];
  const serverLines: string[] = [];
  const appLines: string[] = [];
  const bodies: string[] = [];
  const app = new Hono();
  app.use('*', requestLogger);
  app.get('/invite', c => c.text('landing'));
  app.get('/reset-password', c => c.text('landing'));
  app.get('/invite/:token', c => c.text('legacy landing'));
  app.post('/api/*', async c => {
    const body = await c.req.json() as { token: string };
    assert.equal(body.token, TOKEN, 'the secret reaches the body handler');
    bodies.push(c.req.path);
    return c.json({ ok: true });
  });
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { appLines.push(args.map(String).join(' ')); };
  const servers: Server[] = [];
  const send = (url: string, body?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    // No pooled client sockets: this also works with the API runner's forced
    // process exit on Windows. Node serializes the URL without its fragment.
    const outgoing = request(new URL(url), { agent: false, method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, text }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
  try {
    const upstream = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    servers.push(upstream);
    upstream.on('request', req => serverLines.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`));
    if (!upstream.listening) await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy = createServer((req, res) => {
      proxyLines.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`);
      const forwarded = request({ hostname: '127.0.0.1', port: upstreamPort, agent: false,
        path: req.url, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      });
      forwarded.on('error', error => res.destroy(error));
      req.pipe(forwarded);
    });
    servers.push(proxy);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    for (const link of [buildInviteUrl(origin, TOKEN), buildRecoveryUrl(origin, TOKEN)]) {
      assert.deepEqual(await send(link), { status: 200, text: 'landing' });
    }
    for (const path of ['/api/invites/preview', '/api/invites/accept', '/api/auth/reset-password']) {
      const response = await send(`${origin}${path}`, JSON.stringify({ token: TOKEN }));
      assert.equal(response.status, 200);
    }
    assert.deepEqual(bodies, ['/api/invites/preview', '/api/invites/accept', '/api/auth/reset-password']);
    assert.deepEqual(proxyLines, serverLines);
    assert.equal(proxyLines.length, 5);
    assert.equal(appLines.length, 10);
    for (const line of [...proxyLines, ...serverLines, ...appLines]) {
      assert.ok(!line.includes(TOKEN), line);
      assert.ok(!line.includes('#') && !line.includes('?token='), line);
    }
    // Negative control: old links DO expose the token on the first request.
    for (const link of [`${origin}/invite/${TOKEN}`, `${origin}/reset-password?token=${TOKEN}`]) {
      assert.equal((await send(link)).status, 200);
    }
    for (const line of [...proxyLines.slice(5), ...serverLines.slice(5)]) {
      assert.ok(line.includes(TOKEN), 'legacy URLs reach both HTTP hops with the secret');
    }
  } finally {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    console.log = originalLog;
  }
});
