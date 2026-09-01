import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const webUrl = (process.env.DEFT_WEB_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const email = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const password = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const requireConnected = process.env.DEFT_APP_PLATFORM_REQUIRE_CONNECTED === 'true';
const evidenceDirectory = resolve(
  process.env.DEFT_APP_PLATFORM_EVIDENCE_DIR || 'dist/app-platform-phase5-certification',
);
const evidencePath = resolve(
  process.env.DEFT_APP_PLATFORM_BROWSER_EVIDENCE
    || `${evidenceDirectory}/apps-browser-smoke.json`,
);

const viewports = Object.freeze([
  Object.freeze({ name: 'desktop', width: 1440, height: 900 }),
  Object.freeze({ name: 'mobile', width: 390, height: 844 }),
]);

function collectStrings(value, output) {
  if (typeof value === 'string') {
    if (value.length >= 8) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}

function secretMarkers() {
  const markers = new Set();
  for (const name of [
    'DEFT_TEST_PASSWORD',
    'DEFT_APP_RUN_KEYRINGS',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'ENCRYPTION_KEY',
  ]) {
    const value = process.env[name];
    if (!value) continue;
    if (name === 'DEFT_APP_RUN_KEYRINGS') {
      try {
        collectStrings(JSON.parse(value), markers);
      } catch {
        // The API owns keyring validation. The smoke still checks that the raw
        // value is absent without printing it into diagnostics.
      }
    }
    if (value.length >= 8) markers.add(value);
  }
  if (!process.env.DEFT_TEST_PASSWORD && password.length >= 8) markers.add(password);

  const extra = process.env.DEFT_APP_PLATFORM_SECRET_MARKERS;
  if (extra) {
    const parsed = JSON.parse(extra);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('DEFT_APP_PLATFORM_SECRET_MARKERS must be a JSON string array');
    }
    collectStrings(parsed, markers);
  }
  return [...markers];
}

async function login(page) {
  await page.goto(`${webUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  const loginResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && response.url().includes('/api/auth/login'),
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await loginResponse;
  if (!response.ok()) {
    throw new Error(`Demo login returned HTTP ${response.status()}`);
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

async function assertAppsSurface(page, viewport, markers, apiFailures) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${webUrl}/settings/apps`, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname.startsWith('/login')) {
    throw new Error(`${viewport.name} Apps surface redirected to login`);
  }
  await page.getByRole('heading', { name: 'Apps', exact: true }).first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction((mustShowConnected) => {
    const text = document.body.innerText;
    return mustShowConnected
      ? text.includes('Connected Resource Campaigns') && text.includes('Effective authority')
      : text.includes('No Apps installed') || document.querySelectorAll('article').length > 0;
  }, requireConnected, { timeout: 20_000 });

  const emptyState = await page.getByText('No Apps installed', { exact: true }).count() > 0;
  const appCards = await page.locator('article').count();
  assert.ok(emptyState || appCards > 0, 'Apps surface rendered neither its empty state nor an App card');
  if (requireConnected) {
    assert.equal(emptyState, false, 'connected proof unexpectedly rendered the empty Apps state');
    const connectedCard = page.locator('article').filter({ hasText: 'Connected Resource Campaigns' });
    await connectedCard.waitFor({ state: 'visible', timeout: 20_000 });
    await connectedCard.getByText('active', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const connectedText = await connectedCard.innerText();
    assert.match(connectedText, /Effective authority/);
    assert.match(connectedText, /1 active binding/);
    assert.match(connectedText, /Effective action bindings/);
    assert.match(connectedText, /Recent Runs/);
    assert.doesNotMatch(connectedText, /No App Runs yet\./);
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 2, `${viewport.name} Apps surface overflows by ${overflow}px`);

  const [text, html] = await Promise.all([
    page.locator('body').innerText(),
    page.content(),
  ]);
  for (const [index, marker] of markers.entries()) {
    assert.equal(text.includes(marker), false, `secret marker ${index + 1} is visible as Apps page text`);
    assert.equal(html.includes(marker), false, `secret marker ${index + 1} is present in Apps page markup`);
  }
  assert.doesNotMatch(text, /deft_app_dev_[A-Za-z0-9_-]{16,}/, 'developer token is visible on Apps page');
  assert.doesNotMatch(text, /hmac-sha256:[a-f0-9]{64}/i, 'receipt signature is visible on Apps page');

  const relevantFailures = apiFailures.filter((failure) => failure.viewport === viewport.name);
  assert.deepEqual(relevantFailures, [], `${viewport.name} Apps API requests failed`);

  const screenshotPath = resolve(evidenceDirectory, `apps-${viewport.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return {
    name: viewport.name,
    width: viewport.width,
    height: viewport.height,
    state: emptyState ? 'empty' : 'installed',
    connected_proof_required: requireConnected,
    app_card_count: appCards,
    horizontal_overflow_px: overflow,
    screenshot: screenshotPath,
  };
}

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(dirname(evidencePath), { recursive: true });
  const evidence = {
    schema: 'deft.app_platform.phase5.browser_smoke.v1',
    result: 'failed',
    target: webUrl,
    route: '/settings/apps',
    completed_at: null,
    viewports: [],
    checks: {
      authenticated_demo_login: false,
      apps_surface_loaded: false,
      secrets_absent_from_rendered_surface: false,
      browser_errors_absent: false,
    },
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: viewports[0] });
    const page = await context.newPage();
    const pageErrors = [];
    const apiFailures = [];
    let activeViewport = viewports[0].name;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (response.url().includes('/api/apps') && response.status() >= 400) {
        apiFailures.push({ viewport: activeViewport, status: response.status(), url: response.url() });
      }
    });

    await login(page);
    evidence.checks.authenticated_demo_login = true;
    const markers = secretMarkers();
    for (const viewport of viewports) {
      activeViewport = viewport.name;
      evidence.viewports.push(await assertAppsSurface(page, viewport, markers, apiFailures));
    }
    evidence.checks.apps_surface_loaded = true;
    evidence.checks.secrets_absent_from_rendered_surface = true;
    assert.deepEqual(pageErrors, [], `uncaught browser errors: ${pageErrors.join(' | ')}`);
    evidence.checks.browser_errors_absent = true;
    evidence.result = 'passed';
    evidence.completed_at = new Date().toISOString();
    console.log('APP_PLATFORM_BROWSER_SMOKE_PASSED');
    console.log(`Evidence: ${evidencePath}`);
  } catch (error) {
    evidence.completed_at = new Date().toISOString();
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    if (browser) await browser.close();
  }
}

main().catch((error) => {
  console.error('[FAIL] App Platform Phase 5 browser smoke');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
