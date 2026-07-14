import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://127.0.0.1:3000';
const API_URL = process.env.DEFT_API_URL || 'http://127.0.0.1:3301';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const PROJECT_ID = process.env.DEFT_TEST_PROJECT_ID || 'd534478c-69f0-4260-ba82-587c04f824d5';
const OUT_DIR = path.resolve('reports/assets/task-table-loop-zero');

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

async function authenticate(page: Page) {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as Record<string, string>;
  const accessToken = body.access_token || body.accessToken;
  const refreshToken = body.refresh_token || body.refreshToken;
  await page.addInitScript(({ accessToken: at, refreshToken: rt }) => {
    localStorage.setItem('deft-access-token', at);
    if (rt) localStorage.setItem('deft-refresh-token', rt);
  }, { accessToken, refreshToken });
}

async function openTable(page: Page) {
  await page.goto(`${WEB_URL}/tasks?project=${PROJECT_ID}&view=table`, { waitUntil: 'domcontentloaded' });
  if ((page.viewportSize()?.width ?? 1024) < 768) {
    await page.locator('[aria-label^="Status for"]').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    return;
  }
  const tableView = page.getByRole('button', { name: 'Table view' });
  await tableView.waitFor({ timeout: 20_000 });
  if (await tableView.getAttribute('data-active') !== 'true') await tableView.click();
  await page.locator('.task-table-grid').waitFor({ timeout: 20_000 });
  await page.locator('.task-table-row').first().waitFor({ timeout: 20_000 });
  // Config and cursor-backed rows settle independently after the view switch.
  await page.waitForTimeout(3_000);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const badResponses: string[] = [];

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' });
  const page = await desktop.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  await authenticate(page);
  await openTable(page);

  const rows = page.locator('.task-table-row');
  check('Desktop table renders', await rows.count() > 0, `${await rows.count()} task rows visible`);
  await page.screenshot({ path: path.join(OUT_DIR, 'after-desktop-dark.png'), fullPage: true });

  const firstRow = rows.first();
  const titleButton = firstRow.locator('.task-table-frozen-title button').first();
  const originalTitle = (await titleButton.innerText()).trim();
  await titleButton.click();
  const titleInput = firstRow.locator('input[aria-label^="Title for"]');
  await titleInput.fill(`${originalTitle} QA`);
  await titleInput.press('Enter');
  await page.getByLabel('Saved').first().waitFor({ timeout: 8_000 });
  check('Inline title save confirms', await firstRow.getByText(`${originalTitle} QA`, { exact: true }).isVisible(), 'Edited title rendered and a saved indicator appeared');
  await page.waitForTimeout(1_800);

  await firstRow.getByText(`${originalTitle} QA`, { exact: true }).click();
  await firstRow.locator('input[aria-label^="Title for"]').fill(originalTitle);
  await firstRow.locator('input[aria-label^="Title for"]').press('Enter');
  await firstRow.getByText(originalTitle, { exact: true }).waitFor({ timeout: 8_000 });
  await page.waitForTimeout(1_800);

  let failNextPatch = true;
  await page.route('**/api/tasks/**', async (route) => {
    if (failNextPatch && route.request().method() === 'PATCH') {
      failNextPatch = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Loop 0 simulated failure', code: 'SIMULATED' }) });
      return;
    }
    await route.continue();
  });
  await firstRow.getByText(originalTitle, { exact: true }).click();
  await firstRow.locator('input[aria-label^="Title for"]').fill(`${originalTitle} should fail`);
  await firstRow.locator('input[aria-label^="Title for"]').press('Enter');
  const failureIcon = firstRow.getByLabel('Could not save. Try again.');
  await failureIcon.waitFor({ timeout: 8_000 });
  check('Failed write is visible', await failureIcon.isVisible(), 'Cell retained edit context and showed a local retry affordance');
  await page.screenshot({ path: path.join(OUT_DIR, 'after-desktop-failed-write.png'), fullPage: true });
  await page.unroute('**/api/tasks/**');
  await page.waitForTimeout(1_000);
  await firstRow.locator('input[aria-label^="Title for"]').fill(`${originalTitle} recovered`);
  await firstRow.locator('input[aria-label^="Title for"]').press('Enter');
  await firstRow.getByText(`${originalTitle} recovered`, { exact: true }).waitFor({ timeout: 8_000 });
  await page.getByLabel('Saved').first().waitFor({ timeout: 8_000 });
  await page.waitForTimeout(1_800);
  await firstRow.getByText(`${originalTitle} recovered`, { exact: true }).click();
  await firstRow.locator('input[aria-label^="Title for"]').fill(originalTitle);
  await firstRow.locator('input[aria-label^="Title for"]').press('Enter');
  await firstRow.getByText(originalTitle, { exact: true }).waitFor({ timeout: 8_000 });
  check('Failed write recovers', !await firstRow.getByLabel('Could not save. Try again.').isVisible().catch(() => false), 'A subsequent successful edit cleared the failure state');

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await firstRow.locator('td').first().click();
  await firstRow.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  check('Selection is visually explicit', await firstRow.getAttribute('data-selected') === 'true', 'Selected row exposes a stable selected state');
  await page.screenshot({ path: path.join(OUT_DIR, 'after-desktop-selection.png'), fullPage: true });

  await page.evaluate(() => localStorage.setItem('deft-theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.task-table-grid').waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(OUT_DIR, 'after-desktop-light.png'), fullPage: true });
  check('Light theme table renders', await page.locator('.task-table-grid').isVisible(), 'Table and native editors render in light mode');
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const mobilePage = await mobile.newPage();
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  mobilePage.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  await authenticate(mobilePage);
  await openTable(mobilePage);
  check('Mobile table renders task cards', await mobilePage.locator('[aria-label^="Status for"]').count() > 0, 'Mobile cards expose status, priority, and due-date editors');
  check('Mobile controls have labels', await mobilePage.getByText('Due date', { exact: true }).first().isVisible(), 'Compact editors remain understandable without relying on placeholder values');
  const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('No page-level mobile overflow', overflow <= 1, `Horizontal overflow: ${overflow}px`);
  await mobilePage.screenshot({ path: path.join(OUT_DIR, 'after-mobile-dark.png'), fullPage: true });
  await mobile.close();

  const unexpectedResponses = badResponses.filter((item) => !item.startsWith('500 PATCH'));
  check('No unexpected failed requests', unexpectedResponses.length === 0, unexpectedResponses.length ? unexpectedResponses.join(' | ') : 'Only the intentionally simulated PATCH failure was observed');
  await browser.close();

  const result = { generatedAt: new Date().toISOString(), webUrl: WEB_URL, checks, consoleErrors, badResponses };
  writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (checks.some((item) => !item.pass)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
