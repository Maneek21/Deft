import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Browser error reports (telemetry contract, section 1), in Chromium, under
// the page's real Content-Security-Policy and isolation headers (built from
// next.config.ts exactly as Next would). A thrown error, an unhandled
// rejection and a failed API call reach this workspace's own server at
// /api/telemetry/client-error, with the page's path only. Nothing goes to
// any other address. When the server answers that reporting is off (any
// install but a hosted cell), the page stops reporting.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const ORIGIN = 'http://127.0.0.1';
const REFERENCE = '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** The headers next.config.ts gives every page, for an install whose API is this page's own address. */
function pageHeaders(): Record<string, string> {
  const script = `import(${JSON.stringify(pathToFileURL(path.join(web, 'next.config.ts')).href)})
    .then(async (m) => { const config = m.default.default ?? m.default; const rows = await config.headers();
      const row = rows.find((r) => r.source === '/(.*)');
      process.stdout.write(JSON.stringify(Object.fromEntries(row.headers.map((h) => [h.key, h.value])))); })`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: web, env: { ...process.env, NEXT_PUBLIC_API_URL: ORIGIN, NEXT_PUBLIC_WS_URL: ORIGIN }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, string>;
}

async function harness(): Promise<string> {
  const telemetry = path.join(web, 'src/lib/error-telemetry.ts');
  const api = path.join(web, 'src/lib/api.ts');
  const bundle = await build({
    stdin: {
      contents: `import { installErrorTelemetry, recentErrorReferences } from ${JSON.stringify(telemetry)};
import { api } from ${JSON.stringify(api)};
installErrorTelemetry();
window.__violations = [];
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
window.__throw = () => setTimeout(() => { throw new TypeError('Cannot read properties of undefined'); }, 0);
window.__reject = () => { Promise.reject(new RangeError('Invalid time value')); };
window.__failCall = () => api.get('/api/spaces/space-123/messages?q=launch').then((r) => r.status);
window.__references = () => recentErrorReferences();
window.__ready = true;`,
      resolveDir: web,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    banner: { js: 'var process = { env: {} };' },
    alias: { '@': path.join(web, 'src') },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(ORIGIN) },
  });
  return bundle.outputFiles[0].text as string;
}

async function run(enabled: boolean) {
  const headers = pageHeaders();
  assert.match(headers['Content-Security-Policy'] ?? '', /connect-src 'self'/);
  const script = await harness();
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  try {
    const tab = await browser.newPage();
    tab.setDefaultTimeout(6000);
    const requested: string[] = [];
    const reports: Record<string, unknown>[] = [];
    tab.on('request', (request: any) => { requested.push(request.url()); });
    await tab.route('**/*', async (route: any) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/harness') {
        return route.fulfill({ contentType: 'text/html', headers, body: '<!doctype html><title>harness</title>' });
      }
      if (url.pathname === '/api/telemetry/client-error') {
        reports.push(JSON.parse(route.request().postData() ?? 'null'));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled }) });
      }
      if (url.pathname === '/api/spaces/space-123/messages') {
        return route.fulfill({
          status: 500, contentType: 'application/json',
          headers: { 'X-Deft-Error-Reference': REFERENCE },
          body: JSON.stringify({ error: 'Request failed', code: 'INTERNAL_ERROR' }),
        });
      }
      return route.abort();
    });
    // The address carries a query and a link token after "#": neither may be reported.
    await tab.goto(`${ORIGIN}/harness?space=secret-space#setup=SECRETTOKEN123`);
    await tab.addScriptTag({ content: script });
    await tab.waitForFunction(() => (window as any).__ready === true);

    await tab.evaluate(() => (window as any).__throw());
    await tab.waitForTimeout(300);
    const afterThrow = reports.length;
    await tab.evaluate(() => (window as any).__reject());
    await tab.waitForTimeout(300);
    assert.equal(await tab.evaluate(() => (window as any).__failCall()), 500);
    await tab.waitForTimeout(300);
    const references = await tab.evaluate(() => (window as any).__references());
    const violations = await tab.evaluate(() => (window as any).__violations);
    return { requested, reports, afterThrow, references, violations };
  } finally {
    await browser.close();
  }
}

test('a thrown error, a rejection and a failed API call reach the cell route, and nothing goes cross-origin', async () => {
  const seen = await run(true);
  assert.deepEqual(seen.violations, [], 'the page policy allowed every report');
  assert.deepEqual(seen.requested.filter((url) => new URL(url).origin !== ORIGIN), [], 'no request left this origin');
  assert.equal(seen.reports.length, 3);
  const [thrown, rejected, failed] = seen.reports as Record<string, unknown>[];
  assert.equal(thrown!.type, 'error');
  assert.equal(thrown!.error_class, 'TypeError');
  assert.equal(thrown!.message, 'Cannot read properties of undefined');
  assert.match(String(thrown!.stack), /TypeError/);
  assert.equal(rejected!.type, 'rejection');
  assert.equal(rejected!.error_class, 'RangeError');
  assert.deepEqual(failed, {
    type: 'api', method: 'GET', api_path: '/api/spaces/space-123/messages', status: 500, request_id: REFERENCE, page: '/harness',
  });
  for (const report of seen.reports) {
    assert.equal(report.page, '/harness', 'the page path only: no query, no fragment');
    assert.doesNotMatch(JSON.stringify(report), /SECRETTOKEN123|secret-space|launch/);
  }
  // "Report a problem" can quote the server's reference for the failed call.
  assert.deepEqual(seen.references, [REFERENCE]);
});

test('when the server says reporting is off, the page stops after the first report', async () => {
  const seen = await run(false);
  assert.equal(seen.afterThrow, 1);
  assert.equal(seen.reports.length, 1, 'nothing more after { enabled: false }');
  assert.deepEqual(seen.requested.filter((url) => new URL(url).origin !== ORIGIN), []);
});
