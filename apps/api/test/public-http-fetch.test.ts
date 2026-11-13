import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import {
  PublicFetchError,
  fetchCalendarFeedText,
  fetchPublicHttpText,
  isPublicFetchAddress,
  publicFetchDeps,
} from '../src/lib/public-http-fetch.js';
import { icsRoutes } from '../src/routes/ics.js';

const PUBLIC_A = '93.184.216.34';
const PUBLIC_DOWN = '93.184.216.35';
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20991201T100000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const BIG = 6 * 1024 * 1024;

let server: Server;
let serverPort = 0;
let closedPort = 0;
let dns: Record<string, Array<Array<{ address: string; family: number }> | 'hang'>> = {};
let lookups: string[] = [];
let requests: Array<{ protocol: string } & RequestOptions> = [];
let bigClosedEarly: Promise<boolean> = Promise.resolve(false);
const realDeps = { ...publicFetchDeps };

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  const hop = /^\/hop\/(\d+)$/.exec(path);
  if (hop) {
    const n = Number(hop[1]);
    if (n === 0) return void res.end(ICS);
    res.writeHead(302, { location: `/hop/${n - 1}` });
    return void res.end();
  }
  const redirectTo: Record<string, string> = {
    '/to-private': 'http://internal.test/feed',
    '/to-webcal': 'webcal://pub.test/feed',
    '/to-file': 'file:///etc/passwd',
    '/to-port': 'http://pub.test:8080/feed',
    '/to-http': 'http://pub.test/feed',
    '/to-rebind': 'http://rebind.test/feed',
    '/to-userinfo': 'http://user:pw@pub.test/feed',
    '/to-relative-host': '//internal.test/feed',
  };
  if (redirectTo[path]) {
    res.writeHead(301, { location: redirectTo[path] });
    return void res.end();
  }
  const status = /^\/status\/(30[378])$/.exec(path);
  if (status) {
    res.writeHead(Number(status[1]), { location: '//pub.test/feed' });
    return void res.end();
  }
  switch (path) {
    case '/feed?key=a%0D%0Ab':
      res.setHeader('x-path', path);
      return void res.end(ICS);
    case '/feed': return void res.end(ICS);
    case '/big': {
      bigClosedEarly = new Promise((resolve) => res.once('close', () => resolve(!res.writableFinished)));
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = (): void => {
        while (sent < 64 * BIG) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    case '/big-length':
      res.writeHead(200, { 'content-length': String(BIG) });
      return void res.write('BEGIN:VCALENDAR\r\n');
    case '/slow':
      res.writeHead(200);
      return void res.write('BEGIN:VCALENDAR\r\n');
    case '/gzip-bomb':
      res.writeHead(200, { 'content-encoding': 'gzip' });
      return void res.end(gzipSync(Buffer.alloc(BIG, 0x20)));
    case '/gzip-ok':
      res.writeHead(200, { 'content-encoding': 'gzip' });
      return void res.end(gzipSync(Buffer.from(ICS)));
    case '/no-location':
      res.writeHead(302);
      return void res.end();
    case '/bad-gzip':
      res.writeHead(200, { 'content-encoding': 'gzip' });
      return void res.end('not gzip at all');
    case '/truncated':
      res.writeHead(200, { 'content-length': '1000' });
      res.write('BEGIN:VCALENDAR');
      return void setTimeout(() => res.destroy(), 20);
    case '/double-gzip':
      res.writeHead(200, { 'content-encoding': 'gzip, gzip' });
      return void res.end(gzipSync(gzipSync(Buffer.from(ICS))));
    default:
      res.writeHead(404);
      return void res.end();
  }
}

before(async () => {
  server = createServer(route);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  serverPort = (server.address() as AddressInfo).port;
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
});

after(async () => {
  Object.assign(publicFetchDeps, realDeps);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  lookups = [];
  requests = [];
  dns = {
    'pub.test': [[{ address: PUBLIC_A, family: 4 }]],
    'down.test': [[{ address: PUBLIC_DOWN, family: 4 }]],
    'internal.test': [[{ address: '10.0.0.5', family: 4 }]],
    'mixed.test': [[{ address: PUBLIC_A, family: 4 }, { address: '10.0.0.5', family: 4 }]],
    'mixed6.test': [[{ address: '2606:4700::1', family: 6 }, { address: 'fd00::1', family: 6 }]],
    'empty.test': [[]],
    'hang.test': ['hang'],
    'rebind.test': [[{ address: PUBLIC_A, family: 4 }], [{ address: '127.0.0.1', family: 4 }]],
  };
  publicFetchDeps.lookup = async (hostname: string) => {
    lookups.push(hostname);
    const answers = dns[hostname];
    if (!answers?.length) throw new Error('ENOTFOUND');
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next === 'hang') return new Promise(() => {});
    return next;
  };
  publicFetchDeps.request = (protocol, options) => {
    requests.push({ protocol, ...options });
    const port = options.hostname === PUBLIC_DOWN ? closedPort : serverPort;
    return httpRequest({ ...options, hostname: '127.0.0.1', family: 4, port });
  };
});

