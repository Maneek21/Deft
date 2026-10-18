import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const hostPort = Number(process.env.GATE_G_BOOTSTRAP_HOST_PORT || 4313);
const appPort = Number(process.env.GATE_G_BOOTSTRAP_APP_PORT || 4314);
const useHttps = process.env.GATE_G_BOOTSTRAP_TLS === '1';
const mode = process.env.GATE_G_BOOTSTRAP_MODE === 'same-origin' ? 'same-origin' : 'opaque';
const scheme = useHttps ? 'https' : 'http';
const hostOrigin = `${scheme}://127.0.0.1:${hostPort}`;
const appOrigin = `${scheme}://localhost:${appPort}`;
const evidence = process.env.GATE_G_CHECKPOINT_02_DIR || join(homedir(), 'Documents/Codex/2026-09-24/deft-gate-g/experiences/checkpoint-02', `${scheme}-${mode}`);
await mkdir(evidence, { recursive: true });
const server = spawn(process.execPath, [fileURLToPath(new URL('./bootstrap-server.mjs', import.meta.url))], {
  env: { ...process.env, GATE_G_BOOTSTRAP_HOST_PORT: String(hostPort), GATE_G_BOOTSTRAP_APP_PORT: String(appPort) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let log = '';
server.stdout.on('data', chunk => log += chunk);
server.stderr.on('data', chunk => log += chunk);
const api = await playwright.request.newContext({ ignoreHTTPSErrors: true });
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await api.get(url)).status() < 500) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server not ready: ${url}`);
}
const report = { started: new Date().toISOString(), hostOrigin, appOrigin, mode, browsers: [], serverLog: '', pass: false };
try {
  await Promise.all([ready(hostOrigin), ready(`${appOrigin}/bootstrap`)]);
  const names = process.env.GATE_G_BROWSER ? [process.env.GATE_G_BROWSER] : ['chromium', 'firefox', 'webkit'];
  for (const name of names) {
    await api.post(`${hostOrigin}/reset`);
    const sample = { name, version: null, results: null, hits: [], errors: [], screenshot: null };
    let browser;
    try {
      browser = await playwright[name].launch({ headless: true });
      sample.version = browser.version();
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, ignoreHTTPSErrors: true });
      await context.addCookies([{ name: 'synthetic_host_session', value: 'host-cookie-marker', url: hostOrigin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      page.on('console', message => { if (message.type() === 'error') sample.errors.push(message.text()); });
      page.on('pageerror', error => sample.errors.push(error.message));
      await page.goto(mode === 'same-origin' ? `${hostOrigin}/?mode=same-origin` : hostOrigin, { waitUntil: 'domcontentloaded' });
      await page.click('#start');
      try { await page.waitForFunction(() => (window.__bootstrapProbe.a && window.__bootstrapProbe.b) || window.__bootstrapProbe.errors.length > 0, { timeout: 10000 }); }
      catch { sample.errors.push('Timed out waiting for both author Workers'); }
      if (await page.evaluate(() => Boolean(window.__bootstrapProbe.a && window.__bootstrapProbe.b))) {
        await page.click('#broadcast');
        await page.waitForTimeout(500);
        await page.click('#storage-read');
        try { await page.waitForFunction(() => window.__bootstrapProbe.storageReads.length >= 2, { timeout: 5000 }); }
        catch { sample.errors.push('Timed out waiting for sibling storage reads'); }
      }
      sample.results = await page.evaluate(() => window.__bootstrapProbe);
      sample.hits = await (await api.get(`${hostOrigin}/observations`)).json();
      sample.screenshot = join(evidence, `${name}.png`);
      await page.screenshot({ path: sample.screenshot, fullPage: true });
      sample.hostCookieSeen = sample.hits.some(hit => hit.side === 'host' && hit.path === '/' && hit.cookiePresent);
      sample.appCookieSeen = sample.hits.some(hit => hit.side === 'app' && hit.path === '/bootstrap' && hit.cookiePresent);
      sample.authorEgress = sample.hits.filter(hit => hit.channel?.startsWith('bootstrap-'));
      const reads = sample.results?.storageReads || [];
      sample.siblingIsolated = sample.results?.received?.length === 0 && reads.length === 2 && reads.every(read => read.indexedDbError === 'SecurityError') &&
        (reads.every(read => read.cacheError) || (reads.some(read => read.id === 'a' && read.cacheValue === 'a') && reads.some(read => read.id === 'b' && read.cacheValue === 'b')));
      sample.sharedControl = sample.results?.received?.some(item => item.id === 'a' && item.from === 'from-b') &&
        sample.results?.received?.some(item => item.id === 'b' && item.from === 'from-a') && reads.length === 2 &&
        reads.every(read => read.indexedDbValue && read.indexedDbValue === reads[0].indexedDbValue && read.cacheValue && read.cacheValue === reads[0].cacheValue);
      await page.click('#revoke');
      sample.revokedFrames = await page.locator('iframe').count();
      await context.close();
    } catch (error) { sample.failure = error.stack || String(error); }
    finally { if (browser) await browser.close(); }
    report.browsers.push(sample);
  }
  report.pass = report.browsers.every(sample => sample.results?.a && sample.results?.b && sample.hostCookieSeen && !sample.appCookieSeen && sample.authorEgress.length === 0 && sample.revokedFrames === 0 && (mode === 'opaque' ? sample.siblingIsolated : sample.sharedControl));
  if (!report.pass) process.exitCode = 1;
} catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
finally {
  server.kill();
  await api.dispose();
  report.finished = new Date().toISOString();
  report.serverLog = log;
  await writeFile(join(evidence, 'bootstrap-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, mode, browsers: report.browsers.map(x => ({ name: x.name, version: x.version, workerStarted: Boolean(x.results?.a && x.results?.b), hostCookieSeen: x.hostCookieSeen, appCookieSeen: x.appCookieSeen, authorEgress: x.authorEgress?.map(y => y.channel), siblingIsolated: x.siblingIsolated, sharedControl: x.sharedControl, received: x.results?.received, storageReads: x.results?.storageReads, errors: x.errors.slice(0, 5), failure: x.failure })), error: report.error }, null, 2));
}
