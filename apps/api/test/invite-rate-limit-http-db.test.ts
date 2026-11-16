import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';

// The invite routes are public and mounted before the default limiter, so
// they carry their own per-IP limiter. Use a small budget for this process.
process.env.DEFT_INVITE_RATE_LIMIT_PER_MINUTE = '3';

test('public invite routes limit socket peers despite spoofed forwarding headers', async () => {
  const { app } = await import('../src/index.js');
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const from = (peer: string, path: string, method = 'POST', headers: Record<string, string> = {}) => new Promise<{ status: number; code?: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, localAddress: peer, path, method, agent: false,
      headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, ...JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });

  try {
    const peer = '127.0.0.1';
    // Preview, legacy preview and accept share one socket-peer budget.
    assert.equal((await from(peer, '/api/invites/preview')).status, 400);
    assert.equal((await from(peer, '/api/invites/preview/not-a-token', 'GET', { 'x-forwarded-for': '198.51.100.7' })).status, 400);
    assert.equal((await from(peer, '/api/invites/accept', 'POST', { 'x-real-ip': '198.51.100.8' })).status, 400);
    for (const [path, method] of [['/api/invites/preview', 'POST'], ['/api/invites/accept', 'POST'], ['/api/invites/preview/x', 'GET']] as const) {
      const limited = await from(peer, path, method, { 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.10' });
      assert.equal(limited.status, 429, path);
      assert.equal(limited.code, 'RATE_LIMITED');
    }
    assert.equal((await from(peer, '/api/invites/preview')).status, 429);
    // A second real peer has its own budget without forwarding headers.
    for (let i = 0; i < 3; i++) assert.equal((await from('127.0.0.2', '/api/invites/preview')).status, 400);
    assert.equal((await from('127.0.0.2', '/api/invites/preview')).status, 429);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
