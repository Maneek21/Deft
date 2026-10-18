import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const serverPath = new URL('./rich-server.mjs', import.meta.url);
const evidenceDir = process.env.GATE_G_EXPERIENCE_EVIDENCE_DIR
  ?? 'C:/Users/Osheen Pradhan/Documents/Codex/2026-09-24/deft-gate-g/experiences/checkpoint-03a-rich';
await mkdir(evidenceDir, { recursive: true });
const server = spawn(process.execPath, [fileURLToPath(serverPath)], { cwd: process.cwd(), stdio:['ignore','pipe','pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });
for (let i = 0; i < 100 && !serverOutput.includes('hostOrigin'); i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!serverOutput.includes('hostOrigin')) throw new Error('rich server failed: ' + serverOutput);
const results = [];
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const storageText = async () => {
      await page.getByText(/^Storage probe: (?:empty before write|unavailable:|prior marker visible)/).waitFor();
      return page.getByText(/^Storage probe:/).first().textContent();
    };
    await page.goto('http://127.0.0.1:4317/', { waitUntil:'domcontentloaded' });
    await page.getByRole('grid', { name:'orders' }).waitFor({ timeout:15000 });
    await page.getByText('Network probe: fetch blocked').waitFor({ timeout:15000 });
    const gridInput = page.getByRole('textbox', { name:'Order, row 1' });
    await gridInput.fill('Alpha edited');
    await gridInput.press('Enter');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    if (focused !== 'Order, row 2') throw new Error(name + ' keyboard focus failed: ' + focused);
    await page.getByRole('textbox', { name:'Order, row 2' }).click();
    await page.getByText('Selected: Beta').waitFor();
    const canvas = page.getByRole('img', { name:'route canvas' });
    const box = await canvas.boundingBox();
    if (!box) throw new Error(name + ' canvas missing');
    await page.mouse.move(box.x + 25, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80, { steps:10 });
    await page.mouse.up();
    const interactions = await page.evaluate(() => window.__experienceEvidence.events);
    if (!interactions.some((event) => event.kind === 'canvas_stroke')) throw new Error(name + ' canvas event missing');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 740 });
      await page.screenshot({ path: resolve(evidenceDir, `${name}-${width}.png`), fullPage: true });
    }
    const horizontalReach = await page.locator('.ex-grid-scroll').evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return { left: element.scrollLeft, hiddenWidth: element.scrollWidth - element.clientWidth };
    });
    if (horizontalReach.hiddenWidth <= 0 || horizontalReach.left <= 0) {
      throw new Error(name + ' mobile grid has no horizontal reach');
    }
    const ownerCell = page.getByRole('textbox', { name:'Owner, row 2' });
    await ownerCell.fill('Mobile owner');
    await ownerCell.press('Enter');
    await page.locator('.ex-grid-scroll').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await page.screenshot({ path: resolve(evidenceDir, `${name}-320-grid-right.png`), fullPage: true });
    const initialStorage = await storageText();
    await page.getByRole('button', { name:'Reload' }).click();
    await page.getByRole('grid', { name:'orders' }).waitFor();
    await page.getByText('Network probe: fetch blocked').waitFor();
    const reloadStorage = await storageText();
    await page.getByRole('button', { name:'New version' }).click();
    await page.getByRole('grid', { name:'orders' }).waitFor();
    await page.getByText('Network probe: fetch blocked').waitFor();
    const versionStorage = await storageText();
    await page.getByRole('button', { name:'Disable' }).click();
    await page.getByText('Disabled').waitFor();
    if (await page.getByRole('grid').count()) throw new Error(name + ' stale grid after disable');
    await page.getByRole('button', { name:'Enable' }).click();
    await page.getByRole('grid', { name:'orders' }).waitFor();
    await page.getByText('Network probe: fetch blocked').waitFor();
    const reenabledStorage = await storageText();
    await page.getByRole('button', { name:'Disable' }).click();
    await page.getByText('Disabled').waitFor();
    const observations = await (await page.request.get('http://127.0.0.1:4317/observations')).json();
    const appBootstrapCookie = observations.requests.filter((entry) =>
      entry.side === 'app' && entry.path === '/bootstrap').some((entry) => entry.cookie);
    if (appBootstrapCookie || observations.sink.length) throw new Error(name + ' egress or credential leak');
    if ([reloadStorage, versionStorage, reenabledStorage].some((value) => value?.includes('prior marker visible'))) {
      throw new Error(name + ' opaque storage survived reload/version/disable');
    }
    results.push({ browser:name, focused, horizontalReach,
      interactions:interactions.map((event)=>event.kind),
      initialStorage, reloadStorage, versionStorage, reenabledStorage,
      sinkHits:observations.sink.length,
      appBootstrapCookie, pageErrors:errors });
    await browser.close();
  }
  await writeFile(resolve(evidenceDir, 'rich-results.json'), JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {
  server.kill();
}
