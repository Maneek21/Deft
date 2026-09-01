import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webUrl = (process.env.DEFT_WEB_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const email = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const password = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const evidenceDirectory = resolve(
  process.env.DEFT_APP_PLATFORM_EVIDENCE_DIR || 'dist/app-platform-phase6-certification',
);
const evidencePath = resolve(
  process.env.DEFT_APP_PLATFORM_PHASE6_BROWSER_EVIDENCE
    || process.env.DEFT_APP_PLATFORM_BROWSER_EVIDENCE
    || `${evidenceDirectory}/apps-phase6-browser-smoke.json`,
);
const upgradePackageInput = process.env.DEFT_APP_PLATFORM_UPGRADE_PACKAGE;
const phase5Script = resolve(scriptDirectory, 'app-platform-phase5-browser-smoke.mjs');
const appKitPackageJsonPath = resolve(scriptDirectory, '../../packages/app-kit/package.json');
const packageByteLimit = 1024 * 1024;
const desktopViewport = Object.freeze({ width: 1440, height: 900 });
const mobileViewport = Object.freeze({ width: 390, height: 844 });
const receiptDescription = 'Actor-authorized, tenant-scoped Run metadata and server-verified receipt proofs. Raw provider envelopes and output are not exposed here.';
const policyAcceptance = 'I accept Deft’s host-owned approval, retention, egress, and retry policy for these exact bindings.';

class CertificationFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'CertificationFailure';
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new CertificationFailure(code);
}

function errorCode(error) {
  return error instanceof CertificationFailure ? error.code : 'UNEXPECTED_BROWSER_FAILURE';
}

function safeOrigin(value) {
  try {
    const parsed = new URL(value);
    requireCondition(['http:', 'https:'].includes(parsed.protocol), 'WEB_URL_PROTOCOL_INVALID');
    requireCondition(!parsed.username && !parsed.password, 'WEB_URL_CREDENTIALS_FORBIDDEN');
    requireCondition(parsed.host.length <= 255, 'WEB_URL_HOST_INVALID');
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    if (error instanceof CertificationFailure) throw error;
    throw new CertificationFailure('WEB_URL_INVALID');
  }
}

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
        // The API validates keyrings. Keep the raw value only as an in-memory
        // marker so this certification never prints it.
      }
    }
    if (value.length >= 8) markers.add(value);
  }
  if (!process.env.DEFT_TEST_PASSWORD && password.length >= 8) markers.add(password);

  const extra = process.env.DEFT_APP_PLATFORM_SECRET_MARKERS;
  if (extra) {
    let parsed;
    try {
      parsed = JSON.parse(extra);
    } catch {
      throw new CertificationFailure('SECRET_MARKERS_INVALID');
    }
    requireCondition(
      Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'),
      'SECRET_MARKERS_INVALID',
    );
    collectStrings(parsed, markers);
  }
  return [...markers];
}

async function readUpgradePackage() {
  requireCondition(Boolean(upgradePackageInput), 'UPGRADE_PACKAGE_REQUIRED');
  const packagePath = resolve(upgradePackageInput);
  let packageStat;
  try {
    packageStat = await stat(packagePath);
  } catch {
    throw new CertificationFailure('UPGRADE_PACKAGE_UNREADABLE');
  }
  requireCondition(packageStat.isFile(), 'UPGRADE_PACKAGE_NOT_FILE');
  requireCondition(packageStat.size <= packageByteLimit, 'UPGRADE_PACKAGE_TOO_LARGE');

  let raw;
  let parsed;
  try {
    raw = await readFile(packagePath, 'utf8');
    requireCondition(Buffer.byteLength(raw, 'utf8') <= packageByteLimit, 'UPGRADE_PACKAGE_TOO_LARGE');
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof CertificationFailure) throw error;
    throw new CertificationFailure('UPGRADE_PACKAGE_INVALID_JSON');
  }
  const manifest = parsed && typeof parsed === 'object' ? parsed.manifest : null;
  requireCondition(parsed?.package_format === 'deft.app.package.v1', 'UPGRADE_PACKAGE_FORMAT_INVALID');
  requireCondition(manifest?.schema_version === '1', 'UPGRADE_MANIFEST_SCHEMA_INVALID');
  requireCondition(manifest?.compatibility?.app_protocol === '1', 'UPGRADE_PROTOCOL_INVALID');
  requireCondition(
    typeof manifest.id === 'string' && manifest.id.length > 0 && manifest.id.length <= 255,
    'UPGRADE_APP_ID_INVALID',
  );
  requireCondition(
    typeof manifest.name === 'string' && manifest.name.length > 0 && manifest.name.length <= 128,
    'UPGRADE_APP_NAME_INVALID',
  );
  requireCondition(
    typeof manifest.version === 'string'
      && manifest.version.length <= 64
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version),
    'UPGRADE_APP_VERSION_INVALID',
  );
  return { packagePath, manifest };
}

