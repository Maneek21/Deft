import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { publicFetchDeps } from '../src/lib/public-http-fetch.js';
import { extractLinkMetadata, fetchLinkPreview } from '../src/lib/link-preview.js';

const PUBLIC_A = '93.184.216.34';
const PAGE = '<html><head><title>T</title><meta property="og:title" content="Hello">'
  + '<meta content="World" name="description"><link rel="icon" href="/fav.ico"></head></html>';

let server: Server;
let serverPort = 0;
let requests: Array<{ protocol: string } & RequestOptions> = [];
let lookups: string[] = [];
let dns: Record<string, Array<{ address: string; family: number }>> = {};
let pageBody = PAGE;
const realDeps = { ...publicFetchDeps };

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  const hop = /^\/hop\/(\d+)$/.exec(path);
  if (hop) {
    const n = Number(hop[1]);
    if (n === 0) return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    return void res.writeHead(302, { location: `/hop/${n - 1}` }).end();
  }
  if (path === '/to-private') return void res.writeHead(302, { location: 'http://internal.test/page' }).end();
  if (path === '/to-metadata') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/' }).end();
  if (path === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageBody);
}

before(async () => {
  server = createServer(route);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  serverPort = (server.address() as AddressInfo).port;
});

after(async () => {
  Object.assign(publicFetchDeps, realDeps);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  lookups = [];
  pageBody = PAGE;
  dns = {
    'pub.test': [{ address: PUBLIC_A, family: 4 }],
    'internal.test': [{ address: '10.0.0.5', family: 4 }],
    'mixed.test': [{ address: PUBLIC_A, family: 4 }, { address: '192.168.0.1', family: 4 }],
    'meta.test': [{ address: '169.254.169.254', family: 4 }],
    'loop6.test': [{ address: '::1', family: 6 }],
  };
  publicFetchDeps.lookup = async (hostname: string) => {
    lookups.push(hostname);
    const answers = dns[hostname];
    if (!answers) throw new Error('ENOTFOUND');
    return answers;
  };
  publicFetchDeps.request = (protocol, options) => {
    requests.push({ protocol, ...options });
    return httpRequest({ ...options, hostname: '127.0.0.1', family: 4, port: serverPort });
  };
});

test('link previews are fetched only from public addresses', async () => {
  const refusedUrls = [
    'http://internal.test/page', 'http://mixed.test/page', 'http://meta.test/page', 'http://loop6.test/page',
    'http://127.0.0.1/page', 'http://2130706433/page', 'http://0x7f.0.0.1/page', 'http://[::ffff:10.0.0.1]/page',
    'http://169.254.169.254/latest/', 'http://pub.test:8080/page', 'http://user:pw@pub.test/page',
  ];
  refusedUrls.push(`http://127.0.0.1:${serverPort}/page`);
  for (const url of refusedUrls) assert.equal(await fetchLinkPreview(url), null, url);
  assert.equal(requests.length, 0);
});

test('link preview redirects are re-checked and bounded', async () => {
  assert.equal(await fetchLinkPreview('http://pub.test/to-private'), null);
  assert.equal(await fetchLinkPreview('http://pub.test/to-metadata'), null);
  assert.equal(requests.length, 2);
  assert.equal((await fetchLinkPreview('http://pub.test/hop/3'))?.title, 'Hello');
  requests = [];
  assert.equal(await fetchLinkPreview('http://pub.test/hop/4'), null);
  assert.equal(requests.length, 4);
});

test('a public page still previews through a pinned connection', async () => {
  const preview = await fetchLinkPreview('http://pub.test/page');
  assert.deepEqual(preview, {
    url: 'http://pub.test/page',
    title: 'Hello',
    description: 'World',
    image: null,
    favicon: 'http://pub.test/fav.ico',
    siteName: null,
  });
  assert.equal(requests[0]!.hostname, PUBLIC_A);
  assert.equal((requests[0]!.headers as Record<string, string>).host, 'pub.test');
  assert.equal(await fetchLinkPreview('http://pub.test/json'), null);
});

test('metadata parsing respects quoting and attribute names', () => {
  const parse = (head: string) => extractLinkMetadata(`<html><head>${head}</head></html>`, 'http://pub.test/a/b');
  assert.equal(parse('<meta property="og:title" content="A > B < C">')?.title, 'A > B < C');
  assert.equal(parse(`<meta data-v1="content='Wrong'" property="og:title" content="Right">`)?.title, 'Right');
  assert.equal(parse('<meta x1property="other" property="og:title" content="Right">')?.title, 'Right');
  assert.equal(parse(`<meta data-x="${'z'.repeat(5000)}" property="og:title" content="Long">`)?.title, 'Long');
  assert.equal(parse(`<title>${'t'.repeat(5000)}</title>`)?.title, 't'.repeat(5000));
  assert.equal(parse("<META CONTENT='D' NAME='Description'>")?.description, 'D');
  assert.equal(parse('<link href="/i.png" rel="shortcut icon"><title>T</title>')?.favicon, 'http://pub.test/i.png');
});

test('metadata parsing stays fast on pathological markup', () => {
  const tags = `<meta ${'a'.repeat(4080)}>`.repeat(64) + `<meta ${'a1 '.repeat(1360)}>`.repeat(64);
  const quotes = '<meta a="'.repeat(20_000);
  for (let warm = 0; warm < 3; warm += 1) extractLinkMetadata(tags.slice(0, 50_000), 'http://pub.test/page');
  for (const html of [tags, quotes]) {
    const started = Date.now();
    extractLinkMetadata(html, 'http://pub.test/page');
    assert.ok(Date.now() - started < 100, `took ${Date.now() - started} ms`);
  }
});

test('metadata parsing stays linear on unterminated tags', () => {
  const html = '<title>T</title>' + '<meta a'.repeat(10_000) + '<link href'.repeat(10_000);
  const started = Date.now();
  assert.equal(extractLinkMetadata(html, 'http://pub.test/page')?.title, 'T');
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
});
