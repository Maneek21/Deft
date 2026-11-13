import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, mock, test } from 'node:test';
import {
  PublicFetchError,
  fetchCalendarFeedText,
  fetchPublicHttpText,
  publicFetchDeps,
} from '../src/lib/public-http-fetch.js';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20991201T100000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const FEED = 'http://cal.lan.test/dav/team.ics?export&token=s3cret';
const PORT_FEED = 'http://cal.lan.test:8080/feed';
const HTTPS_DOWNGRADE = 'https://cal.lan.test/to-http';

let server: Server;
let serverPort = 0;
let requests: Array<RequestOptions> = [];
const realDeps = { ...publicFetchDeps };
const env = { ...process.env };

function route(req: IncomingMessage, res: ServerResponse): void {
  const redirects: Record<string, string> = {
    '/redir-unlisted': '/dav/other.ics',
    '/redir-public': 'http://pub.test/feed',
    '/redir-listed': FEED,
    '/to-http': 'http://cal.lan.test/feed',
    '/pub-to-listed': FEED,
  };
  const path = (req.url ?? '/').split('?')[0]!;
  if (redirects[path]) {
    res.writeHead(302, { location: redirects[path] });
    return void res.end();
  }
  res.end(ICS);
}

before(async () => {
  server = createServer(route);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  serverPort = (server.address() as AddressInfo).port;
});

after(async () => {
  Object.assign(publicFetchDeps, realDeps);
  process.env = env;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const DNS: Record<string, string[]> = {
  'cal.lan.test': ['10.0.0.5'],
  'other.lan.test': ['10.0.0.5'],
  'pub.test': ['93.184.216.34'],
  'meta.test': ['169.254.169.254'],
  'mixmeta.test': ['10.0.0.5', '169.254.169.254'],
  'ula.test': ['fd12:3456::1'],
  'ec2meta6.test': ['fd00:ec2::254'],
  'linklocal.test': ['169.254.10.10'],
};

function allow(entries: unknown, selfHosted: string | null = 'true'): void {
  process.env = { ...env };
  if (selfHosted === null) delete process.env.DEFT_SELF_HOSTED;
  else process.env.DEFT_SELF_HOSTED = selfHosted;
  if (entries === undefined) delete process.env.DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST;
  else process.env.DEFT_CALENDAR_PRIVATE_URL_ALLOWLIST = typeof entries === 'string' ? entries : JSON.stringify(entries);
}

beforeEach(() => {
  requests = [];
  allow([FEED, PORT_FEED, HTTPS_DOWNGRADE, 'http://cal.lan.test/redir-unlisted', 'http://cal.lan.test/redir-public',
    'http://cal.lan.test/redir-listed', 'http://cal.lan.test/feed', 'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/feed', 'http://meta.test/feed', 'http://mixmeta.test/feed', 'http://ec2meta6.test/feed',
    'http://ula.test/feed', 'http://127.0.0.1:5232/user/cal/', 'https://cal.lan.test:443/secure.ics', 'http://linklocal.test/feed']);
  publicFetchDeps.lookup = async (hostname) => {
    const answers = DNS[hostname];
    if (!answers) throw new Error('ENOTFOUND');
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  publicFetchDeps.request = (_protocol, options) => {
    requests.push(options);
    return httpRequest({ ...options, hostname: '127.0.0.1', family: 4, port: serverPort, servername: undefined });
  };
});

async function refused(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof PublicFetchError && err.kind === 'unreachable');
}

test('a listed internal feed URL is fetched on a self-hosted install, pinned to the validated address', async () => {
  assert.equal(await fetchCalendarFeedText(FEED), ICS);
  assert.equal(requests[0]!.hostname, '10.0.0.5');
  assert.equal(requests[0]!.path, '/dav/team.ics?export&token=s3cret');
  assert.equal(await fetchCalendarFeedText('http://CAL.lan.test:80/dav/team.ics?export&token=s3cret#frag'), ICS);
  assert.equal(await fetchCalendarFeedText('webcal://cal.lan.test/secure.ics'), ICS);
  assert.equal(await fetchCalendarFeedText('http://ula.test/feed'), ICS);
  assert.equal(await fetchCalendarFeedText('http://127.0.0.1:5232/user/cal/'), ICS);
  assert.equal(requests[4]!.port, 5232);
});

test('the allowlist is ignored unless DEFT_SELF_HOSTED is exactly "true"', async () => {
  for (const flag of [null, 'false', 'TRUE', '1', ' true']) {
    allow([FEED], flag);
    await refused(fetchCalendarFeedText(FEED));
  }
  assert.equal(requests.length, 0);
});

test('unlisted path, query, port or host on the same server is refused', async () => {
  for (const url of [
    'http://cal.lan.test/dav/other.ics?export&token=s3cret',
    'http://cal.lan.test/dav/team.ics?token=s3cret&export',
    'http://cal.lan.test/dav/team.ics?export&token=s3cret&x=1',
    'http://cal.lan.test/dav/team.ics',
    'http://cal.lan.test/dav/',
    'http://cal.lan.test:8081/dav/team.ics?export&token=s3cret',
    'https://cal.lan.test/dav/team.ics?export&token=s3cret',
    'http://other.lan.test/dav/team.ics?export&token=s3cret',
    'http://10.0.0.5/dav/team.ics?export&token=s3cret',
  ]) await refused(fetchCalendarFeedText(url));
  assert.equal(requests.length, 0);
});

test('a listed non-standard port works only for that exact URL', async () => {
  assert.equal(await fetchCalendarFeedText(PORT_FEED), ICS);
  assert.equal(requests[0]!.port, 8080);
  await refused(fetchCalendarFeedText('http://cal.lan.test:8080/other'));
  await refused(fetchCalendarFeedText('http://pub.test:8080/feed'));
  assert.equal(requests.length, 1);
});

test('metadata and link-local addresses are refused even when listed', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/feed',
    'http://meta.test/feed',
    'http://ec2meta6.test/feed',
    'http://mixmeta.test/feed',
    'http://linklocal.test/feed',
  ]) await refused(fetchCalendarFeedText(url));
  assert.equal(requests.length, 0);
});