async function refused(promise: Promise<unknown>, kind = 'unreachable'): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof PublicFetchError && err.kind === kind);
}

const opts = { maxBytes: 5 * 1024 * 1024, timeoutMs: 2_000, accept: 'text/calendar', userAgent: 'test' };
const fetchText = (url: string, overrides: Partial<typeof opts> = {}) => fetchPublicHttpText(url, { ...opts, ...overrides });

const NON_PUBLIC = [
  '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.170.2',
  '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '240.0.0.1', '192.0.2.1',
  '198.18.0.1', '168.63.129.16', '192.80.8.124', '::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1',
  'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:168.63.129.16', '::a00:1', '64:ff9b::a00:1',
  '2001:db8::1', '2001::1', '2001:100::1', '2002:a00:1::1', '3fff::1', '5f00::1', 'not-an-ip',
];

test('only positively public unicast addresses are accepted', () => {
  for (const address of NON_PUBLIC) assert.equal(isPublicFetchAddress(address), false, address);
  for (const address of [PUBLIC_A, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1', '2a00:1450::1']) {
    assert.equal(isPublicFetchAddress(address), true, address);
  }
});

test('hostnames resolving to non-public addresses are refused before connecting', async () => {
  for (const address of NON_PUBLIC.filter((a) => a !== 'not-an-ip')) {
    dns['h.test'] = [[{ address, family: address.includes(':') ? 6 : 4 }]];
    await refused(fetchText('https://h.test/feed'));
  }
  assert.equal(requests.length, 0);
});

test('IP literals in every encoding are refused before connecting', async () => {
  const literals = [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/',
    'http://%31%32%37.0.0.1/', 'http://169.254.169.254./', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/', 'http://[0:0:0:0:0:ffff:10.0.0.1]/', 'https://[fe80::1]/', 'http://0/',
  ];
  for (const url of literals) await refused(fetchText(url));
  assert.equal(requests.length, 0);
  assert.equal(lookups.length, 0);
});

test('schemes, userinfo and ports outside the rule are refused', async () => {
  const urls = [
    'ftp://pub.test/feed', 'file:///etc/passwd', 'gopher://pub.test/', 'http://user:pw@pub.test/feed',
    'http://:pw@pub.test/feed', 'http://pub.test:8080/feed', 'http://pub.test:0/feed', 'https://pub.test:8443/feed',
    'not a url',
  ];
  for (const url of urls) await refused(fetchText(url));
  assert.equal(requests.length, 0);
});

test('a hostname with any non-public or no answer is refused', async () => {
  await refused(fetchText('http://mixed.test/feed'));
  await refused(fetchText('http://mixed6.test/feed'));
  await refused(fetchText('http://empty.test/feed'));
  await refused(fetchText('http://nxdomain.test/feed'));
  assert.equal(requests.length, 0);
});

test('the connection is pinned to the validated address with the original Host and server name', async () => {
  const text = await fetchText('https://rebind.test/feed');
  assert.equal(text.text, ICS);
  assert.deepEqual(lookups, ['rebind.test']);
  assert.equal(requests.length, 1);
  const sent = requests[0]!;
  assert.equal(sent.protocol, 'https:');
  assert.equal(sent.hostname, PUBLIC_A);
  assert.equal(sent.servername, 'rebind.test');
  assert.equal(sent.port, 443);
  assert.equal(sent.path, '/feed');
  assert.equal(sent.agent, false);
  const headers = sent.headers as Record<string, string>;
  assert.equal(headers.host, 'rebind.test');
  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
});

test('path and query are sent unchanged and the fragment is dropped', async () => {
  await fetchText('http://pub.test/feed?key=a%0D%0Ab#frag');
  assert.equal(requests[0]!.path, '/feed?key=a%0D%0Ab');
});

test('redirects re-check every hop and are bounded to three', async () => {
  assert.equal((await fetchText('http://pub.test/hop/3')).text, ICS);
  assert.equal(requests.length, 4);
  requests = [];
  await refused(fetchText('http://pub.test/hop/4'));
  assert.equal(requests.length, 4);
  for (const path of ['/to-private', '/to-webcal', '/to-file', '/to-port']) {
    await refused(fetchText(`http://pub.test${path}`));
  }
  await refused(fetchText('https://pub.test/to-http'));
  assert.equal((await fetchText('http://pub.test/to-http')).text, ICS);
  for (const path of ['/status/303', '/status/307', '/status/308']) {
    assert.equal((await fetchText(`http://pub.test${path}`)).text, ICS);
  }
  for (const path of ['/no-location', '/to-userinfo', '/to-relative-host']) {
    await refused(fetchText(`http://pub.test${path}`));
  }
  requests = [];
  await refused(fetchText('http://rebind.test/to-rebind'));
  assert.deepEqual(requests.map((r) => r.hostname), [PUBLIC_A]);
  dns['rebind.test'] = [[{ address: '127.0.0.1', family: 4 }]];
  requests = [];
  await refused(fetchText('http://pub.test/to-rebind'));
  assert.equal(requests.length, 1);
});

test('bodies over the cap are aborted while streaming', async () => {
  await refused(fetchText('http://pub.test/big'), 'too_large');
  assert.equal(await bigClosedEarly, true);
  await refused(fetchText('http://pub.test/big-length'), 'too_large');
  await refused(fetchText('http://pub.test/gzip-bomb'), 'too_large');
  await refused(fetchText('http://pub.test/double-gzip'), 'bad_encoding');
  await refused(fetchText('http://pub.test/bad-gzip'), 'bad_encoding');
  await refused(fetchText('http://pub.test/truncated'));
  assert.equal((await fetchText('http://pub.test/gzip-ok')).text, ICS);
  const exact = Buffer.byteLength(ICS);
  assert.equal((await fetchText('http://pub.test/feed', { maxBytes: exact })).text, ICS);
  await refused(fetchText('http://pub.test/feed', { maxBytes: exact - 1 }), 'too_large');
});

test('one deadline bounds DNS, connection and a slow body', async () => {
  const started = Date.now();
  await refused(fetchText('http://pub.test/slow', { timeoutMs: 300 }), 'timeout');
  await refused(fetchText('http://hang.test/feed', { timeoutMs: 300 }), 'timeout');
  assert.ok(Date.now() - started < 2_000);
  assert.equal(requests.length, 1);
});

test('public https and webcal feeds still fetch', async () => {
  assert.equal(await fetchCalendarFeedText('https://pub.test/feed'), ICS);
  assert.equal(await fetchCalendarFeedText('  WEBCAL://pub.test/feed'), ICS);
  assert.equal(requests[1]!.protocol, 'https:');
  await refused(fetchCalendarFeedText('webcal://internal.test/feed'));
});

test('feed preview answers a refused address exactly like a connection failure', async () => {
  const app = new Hono();
  app.route('/api/ics', icsRoutes);
  const preview = async (ics_url: string) => {
    const res = await app.request('/api/ics/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ics_url }),
    });
    return { status: res.status, body: await res.json() };
  };
  const refusedAddress = await preview('https://internal.test/feed');
  const connectFailure = await preview('https://down.test/feed');
  assert.equal(refusedAddress.status, 502);
  assert.deepEqual(refusedAddress, connectFailure);
  assert.deepEqual(await preview('http://169.254.169.254/latest/meta-data/'), connectFailure);
  const ok = await preview('webcal://pub.test/feed');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.calendar_name, 'Team');
});
