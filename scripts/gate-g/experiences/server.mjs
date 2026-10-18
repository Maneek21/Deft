import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.GATE_G_EXPERIENCE_PORT || 4311);
const origin = `http://127.0.0.1:${port}`;
const hits = [];
const nonce = randomBytes(18).toString('base64');
const iframeCsp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; navigate-to 'none'`;
const workerCsp = "default-src 'none'; script-src 'none'; connect-src 'none'; worker-src 'none'; object-src 'none'";
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/host.js', ['host.js', 'text/javascript; charset=utf-8']],
  ['/iframe', ['iframe.html', 'text/html; charset=utf-8']],
  ['/iframe.js', ['iframe.js', 'text/javascript; charset=utf-8']],
  ['/worker.js', ['worker.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', origin);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (url.pathname === '/sink') {
    const hit = { channel: url.searchParams.get('channel'), at: new Date().toISOString(), method: req.method };
    hits.push(hit);
    console.log(JSON.stringify({ event: 'synthetic-egress', ...hit }));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Local synthetic sink</title>Marker received');
    return;
  }
  if (url.pathname === '/observations') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(hits));
    return;
  }
  if (url.pathname === '/reset' && req.method === 'POST') {
    hits.length = 0;
    res.end('ok');
    return;
  }
  const file = files.get(url.pathname);
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  if (url.pathname === '/iframe' || url.pathname === '/iframe.js') res.setHeader('Content-Security-Policy', iframeCsp);
  if (url.pathname === '/worker.js') res.setHeader('Content-Security-Policy', workerCsp);
  res.setHeader('Content-Type', file[1]);
  try {
    if (url.pathname === '/iframe') {
      if (url.searchParams.get('mode') === 'navigation') {
        res.end(`<!doctype html><title>Navigation-only fixture</title><script nonce="${nonce}">location.href='/sink?channel=iframe-self-navigation'</script>`);
      } else {
        const page = await readFile(join(here, file[0]), 'utf8');
        const script = await readFile(join(here, 'iframe.js'), 'utf8');
        res.end(page.replace('<script src="/iframe.js"></script>', `<script nonce="${nonce}">${script}</script>`));
      }
    } else res.end(await readFile(join(here, file[0])));
  }
  catch (error) { console.error(error); res.writeHead(500); res.end('fixture read failed'); }
});
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', origin);
  if (url.pathname === '/sink') {
    const hit = { channel: url.searchParams.get('channel'), at: new Date().toISOString(), method: 'UPGRADE' };
    hits.push(hit);
    console.log(JSON.stringify({ event: 'synthetic-egress', ...hit }));
  }
  socket.destroy();
});
server.listen(port, '127.0.0.1', () => console.log(`Gate G experiences: ${origin}`));