test('a listed request follows only redirects to another listed URL', async () => {
  await refused(fetchCalendarFeedText('http://cal.lan.test/redir-unlisted'));
  await refused(fetchCalendarFeedText('http://cal.lan.test/redir-public'));
  assert.equal(await fetchCalendarFeedText('http://cal.lan.test/redir-listed'), ICS);
  await refused(fetchCalendarFeedText(HTTPS_DOWNGRADE));
});

test('an unlisted public feed cannot redirect into a listed internal URL', async () => {
  await refused(fetchCalendarFeedText('http://pub.test/pub-to-listed'));
  assert.equal(await fetchCalendarFeedText('http://pub.test/feed'), ICS);
});

test('a malformed allowlist disables every entry and warns without printing the value', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    for (const value of ['[not json', '{"url":"http://cal.lan.test/feed"}', '["http://cal.lan.test/feed", 5]',
      '["http://cal.lan.test/feed", "ftp://cal.lan.test/x"]', '["http://cal.lan.test/feed", "http://u:p@cal.lan.test/feed"]']) {
      allow(value);
      await refused(fetchCalendarFeedText('http://cal.lan.test/feed'));
      await refused(fetchCalendarFeedText('http://cal.lan.test/feed'));
    }
    assert.equal(requests.length, 0);
    assert.equal(warn.mock.callCount(), 5);
    for (const call of warn.mock.calls) {
      const text = call.arguments.map(String).join(' ');
      assert.ok(!text.includes('cal.lan.test') && !text.includes('u:p'), text);
    }
  } finally {
    warn.mock.restore();
  }
});

test('an entry or request with credentials is never fetched', async () => {
  allow(['http://u:p@cal.lan.test/feed']);
  const warn = mock.method(console, 'warn', () => {});
  try {
    await refused(fetchCalendarFeedText('http://cal.lan.test/feed'));
    await refused(fetchCalendarFeedText('http://u:p@cal.lan.test/feed'));
  } finally {
    warn.mock.restore();
  }
  assert.equal(requests.length, 0);
});

test('link previews never use the calendar allowlist', async () => {
  await refused(fetchPublicHttpText(FEED, { maxBytes: 1024 * 1024, timeoutMs: 2_000, accept: '*/*', userAgent: 'test' }));
  await refused(fetchPublicHttpText(PORT_FEED, { maxBytes: 1024 * 1024, timeoutMs: 2_000, accept: '*/*', userAgent: 'test' }));
  assert.equal(requests.length, 0);
});

test('the sync worker logs only the subscription id and host, and stores the humanised error', async () => {
  const sets: Array<Record<string, unknown>> = [];
  const chain = {
    set(value: Record<string, unknown>) { sets.push(value); return chain; },
    where() { return Promise.resolve(); },
    values() { return chain; },
    onConflictDoUpdate() { return Promise.resolve(); },
  };
  const subRow = { id: 'sub-1', org_id: 'o', user_id: 'u', ics_url: 'http://cal.lan.test/dav/unlisted.ics?token=s3cret', label: null, sync_interval_min: 15 };
  mock.module(new URL('../src/lib/db.ts', import.meta.url).href, {
    namedExports: { db: { update: () => chain, insert: () => chain, execute: async () => ({ rows: [subRow] }) } },
  });
  const { syncOne, handleIcsSync } = await import('../src/workers/handlers/ics-sync.js');
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  try {
    await syncOne({ ...subRow, ics_url: FEED });
    await handleIcsSync({} as never);
    const printed = [...log.mock.calls, ...warn.mock.calls].map((c) => c.arguments.map(String).join(' ')).join('\n');
    assert.match(printed, /sub sub-1 synced 1 event\(s\) from host cal\.lan\.test/);
    assert.ok(!printed.includes('/dav') && !printed.includes('s3cret') && !printed.includes('export'), printed);
    assert.equal(sets.at(-1)!.last_error, 'Could not reach the feed URL.');
  } finally {
    log.mock.restore();
    warn.mock.restore();
  }
});
