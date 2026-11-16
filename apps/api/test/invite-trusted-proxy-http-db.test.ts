import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';

process.env.DEFT_INVITE_RATE_LIMIT_PER_MINUTE = '3';
process.env.DEFT_INVITE_TRUSTED_PROXIES = 'localhost';

test('configured proxy separates invite visitors and untrusted peers cannot forge their address', async () => {
  const { app } = await import('../src/index.js');
  const upstream = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  const servers: Server[] = [upstream];
  try {
    if (!upstream.listening) await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const proxy = createServer((req, res) => {
      // Caddy's default: replace untrusted incoming XFF with the socket client.
      const forwarded = request({ hostname: '127.0.0.1', localAddress: '127.0.0.1', port: upstreamPort,
        path: req.url, method: req.method, agent: false,
        headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress! } }, response => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      });
      forwarded.on('error', error => res.destroy(error));
      req.pipe(forwarded);
    });
    servers.push(proxy);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyPort = (proxy.address() as AddressInfo).port;
    const send = (port: number, peer: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, localAddress: peer, agent: false,
        path: '/api/invites/preview', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        res.resume();
        res.on('error', reject);
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.end('{}');
    });
    // More than one peer budget's total traffic through one proxy still works.
    for (const peer of ['127.0.0.2', '127.0.0.3']) {
      for (let i = 0; i < 3; i++) assert.equal(await send(proxyPort, peer), 400);
      assert.equal(await send(proxyPort, peer), 429);
      assert.equal(await send(proxyPort, peer, { 'x-forwarded-for': '198.51.100.17', 'x-real-ip': '198.51.100.18' }), 429);
    }
    // Another loopback peer is not trusted just because it is private/local.
    for (let i = 0; i < 3; i++) assert.equal(await send(upstreamPort, '127.0.0.4', { 'x-forwarded-for': `198.51.100.${i}` }), 400);
    assert.equal(await send(upstreamPort, '127.0.0.4', { 'x-forwarded-for': '198.51.100.99' }), 429);
  } finally {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  }
});