async function readAppKitContract() {
  try {
    const parsed = JSON.parse(await readFile(appKitPackageJsonPath, 'utf8'));
    requireCondition(parsed.name === '@deft/app-kit', 'APP_KIT_PACKAGE_INVALID');
    requireCondition(typeof parsed.version === 'string' && parsed.version.length <= 64, 'APP_KIT_VERSION_INVALID');
    return { packageName: parsed.name, version: parsed.version };
  } catch (error) {
    if (error instanceof CertificationFailure) throw error;
    throw new CertificationFailure('APP_KIT_PACKAGE_UNREADABLE');
  }
}

async function runPhase5Baseline() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'deft-phase6-browser-'));
  const baselineEvidencePath = resolve(temporaryDirectory, 'apps-browser-smoke.json');
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [phase5Script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DEFT_APP_PLATFORM_REQUIRE_CONNECTED: 'true',
          DEFT_APP_PLATFORM_EVIDENCE_DIR: temporaryDirectory,
          DEFT_APP_PLATFORM_BROWSER_EVIDENCE: baselineEvidencePath,
        },
        stdio: 'ignore',
      });
      child.once('error', () => rejectRun(new CertificationFailure('PHASE5_BASELINE_LAUNCH_FAILED')));
      child.once('close', (code) => {
        if (code === 0) resolveRun();
        else rejectRun(new CertificationFailure('PHASE5_BASELINE_FAILED'));
      });
    });
    let baseline;
    try {
      baseline = JSON.parse(await readFile(baselineEvidencePath, 'utf8'));
    } catch {
      throw new CertificationFailure('PHASE5_BASELINE_EVIDENCE_INVALID');
    }
    requireCondition(
      baseline.schema === 'deft.app_platform.phase5.browser_smoke.v1' && baseline.result === 'passed',
      'PHASE5_BASELINE_EVIDENCE_INVALID',
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function login(page) {
  await page.goto(`${webUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  const loginResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/login',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const response = await loginResponse;
  requireCondition(response.ok(), 'LOGIN_FAILED');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

async function openApps(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${webUrl}/settings/apps`, { waitUntil: 'domcontentloaded' });
  requireCondition(!new URL(page.url()).pathname.startsWith('/login'), 'APPS_REDIRECTED_TO_LOGIN');
  const title = viewport.width < 768
    ? page.getByText('Settings · Apps', { exact: true })
    : page.getByRole('heading', { name: 'Apps', exact: true });
  await title.first().waitFor({ state: 'visible', timeout: 20_000 });
}

function appCard(page, appId) {
  return page.locator('article').filter({ hasText: `${appId}@` }).first();
}

async function waitForApp(page, appId, state, version) {
  const card = appCard(page, appId);
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await card.getByText(state, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  if (version) {
    await card.getByText(`${appId}@${version}`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  }
  return card;
}

async function assertSafeRenderedSurface(page, markers, codePrefix) {
  const [text, html] = await Promise.all([
    page.locator('body').innerText(),
    page.content(),
  ]);
  for (const marker of markers) {
    requireCondition(!text.includes(marker) && !html.includes(marker), `${codePrefix}_SECRET_VISIBLE`);
  }
  const rendered = `${text}\n${html}`;
  requireCondition(!/deft_app_dev_[A-Za-z0-9_-]{16,}/.test(rendered), `${codePrefix}_TOKEN_VISIBLE`);
  requireCondition(!/hmac-sha256:[a-f0-9]{64}/i.test(rendered), `${codePrefix}_SIGNATURE_VISIBLE`);
}

async function assertConnectedContract(card, appKit) {
  await card.getByRole('heading', { name: 'Supported local contract', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  const text = await card.innerText();
  requireCondition(text.includes(`${appKit.packageName} ${appKit.version}`), 'APP_KIT_COMPATIBILITY_MISSING');
  requireCondition(text.includes('App Protocol v1'), 'APP_PROTOCOL_COMPATIBILITY_MISSING');
  requireCondition(text.includes('deft.app.package.v1'), 'PACKAGE_FORMAT_COMPATIBILITY_MISSING');
  requireCondition(text.includes('stage only'), 'STAGE_ONLY_COMPATIBILITY_MISSING');
  requireCondition(
    text.includes('Local packages are unsigned. Source provenance is an unverified author claim, not a registry attestation.'),
    'UNSIGNED_PROVENANCE_WARNING_MISSING',
  );
  requireCondition(text.includes('Package provenance') && text.includes('Local unsigned'), 'PACKAGE_PROVENANCE_MISSING');
}

async function openAndVerifyReceipt(
  page,
  card,
  markers,
  screenshotPath,
  codePrefix,
  expectedState = null,
  expectedReceiptKind = null,
) {
  const recentRuns = card.getByRole('heading', { name: 'Recent Runs', exact: true });
  await recentRuns.waitFor({ state: 'visible', timeout: 20_000 });
  const list = recentRuns.locator('xpath=following-sibling::ul[1]');
  requireCondition(await list.count() === 1, `${codePrefix}_RECENT_RUN_MISSING`);
  const runButton = list.getByRole('button').first();
  await runButton.waitFor({ state: 'visible', timeout: 20_000 });
  await runButton.click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.getByText(receiptDescription, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.getByRole('heading', { name: 'Verified receipts', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  if (expectedState) {
    await dialog.getByRole('heading', { name: expectedState, exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 });
  }
  if (expectedReceiptKind) {
    await dialog.getByText(expectedReceiptKind, { exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 });
  }
  for (const label of ['Operation', 'Risk', 'Review', 'Retry', 'Retention', 'Result retention']) {
    await dialog.getByText(label, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  }
  await dialog.getByText('Verified', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
  await assertSafeRenderedSurface(page, markers, codePrefix);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
}

async function stageUpgrade(page, card, manifest, packagePath) {
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 20_000 });
  await card.getByRole('button', { name: 'Stage upgrade', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(packagePath);

  await page.getByRole('heading', { name: `Review ${manifest.name} upgrade`, exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  const inspection = page.getByRole('heading', { name: `Review ${manifest.name} upgrade`, exact: true })
    .locator('xpath=ancestor::section[1]');
  const inspectionText = await inspection.innerText();
  requireCondition(inspectionText.includes('App v1'), 'UPGRADE_INSPECTION_PROTOCOL_MISSING');
  requireCondition(inspectionText.includes('deft.app.package.v1'), 'UPGRADE_INSPECTION_FORMAT_MISSING');
  requireCondition(inspectionText.includes('Unsigned local'), 'UPGRADE_INSPECTION_PROVENANCE_MISSING');
  requireCondition(inspectionText.includes('Staging grants no authority.'), 'UPGRADE_INSPECTION_AUTHORITY_WARNING_MISSING');
  await inspection.getByRole('button', { name: 'Stage upgrade for review', exact: true }).click();
  await page.getByRole('status')
    .filter({ hasText: `${manifest.name} ${manifest.version} staged for explicit upgrade review.` })
    .waitFor({ state: 'visible', timeout: 20_000 });
}

async function reviewAndActivate(page, card, activationKind) {
  const labels = activationKind === 'upgrade'
    ? {
        review: 'Review exact upgrade authority',
        activate: 'Upgrade reviewed App',
        success: 'Connected App upgraded with freshly reviewed authority.',
      }
    : {
        review: 'Review exact re-enable authority',
        activate: 'Re-enable reviewed App',
        success: 'Connected App re-enabled with freshly reviewed authority.',
      };
  const reviewButton = card.getByRole('button', { name: labels.review, exact: true });
  await reviewButton.waitFor({ state: 'visible', timeout: 20_000 });
  requireCondition(await reviewButton.isEnabled(), `${activationKind.toUpperCase()}_REVIEW_NOT_READY`);
  await reviewButton.click();

  await card.getByRole('heading', {
    name: /^(Initial connected authority|Authority unchanged|Authority widened or changed incompatibly)$/,
  }).waitFor({ state: 'visible', timeout: 20_000 });
  const acceptance = card.getByRole('checkbox', { name: policyAcceptance, exact: true });
  await acceptance.waitFor({ state: 'visible', timeout: 20_000 });
  await acceptance.check();
  requireCondition(await acceptance.isChecked(), `${activationKind.toUpperCase()}_POLICY_NOT_ACCEPTED`);

  const activateButton = card.getByRole('button', { name: labels.activate, exact: true });
  requireCondition(await activateButton.isEnabled(), `${activationKind.toUpperCase()}_ACTIVATE_NOT_READY`);
  await activateButton.click();
  await page.getByRole('status').filter({ hasText: labels.success })
    .waitFor({ state: 'visible', timeout: 20_000 });
}

async function invokePackedProviderThroughUi(
  page,
  manifest,
  markers,
  receiptScreenshotPath,
  setStage,
) {
  setStage('packed_provider_campaign_list');
  await page.goto(`${webUrl}/modules/resource-campaigns/campaigns`, { waitUntil: 'domcontentloaded' });
  const campaignLinks = page.getByRole('link', { name: 'Connected campaign', exact: true });
  await campaignLinks.first().waitFor({ state: 'visible', timeout: 20_000 });
  const campaignHrefs = await campaignLinks.evaluateAll((links) => [
    ...new Set(links.map((link) => link.getAttribute('href')).filter(Boolean)),
  ]);
  requireCondition(campaignHrefs.length === 1, 'CONNECTED_CAMPAIGN_NOT_UNIQUE');
  await campaignLinks.first().click();
  setStage('packed_provider_campaign_record');
  await page.getByRole('heading', { name: 'Connected campaign', exact: true, level: 1 })
    .waitFor({ state: 'visible', timeout: 20_000 });

  const actions = page.locator('section[aria-label="App actions"]');
  await actions.waitFor({ state: 'visible', timeout: 20_000 });
  await actions.getByRole('button', { name: 'Send campaign email', exact: true }).click();
  setStage('packed_provider_action_review');
  const actionDialog = page.getByRole('dialog');
  await actionDialog.getByRole('heading', { name: 'Send campaign email', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  await actionDialog.getByRole('button', { name: 'Review action', exact: true }).click();
  await actionDialog.getByRole('button', { name: 'Confirm and run', exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  const invocationResponsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return response.request().method() === 'POST' && pathname === '/api/app-actions/invoke';
  }, { timeout: 20_000 });
  await actionDialog.getByRole('button', { name: 'Confirm and run', exact: true }).click();
  setStage('packed_provider_action_submission');
  const invocationResponse = await invocationResponsePromise;
  requireCondition(invocationResponse.ok(), 'PACKED_PROVIDER_INVOCATION_FAILED');
  const invocationBody = await invocationResponse.json().catch(() => null);
  const invokedRunId = invocationBody?.run?.id;
  requireCondition(
    typeof invokedRunId === 'string' && invokedRunId.length > 0 && invokedRunId.length <= 512,
    'PACKED_PROVIDER_RUN_ID_INVALID',
  );
  const inboxLink = actionDialog.getByRole('link', { name: 'Review approval in Inbox', exact: true });
  await inboxLink.waitFor({ state: 'visible', timeout: 20_000 });
  await assertSafeRenderedSurface(page, markers, 'PACKED_PROVIDER_ACTION');
  const attentionResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === '/api/attention'
      && url.searchParams.get('lane') === 'needs_you'
      && url.searchParams.get('state') === 'open';
  }, { timeout: 20_000 });
  await inboxLink.click();

  setStage('packed_provider_inbox_navigation');
  await page.getByRole('heading', { name: 'Inbox', exact: true, level: 1 })
    .waitFor({ state: 'visible', timeout: 20_000 });
  setStage('packed_provider_inbox_correlation');
  const attentionResponse = await attentionResponsePromise;
  requireCondition(attentionResponse.ok(), 'PACKED_PROVIDER_ATTENTION_FAILED');
  const attentionBody = await attentionResponse.json().catch(() => null);
  const reviewableItems = Array.isArray(attentionBody?.items)
    ? attentionBody.items.filter((item) => item?.kind === 'approval' && item?.approval)
    : [];
  const approvalIndex = reviewableItems.findIndex(
    (item) => item.approval?.action === 'app_run_invoke'
      && item.approval?.params?.run_id === invokedRunId,
  );
  requireCondition(approvalIndex >= 0, 'PACKED_PROVIDER_APPROVAL_NOT_LISTED');
  const targetApproval = reviewableItems[approvalIndex]?.approval;
  const targetPreview = targetApproval?.params?.safe_preview;
  const targetResourceRefs = Array.isArray(targetPreview?.resource_refs)
    ? targetPreview.resource_refs
    : [];
  requireCondition(
    targetPreview?.title === 'Send campaign email'
      && targetResourceRefs.some((ref) => ref?.label === 'Connected campaign'),
    'PACKED_PROVIDER_APPROVAL_PREVIEW_INVALID',
  );
  const approveButton = page
    .getByRole('button', { name: 'Approve App action', exact: true }).nth(approvalIndex);
  await approveButton.waitFor({ state: 'visible', timeout: 20_000 });
  const approvalCard = approveButton.locator(
    'xpath=ancestor::div[contains(@class, "max-w-[460px]")][1]',
  );
  await approvalCard.getByText('Send campaign email', { exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  await approvalCard.getByText('Connected campaign', { exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  setStage('packed_provider_inbox_approval');
  const approvalResponse = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return response.request().method() === 'POST'
      && /^\/api\/agent\/actions\/[^/]+\/approve$/.test(pathname);
  }, { timeout: 20_000 });
  await approveButton.click();
  requireCondition((await approvalResponse).ok(), 'PACKED_PROVIDER_APPROVAL_FAILED');

  setStage('packed_provider_run_inspection');
  await openApps(page, desktopViewport);
  const card = await waitForApp(page, manifest.id, 'active', manifest.version);
  const recentRuns = card.getByRole('heading', { name: 'Recent Runs', exact: true });
  await recentRuns.waitFor({ state: 'visible', timeout: 20_000 });
  const newestRun = recentRuns.locator('xpath=following-sibling::ul[1]').getByRole('button').first();
  await newestRun.getByText('Send campaign email', { exact: true })
    .waitFor({ state: 'visible', timeout: 20_000 });
  try {
    await newestRun.getByText('succeeded', { exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    throw new CertificationFailure('PACKED_PROVIDER_RUN_NOT_SUCCEEDED');
  }
  setStage('packed_provider_receipt');
  await openAndVerifyReceipt(
    page,
    card,
    markers,
    receiptScreenshotPath,
    'PACKED_PROVIDER_RECEIPT',
    'succeeded',
    'attempt terminal',
  );
}

function installFailureTracking(page) {
  const counts = {
    desktop: { console: 0, page: 0, api: 0 },
    mobile: { console: 0, page: 0, api: 0 },
  };
  let phase = 'desktop';
  page.on('console', (message) => {
    if (message.type() === 'error') counts[phase].console += 1;
  });
  page.on('pageerror', () => {
    counts[phase].page += 1;
  });
  page.on('response', (response) => {
    let pathname;
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (response.status() >= 400
      && (pathname === '/api/apps'
        || pathname.startsWith('/api/apps/')
        || pathname.startsWith('/api/app-runs/')
        || pathname.startsWith('/api/app-actions/')
        || pathname.startsWith('/api/agent/actions/')
        || pathname.startsWith('/api/attention')
        || pathname.startsWith('/api/modules')
        || pathname === '/api/mcp-connections'
        || pathname.startsWith('/api/mcp-connections/'))) {
      counts[phase].api += 1;
    }
  });
  return {
    counts,
    setPhase(nextPhase) {
      phase = nextPhase;
    },
  };
}

function relativeEvidencePath(path) {
  return relative(evidenceDirectory, path).replaceAll('\\', '/');
}

function serializedSafeEvidence(evidence, markers) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const unsafe = markers.some((marker) => serialized.includes(marker))
    || /deft_app_dev_[A-Za-z0-9_-]{16,}/.test(serialized)
    || /hmac-sha256:[a-f0-9]{64}/i.test(serialized);
  if (!unsafe) return serialized;
  return `${JSON.stringify({
    schema: evidence.schema,
    result: 'failed',
    route: '/settings/apps',
    completed_at: evidence.completed_at,
    error_code: 'UNSAFE_EVIDENCE_BLOCKED',
  }, null, 2)}\n`;
}

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(dirname(evidencePath), { recursive: true });
  let markers = [];
  let failureTracking = null;
  const evidence = {
    schema: 'deft.app_platform.phase6.browser_smoke.v1',
    result: 'failed',
    target_origin: null,
    route: '/settings/apps',
    completed_at: null,
    baseline: { phase5_browser_smoke: false },
    upgrade: {
      source: 'DEFT_APP_PLATFORM_UPGRADE_PACKAGE',
      package_format: 'deft.app.package.v1',
      protocol_version: '1',
      expected_version: null,
    },
    checks: {
      authenticated_login: false,
      compatible_unsigned_contract_visible: false,
      desktop_safe_receipt_visible: false,
      upgrade_staged_through_file_ui: false,
      upgrade_exact_review_accepted_and_activated: false,
      disabled_then_freshly_reviewed_and_reenabled: false,
      packed_provider_invoked_through_ui: false,
      mobile_active_upgrade_visible: false,
      mobile_safe_receipt_visible: false,
      no_horizontal_overflow: false,
      no_console_page_or_api_failures: false,
      no_secret_or_signature_markers: false,
    },
    screenshots: {},
    observed_failures: {
      desktop: { console: 0, page: 0, api: 0 },
      mobile: { console: 0, page: 0, api: 0 },
    },
    failed_stage: null,
  };
  let browser;
  let currentStage = 'initialization';
  try {
    markers = secretMarkers();
    evidence.target_origin = safeOrigin(webUrl);
    const [{ packagePath, manifest }, appKit] = await Promise.all([
      readUpgradePackage(),
      readAppKitContract(),
    ]);
    evidence.upgrade.expected_version = manifest.version;

    currentStage = 'phase5_browser_baseline';
    await runPhase5Baseline();
    evidence.baseline.phase5_browser_smoke = true;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: desktopViewport });
    const page = await context.newPage();
    failureTracking = installFailureTracking(page);

    currentStage = 'authenticated_login';
    await login(page);
    evidence.checks.authenticated_login = true;
    currentStage = 'desktop_apps_contract';
    await openApps(page, desktopViewport);
    let card = await waitForApp(page, manifest.id, 'active');
    await assertConnectedContract(card, appKit);
    evidence.checks.compatible_unsigned_contract_visible = true;

    const desktopReceiptPath = resolve(evidenceDirectory, 'phase6-desktop-receipt.png');
    await openAndVerifyReceipt(page, card, markers, desktopReceiptPath, 'DESKTOP_RECEIPT');
    evidence.checks.desktop_safe_receipt_visible = true;
    evidence.screenshots.desktop_receipt = relativeEvidencePath(desktopReceiptPath);

    currentStage = 'desktop_upgrade_staging';
    await stageUpgrade(page, card, manifest, packagePath);
    evidence.checks.upgrade_staged_through_file_ui = true;
    card = await waitForApp(page, manifest.id, 'active');
    currentStage = 'desktop_upgrade_activation';
    await reviewAndActivate(page, card, 'upgrade');
    card = await waitForApp(page, manifest.id, 'active', manifest.version);
    evidence.checks.upgrade_exact_review_accepted_and_activated = true;
    const desktopUpgradePath = resolve(evidenceDirectory, 'phase6-desktop-upgraded.png');
    await assertSafeRenderedSurface(page, markers, 'DESKTOP_UPGRADE');
    await page.screenshot({ path: desktopUpgradePath, fullPage: true });
    evidence.screenshots.desktop_upgraded = relativeEvidencePath(desktopUpgradePath);

    currentStage = 'desktop_disable';
    await card.getByRole('button', { name: 'Disable', exact: true }).click();
    await page.getByRole('status')
      .filter({ hasText: `${manifest.name} is disabled. Its data is preserved.` })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await waitForApp(page, manifest.id, 'disabled', manifest.version);
    await openApps(page, desktopViewport);
    card = await waitForApp(page, manifest.id, 'disabled', manifest.version);
    currentStage = 'desktop_reenable';
    await reviewAndActivate(page, card, 'reenable');
    card = await waitForApp(page, manifest.id, 'active', manifest.version);
    evidence.checks.disabled_then_freshly_reviewed_and_reenabled = true;
    const desktopReenabledPath = resolve(evidenceDirectory, 'phase6-desktop-reenabled.png');
    await assertSafeRenderedSurface(page, markers, 'DESKTOP_REENABLED');
    await page.screenshot({ path: desktopReenabledPath, fullPage: true });
    evidence.screenshots.desktop_reenabled = relativeEvidencePath(desktopReenabledPath);

    await invokePackedProviderThroughUi(
      page,
      manifest,
      markers,
      desktopReceiptPath,
      (stage) => { currentStage = stage; },
    );
    evidence.checks.packed_provider_invoked_through_ui = true;

    currentStage = 'mobile_apps_contract';
    failureTracking.setPhase('mobile');
    await openApps(page, mobileViewport);
    card = await waitForApp(page, manifest.id, 'active', manifest.version);
    evidence.checks.mobile_active_upgrade_visible = true;
    const mobileReceiptPath = resolve(evidenceDirectory, 'phase6-mobile-receipt.png');
    await openAndVerifyReceipt(page, card, markers, mobileReceiptPath, 'MOBILE_RECEIPT');
    evidence.checks.mobile_safe_receipt_visible = true;
    evidence.screenshots.mobile_receipt = relativeEvidencePath(mobileReceiptPath);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    requireCondition(overflow <= 2, 'MOBILE_HORIZONTAL_OVERFLOW');
    evidence.checks.no_horizontal_overflow = true;
    const mobileFinalPath = resolve(evidenceDirectory, 'phase6-mobile-final.png');
    await assertSafeRenderedSurface(page, markers, 'MOBILE_FINAL');
    await page.screenshot({ path: mobileFinalPath, fullPage: true });
    evidence.screenshots.mobile_final = relativeEvidencePath(mobileFinalPath);

    evidence.observed_failures = failureTracking.counts;
    for (const phase of ['desktop', 'mobile']) {
      requireCondition(failureTracking.counts[phase].console === 0, `${phase.toUpperCase()}_CONSOLE_FAILURE`);
      requireCondition(failureTracking.counts[phase].page === 0, `${phase.toUpperCase()}_PAGE_FAILURE`);
      requireCondition(failureTracking.counts[phase].api === 0, `${phase.toUpperCase()}_API_FAILURE`);
    }
    evidence.checks.no_console_page_or_api_failures = true;
    evidence.checks.no_secret_or_signature_markers = true;
    evidence.result = 'passed';
    evidence.completed_at = new Date().toISOString();
    console.log('APP_PLATFORM_PHASE6_BROWSER_SMOKE_PASSED');
    console.log('Evidence written to the configured path.');
  } catch (error) {
    evidence.completed_at = new Date().toISOString();
    evidence.error_code = errorCode(error);
    evidence.failed_stage = currentStage;
    throw error;
  } finally {
    if (failureTracking) evidence.observed_failures = failureTracking.counts;
    await writeFile(evidencePath, serializedSafeEvidence(evidence, markers), 'utf8');
    if (browser) await browser.close();
  }
}

main().catch((error) => {
  console.error(`[FAIL] App Platform Phase 6 browser smoke: ${errorCode(error)}`);
  process.exitCode = 1;
});
