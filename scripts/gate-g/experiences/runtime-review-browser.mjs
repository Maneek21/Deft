import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const { build } = require(resolve(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'));
const bundled = await build({
  entryPoints: [resolve(root, 'scripts/gate-g/experiences/runtime-review-browser-entry.tsx')],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [resolve(root, 'apps/web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_API_URL': '"http://localhost:3001"' },
  alias: { '@': resolve(root, 'apps/web/src') },
  loader: { '.tsx': 'tsx' },
});
const js = bundled.outputFiles[0].contents;
const cardBundled = await build({
  entryPoints: [resolve(root, 'scripts/gate-g/experiences/runtime-approval-card-browser-entry.tsx')],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [resolve(root, 'apps/web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_API_URL': '"http://localhost:3001"' },
  alias: { '@': resolve(root, 'apps/web/src') },
  loader: { '.tsx': 'tsx' },
});
const cardJs = cardBundled.outputFiles[0].contents;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#111827;color:#eef2ff;font:15px/1.45 system-ui}*{box-sizing:border-box}
.shell{max-width:690px;margin:48px auto;padding:24px;background:#1f2937;border:1px solid #334155;border-radius:16px}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:#93c5fd;font-weight:700}
h1{font-size:23px;margin:8px 0}p{margin:6px 0 16px;color:#cbd5e1}section{border:1px solid #475569;border-radius:12px;padding:16px;min-width:0}
section p{font-size:13px;margin:6px 0}dl{margin:12px 0;max-height:260px;overflow:auto}dt{font-size:12px;color:#93c5fd;font-weight:700}dd{margin:2px 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
button{border:1px solid #64748b;border-radius:8px;background:#334155;color:white;padding:9px 12px;min-height:38px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px}
[role=alert]{color:#fca5a5!important}@media(max-width:480px){.shell{margin:0;min-height:100vh;border:0;border-radius:0;padding:16px}h1{font-size:20px}}</style></head>
<body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const cardHtml = html.replace('/bundle.js', '/card.js');
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(js);
  } else if (req.url === '/card.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(cardJs);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(req.url === '/card' ? cardHtml : html);
  }
});
await new Promise((done) => server.listen(4319, '127.0.0.1', done));
const evidenceDir = process.env.GATE_G_EXPERIENCE_EVIDENCE_DIR
  ?? 'C:/Users/Osheen Pradhan/Documents/Codex/2026-09-24/deft-gate-g/experiences/checkpoint-03a-runtime-review';
await mkdir(evidenceDir, { recursive: true });
const results = [];
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    let failReview = false;
    let requestCount = 0;
    page.on('pageerror', (error) => { throw error; });
    await page.route('http://localhost:3001/api/app-runtime-actions/run-one/review', async (route) => {
      requestCount += 1;
      if (failReview) return route.fulfill({ status: 409,
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ code: 'APP_RUN_AUTHORIZATION_STALE' }) });
      return route.fulfill({ status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
        body: JSON.stringify({ review: { run_id: 'run-one', action_key: 'create_label',
          app_installation_id: 'install-one', app_version_id: 'version-one',
          grant_snapshot_id: 'grant-one', runtime_binding_id: 'binding-one',
          contract_digest: `sha256:${'a'.repeat(64)}`,
          policy: { risk_class: 'external_write', review_requirement: 'always',
            review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown' },
          input: { shipment_id: 'synthetic-shipment-123', quantity: 2, urgent: false },
        } }),
      });
    });
    await page.goto('http://127.0.0.1:4319/');
    const approve = page.locator('#approve');
    assert.equal(await approve.isDisabled(), true);
    await page.getByRole('button', { name: 'Review exact input' }).click();
    await page.getByText('synthetic-shipment-123').waitFor();
    assert.equal(await approve.isEnabled(), true);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 720 });
      await page.screenshot({ path: resolve(evidenceDir, `${name}-${width}.png`), fullPage: true });
    }
    failReview = true;
    await page.getByRole('button', { name: 'Refresh exact input' }).click();
    await page.getByRole('alert').getByText(/Input review is unavailable/).waitFor();
    assert.equal(await approve.isDisabled(), true);
    await page.screenshot({ path: resolve(evidenceDir, `${name}-error-320.png`), fullPage: true });
    await page.getByRole('button', { name: 'Change binding' }).click();
    assert.equal(await approve.isDisabled(), true);
    failReview = false;
    await page.goto('http://127.0.0.1:4319/card');
    await page.getByText('Runtime App action').waitFor();
    const cardApprove = page.getByRole('button', { name: 'Approve Runtime action' });
    assert.equal(await cardApprove.isDisabled(), true);
    await page.getByRole('button', { name: 'Review exact input' }).click();
    await page.getByText('synthetic-shipment-123').waitFor();
    assert.equal(await cardApprove.isEnabled(), true);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 720 });
      await page.screenshot({ path: resolve(evidenceDir, `${name}-card-${width}.png`), fullPage: true });
    }
    results.push({ browser: name, requestCount, inputVisible: true,
      gateBefore: 'disabled', gateAfterReview: 'enabled', gateAfterRevocation: 'disabled',
      gateAfterBindingChange: 'disabled', actualCardGate: 'disabled-to-enabled' });
    await browser.close();
  }
  await writeFile(resolve(evidenceDir, 'results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(JSON.stringify(results, null, 2));
} finally {
  server.close();
}
