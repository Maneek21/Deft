import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { chromium } from 'playwright';

const webUrl = (process.env.DEFT_WEB_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const email = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const password = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const evidenceDirectory = resolve(
  process.env.DEFT_APP_PLATFORM_EVIDENCE_DIR || 'dist/app-platform-phase6-certification',
);
const evidencePath = resolve(
  process.env.DEFT_APP_PLATFORM_OFFLINE_EVIDENCE || `${evidenceDirectory}/offline-evidence.json`,
);
const screenshotPath = resolve(evidenceDirectory, 'phase6-offline-denied-action.png');
const appId = 'org.deft.reference.resource-campaigns-app';

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

async function login(page) {
  await page.goto(`${webUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === 'POST'
    && new URL(candidate.url()).pathname === '/api/auth/login'
  ));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  requireCondition((await response).ok(), 'OFFLINE_LOGIN_FAILED');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

function appCard(page) {
  return page.locator('article').filter({ hasText: `${appId}@` }).first();
}

async function openLocalCampaign(page) {
  await page.goto(`${webUrl}/modules/resource-campaigns/campaigns`, { waitUntil: 'domcontentloaded' });
  const link = page.getByRole('link', { name: 'Connected campaign', exact: true }).first();
  await link.waitFor({ state: 'visible', timeout: 20_000 });
  await link.click();
  await page.getByRole('region', { name: 'App actions', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
}

async function assertInvocationFailsClosed(page) {
  await page.getByRole('button', { name: 'Send campaign email', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  const alert = dialog.getByRole('alert');
  await alert.waitFor({ state: 'visible', timeout: 20_000 });
  requireCondition(
    /provider discovery failed/i.test(await alert.innerText()),
    'OFFLINE_PROVIDER_FAILURE_NOT_EXPLICIT',
  );
  requireCondition(
    await dialog.getByRole('button', { name: 'Review action', exact: true }).count() === 0,
    'OFFLINE_ACTION_REVIEW_AVAILABLE',
  );
  requireCondition(
    await dialog.getByRole('button', { name: 'Confirm and run', exact: true }).count() === 0,
    'OFFLINE_ACTION_INVOKE_AVAILABLE',
  );
  requireCondition(
    await dialog.getByRole('link', { name: 'Review approval in Inbox', exact: true }).count() === 0,
    'OFFLINE_APPROVAL_AVAILABLE',
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
}

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(dirname(evidencePath), { recursive: true });
  const evidence = {
    schema: 'deft.app_platform.phase6.offline_browser.v1',
    result: 'failed',
    checks: {
      local_resource_opened: false,
      connector_reported_unhealthy: false,
      invocation_failed_safely: false,
    },
    screenshot: relative(evidenceDirectory, screenshotPath).replaceAll('\\', '/'),
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await login(page);
    await openLocalCampaign(page);
    evidence.checks.local_resource_opened = true;

    await page.goto(`${webUrl}/settings/apps`, { waitUntil: 'domcontentloaded' });
    const card = appCard(page);
    await card.waitFor({ state: 'visible', timeout: 20_000 });
    await card.getByRole('button', { name: 'Refresh health', exact: true }).click();
    const health = card.getByRole('status').filter({ hasText: /health issue/ });
    await health.waitFor({ state: 'visible', timeout: 20_000 });
    requireCondition(!/^Healthy$/m.test(await health.innerText()), 'OFFLINE_CONNECTOR_REPORTED_HEALTHY');
    evidence.checks.connector_reported_unhealthy = true;

    await openLocalCampaign(page);
    await assertInvocationFailsClosed(page);
    evidence.checks.invocation_failed_safely = true;
    evidence.result = 'passed';
  } finally {
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    if (browser) await browser.close();
  }
}

main().catch((error) => {
  console.error(`[FAIL] App Platform Phase 6 offline smoke: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  process.exitCode = 1;
});
