import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch {
  playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
}
const port = Number(process.env.GATE_G_EXPERIENCE_PORT || 4311);
const origin = `http://127.0.0.1:${port}`;
const evidence = process.env.GATE_G_EVIDENCE_DIR || join(homedir(), 'Documents/Codex/2026-09-24/deft-gate-g/experiences');
await mkdir(evidence, { recursive: true });
const server = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')], {
  env: { ...process.env, GATE_G_EXPERIENCE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let serverLog = '';
server.stdout.on('data', chunk => serverLog += chunk);
server.stderr.on('data', chunk => serverLog += chunk);
async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('fixture server did not start');
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let browser;
const report = { started: new Date().toISOString(), origin, browser: null, samples: [], serverLog: '', pass: false };
try {
  await ready();
  browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  report.browser = browser.version();
  for (const [label, width, height] of [['desktop', 1280, 900], ['mobile390', 390, 844], ['mobile320', 320, 720]]) {
    await fetch(`${origin}/reset`, { method: 'POST' });
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: false });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', item => { if (item.type() === 'error') consoleErrors.push(item.text()); });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.click('#run-iframe');
    await page.waitForFunction(() => window.__gateG.iframe !== null, { timeout: 10000 });
    await page.click('#run-worker');
    await page.waitForFunction(() => window.__gateG.worker !== null, { timeout: 10000 });
    await page.waitForTimeout(800);
    const before = await page.evaluate(() => window.__gateG);
    const hits = await (await fetch(`${origin}/observations`)).json();
    assert(hits.some(hit => hit.channel?.startsWith('iframe-')), `${label}: no iframe egress reached sink`);
    assert(hits.some(hit => hit.channel === 'iframe-self-navigation'), `${label}: isolated iframe self-navigation did not reach sink`);
    assert(!hits.some(hit => hit.channel?.startsWith('worker-')), `${label}: Worker channel reached sink`);
    const updateStart = Date.now();
    await page.getByRole('button', { name: 'Add record' }).click();
    await page.getByRole('button', { name: 'New 4' }).click();
    await page.getByRole('heading', { name: 'New 4' }).waitFor({ state: 'visible' });
    const updateLatencyMs = Date.now() - updateStart;
    await page.getByRole('textbox', { name: 'Text editor' }).fill('Edited synthetic draft');
    await page.getByRole('textbox', { name: 'Text editor' }).press('Tab');
    await page.locator('[data-focus-key="grid-1-1"]').focus();
    await page.keyboard.press('ArrowRight');
    const gridFocus = await page.evaluate(() => document.activeElement?.dataset?.focusKey);
    assert(gridFocus === 'grid-1-2', `${label}: grid keyboard navigation failed`);
    await page.locator('[data-focus-key="grid-1-1"]').fill('41');
    await page.locator('[data-focus-key="grid-1-1"]').press('Tab');
    await page.waitForFunction(() => window.__gateG.view?.grid?.[1]?.[1] === '41');
    await page.locator('[data-focus-key="grid-2-0"]').evaluate(node => {
      const data = new DataTransfer(); data.setData('text/plain', 'Pasted\t7\nNext\t9');
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await page.waitForFunction(() => window.__gateG.view?.grid?.[2]?.[0] === 'Pasted' && window.__gateG.view?.grid?.[3]?.[1] === '9');
    const canvasBox = await page.locator('canvas').boundingBox();
    await page.mouse.move(canvasBox.x + 20, canvasBox.y + 20);
    await page.mouse.down(); await page.mouse.move(canvasBox.x + Math.min(180, canvasBox.width - 20), canvasBox.y + 75, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => window.__gateG.view?.strokes?.length > 1);
    assert(await page.evaluate(() => window.__gateG.view?.draft === 'Edited synthetic draft'), `${label}: editor value did not persist in Worker`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const screenshot = join(evidence, `${label}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const acceptedBeforeSpoof = await page.evaluate(() => window.__gateG.messages);
    await page.evaluate(() => window.postMessage({ kind: 'view', view: { rows: [{ id: 'spoof', name: 'Spoofed' }] } }, '*'));
    assert(await page.evaluate(() => window.__gateG.messages) === acceptedBeforeSpoof, `${label}: window message reached Worker receiver`);
    await page.click('#flood-worker');
    await page.waitForFunction(() => window.__gateG.rejected > 0);
    const rejectedFlood = await page.evaluate(() => window.__gateG.rejected);
    await page.click('#late-worker');
    await page.click('#revoke-worker');
    assert(await page.locator('#worker-ui').textContent() === '', `${label}: revocation did not remove UI`);
    const after = await page.evaluate(() => window.__gateG);
    await page.click('#run-worker');
    await page.waitForFunction(() => window.__gateG.view?.rows?.length === 3);
    await page.waitForTimeout(450);
    assert(!(await page.locator('#worker-ui').textContent()).includes('Late stale view'), `${label}: old Worker populated replacement session`);
    const afterRestart = await page.evaluate(() => ({ session: window.__gateG.session, rejected: window.__gateG.rejected, rows: window.__gateG.view?.rows?.length }));
    report.samples.push({ label, viewport: { width, height }, before, after, afterRestart, hits, gridFocus, overflow, updateLatencyMs, rejectedFlood, consoleErrors, screenshot });
    await context.close();
  }
  report.pass = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  report.finished = new Date().toISOString();
  report.serverLog = serverLog;
  await writeFile(join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, browser: report.browser, samples: report.samples.map(x => ({ label: x.label, hits: x.hits.map(y => y.channel), overflow: x.overflow, messages: x.before.messages })), error: report.error }, null, 2));
}
