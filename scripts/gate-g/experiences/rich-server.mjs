import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const dir = new URL('.', import.meta.url);
const root = fileURLToPath(new URL('../../..', dir));
const hostPort = 4317;
const appPort = 4318;
const hostOrigin = `http://127.0.0.1:${hostPort}`;
const appOrigin = `http://localhost:${appPort}`;
const observations = { requests: [], sink: [] };
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
function compiled(path) {
  return ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const sdk = compiled('packages/app-kit/src/experience-sdk.ts').replace(/^export /gm, '');
const workerSource = sdk + '\n' + read('author-rich-worker.js');
const bridgeJs = compiled('apps/web/src/lib/app-experience-bridge.ts');
const rendererJs = compiled('apps/web/src/lib/app-experience-renderer.ts');

function response(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
const host = createServer((req, res) => {
  const url = new URL(req.url ?? '/', hostOrigin);
  observations.requests.push({ side: 'host', path: url.pathname, cookie: Boolean(req.headers.cookie) });
  if (url.pathname === '/sink') observations.sink.push({ side:'host', search:url.search });
  if (url.pathname === '/observations') return response(res, 200, 'application/json', JSON.stringify(observations));
  if (url.pathname === '/bridge.js') return response(res, 200, 'text/javascript', bridgeJs);
  if (url.pathname === '/renderer.js') return response(res, 200, 'text/javascript', rendererJs);
  if (url.pathname === '/') return response(res, 200, 'text/html',
    read('rich-host.html').replace('__APP_ORIGIN__', appOrigin),
    { 'set-cookie':'host_private=fixture; HttpOnly; SameSite=Strict; Path=/' });
  return response(res, 404, 'text/plain', 'missing');
});
const app = createServer((req, res) => {
  const url = new URL(req.url ?? '/', appOrigin);
  observations.requests.push({ side: 'app', path: url.pathname, cookie: Boolean(req.headers.cookie) });
  if (url.pathname === '/sink') {
    observations.sink.push({ side:'app', search:url.search });
    return response(res, 200, 'text/plain', 'sink');
  }
  if (url.pathname !== '/bootstrap') return response(res, 404, 'text/plain', 'missing');
  const nonce = randomBytes(18).toString('base64');
  const sourceLiteral = JSON.stringify(workerSource).replaceAll('<', '\\u003c');
  const script = `
    const hostOrigin = ${JSON.stringify(hostOrigin)};
    let started = false;
    window.addEventListener('message', event => {
      if (started || event.source !== parent || event.origin !== hostOrigin
        || event.data?.kind !== 'start' || !event.ports?.[0]) return;
      started = true;
      const url = URL.createObjectURL(new Blob([${sourceLiteral}], { type:'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.postMessage({ kind:'start', session_id:event.data.session_id,
        port:event.ports[0] }, [event.ports[0]]);
    });
  `;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">${script}</script>`;
  return response(res, 200, 'text/html', html, {
    'content-security-policy': csp,
    'cross-origin-resource-policy': 'cross-origin',
  });
});
await Promise.all([
  new Promise((resolve) => host.listen(hostPort, '127.0.0.1', resolve)),
  new Promise((resolve) => app.listen(appPort, 'localhost', resolve)),
]);
console.log(JSON.stringify({ hostOrigin, appOrigin }));
process.on('SIGTERM', () => { host.close(); app.close(); });
