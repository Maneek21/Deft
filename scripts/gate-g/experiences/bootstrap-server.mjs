import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hostPort = Number(process.env.GATE_G_BOOTSTRAP_HOST_PORT || 4313);
const appPort = Number(process.env.GATE_G_BOOTSTRAP_APP_PORT || 4314);
const useHttps = process.env.GATE_G_BOOTSTRAP_TLS === '1';
const scheme = useHttps ? 'https' : 'http';
const hostOrigin = `${scheme}://127.0.0.1:${hostPort}`;
const appOrigin = `${scheme}://localhost:${appPort}`;
const createServer = useHttps
  ? handler => createHttpsServer({ key: readFileSync(process.env.GATE_G_BOOTSTRAP_KEY), cert: readFileSync(process.env.GATE_G_BOOTSTRAP_CERT) }, handler)
  : createHttpServer;
const hits = [];
const record = (side, req, url, method = req.method) => {
  const hit = { side, path: url.pathname, channel: url.searchParams.get('channel'), method, cookiePresent: Boolean(req.headers.cookie), at: new Date().toISOString() };
  hits.push(hit);
  console.log(JSON.stringify({ event: 'bootstrap-request', ...hit }));
};
const common = res => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
};
const sink = (side, req, res, url) => {
  record(side, req, url);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('synthetic sink');
};
const host = createServer(async (req, res) => {
  common(res);
  const url = new URL(req.url || '/', hostOrigin);
  if (url.pathname === '/observations') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(hits)); return; }
  if (url.pathname === '/reset' && req.method === 'POST') { hits.length = 0; res.end('ok'); return; }
  if (url.pathname === '/sink') { sink('host', req, res, url); return; }
  if (url.pathname === '/' || url.pathname === '/bootstrap-host.js') {
    record('host', req, url);
    res.setHeader('Content-Type', url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    const filename = url.pathname === '/' ? 'bootstrap-host.html' : 'bootstrap-host.js';
    res.end((await readFile(join(here, filename), 'utf8')).replaceAll('__APP_ORIGIN__', appOrigin));
    return;
  }
  res.writeHead(404); res.end('not found');
});
host.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', hostOrigin);
  if (url.pathname === '/sink') record('host', req, url, 'UPGRADE');
  socket.destroy();
});

const app = createServer(async (req, res) => {
  common(res);
  const url = new URL(req.url || '/', appOrigin);
  if (url.pathname === '/sink') { sink('app', req, res, url); return; }
  if (url.pathname !== '/bootstrap') { res.writeHead(404); res.end('not found'); return; }
  record('app', req, url);
  const nonce = randomBytes(18).toString('base64');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${hostOrigin}`;
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const authorBase64 = (await readFile(join(here, 'bootstrap-author-worker.js'))).toString('base64');
  const bootstrap = await readFile(join(here, 'bootstrap-trusted.js'), 'utf8');
  res.end(`<!doctype html><html><meta charset="utf-8"><title>Trusted app bootstrap</title><p>Trusted bootstrap only</p><script nonce="${nonce}">const HOST_ORIGIN=${JSON.stringify(hostOrigin)};const AUTHOR_BASE64=${JSON.stringify(authorBase64)};${bootstrap}</script></html>`);
});
app.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', appOrigin);
  if (url.pathname === '/sink') record('app', req, url, 'UPGRADE');
  socket.destroy();
});

await Promise.all([
  new Promise(resolve => host.listen(hostPort, '127.0.0.1', resolve)),
  new Promise(resolve => app.listen(appPort, 'localhost', resolve)),
]);
console.log(`Gate G bootstrap host ${hostOrigin} app ${appOrigin}`);
