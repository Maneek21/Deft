import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const database = process.env.DATABASE_URL;
const target = process.env.DEFT_TEST_DATABASE_URL;
assert.ok(database && database === target && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_phase5_test_c03_(?:b_experience|root(?:_v[0-9]+)?)$/.test(database));
const packagePath = process.env.GATE_G_INSTALLED_PACKAGE_PATH;
const evidenceDir = process.env.GATE_G_EXPERIENCE_EVIDENCE_DIR;
assert.ok(packagePath && evidenceDir, 'Set installed package and external evidence directory');
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:4315';
const key = (purpose: string) => createHash('sha256').update(`experience-browser:${purpose}`).digest('base64');
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
  schema_version: 'deft.app_run_keyring.v1',
  run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
  receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
  fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } },
});
const [{ app }, { db, closeDb }, schema, appService, reviewService,
  management, moduleService, webSessions, ringFixture, nodeServer] = await Promise.all([
  import('../src/index.js'), import('../src/lib/db.js'),
  import('@deft/db/schema'), import('../src/lib/app-service.js'),
  import('../src/lib/app-runtime-review.js'),
  import('../src/lib/app-runtime-management.js'),
  import('../src/lib/module-service.js'),
  import('../src/lib/web-sessions.js'),
  import('./fixtures/app-run-test-keyrings.js'),
  import('@hono/node-server'),
]);
const { and, eq } = await import('drizzle-orm');
const ring = await ringFixture.databaseCompleteAppRunTestKeyringFixture('experience-browser');
process.env.DEFT_APP_RUN_KEYRINGS = ring.environment;
ring.keys.destroy();
const suffix = randomUUID();
const orgId = randomUUID();
const userId = randomUUID();
const email = `experience-browser-${suffix}@example.test`;
await db.insert(schema.orgs).values({ id: orgId, name: 'Experience browser fixture', slug: `experience-browser-${suffix}` });
await db.insert(schema.users).values({ id: userId, name: 'Experience owner', email });
await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId,
  role: 'owner', is_active: true });
const owner = moduleService.humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
const json = await readFile(packagePath, 'utf8');
const staged = await appService.stageAppPackage(owner, json);
const [version] = await db.select().from(schema.appVersions).where(and(
  eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
assert.ok(version?.requested_grant_snapshot_id);
const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
  eq(schema.appGrantSnapshots.org_id, orgId),
  eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
assert.ok(requested);
const reviewRequest = { app_version_id: version.id, expected_package_digest: version.package_digest,
  expected_requested_snapshot_digest: requested.snapshot_digest,
  expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
const review = await reviewService.prepareRuntimeAppReview(owner, staged.id, reviewRequest);
const active = await reviewService.activateRuntimeApp(owner, staged.id, {
  ...reviewRequest, expected_review_digest: review.review_digest, accept_host_policy: true,
});
const [grant] = await db.select().from(schema.appGrantSnapshots).where(and(
  eq(schema.appGrantSnapshots.org_id, orgId), eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
assert.ok(grant);
const bindingRequest = { installation_id: staged.id, action_key: 'create_shipping_label',
  operator_user_id: userId, expected_app_version_id: version.id,
  expected_package_digest: version.package_digest, expected_grant_snapshot_digest: grant.snapshot_digest,
  expected_lifecycle_epoch: active.installation.lifecycle_epoch,
  expected_grant_epoch: active.installation.grant_epoch };
const bindingReview = await management.prepareRuntimeBindingReview(owner, bindingRequest);
await management.activateRuntimeBinding(owner, { ...bindingRequest,
  expected_review_digest: bindingReview.review_digest, accept_host_policy: true });
const server = nodeServer.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4316 });
const results: unknown[] = [];
await mkdir(evidenceDir, { recursive: true });
try {
  for (const [browserName, engine] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.GATE_G_BROWSER && browserName !== process.env.GATE_G_BROWSER) continue;
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [1280, 390, 320]) {
        if (process.env.GATE_G_WIDTH && width !== Number(process.env.GATE_G_WIDTH)) continue;
        const context = await browser.newContext({ viewport: { width, height: 850 } });
        const tokens = await webSessions.createWebSession({ id: userId, email, org_id: orgId });
        await context.addInitScript(({ access, refresh }) => {
          if (self !== top) return;
          localStorage.setItem('deft-access-token', access);
          localStorage.setItem('deft-refresh-token', refresh);
        }, { access: tokens.accessToken, refresh: tokens.refreshToken });
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        const consoleErrors: string[] = [];
        page.on('pageerror', (error) => consoleErrors.push(error.message));
        await page.goto(`http://localhost:4315/apps/${staged.id}/main`,
          { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.getByRole('heading', { name: 'Shipping Label' }).last().waitFor({ timeout: 30_000 });
        await page.getByRole('button', { name: 'Create shipping label' }).waitFor({ timeout: 30_000 });
        const input = page.getByLabel('Shipment identifier');
        await input.fill(`shipment-${browserName}-${width}`);
        await input.press('Tab');
        await page.getByRole('button', { name: 'Create shipping label' }).click();
        await page.getByText('Submitted. Open approvals to review the exact input.').waitFor({ timeout: 30_000 });
        const frame = page.frame({ url: /app-experience-bootstrap/ });
        assert.ok(frame, 'trusted bootstrap frame loaded');
        const isolation = await frame.evaluate(() => {
          let cookie = 'readable';
          try { cookie = document.cookie; } catch { cookie = 'blocked'; }
          return { origin: self.origin, cookie };
        });
        const screenshot = `${evidenceDir}/${browserName}-${width}.png`;
        await page.screenshot({ path: screenshot, fullPage: true });
        results.push({ browser: browserName, width, screenshot, isolation, consoleErrors,
          submitted: true, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
        assert.equal(isolation.origin, 'null', `${browserName} ${width}: opaque frame origin`);
        assert.equal(isolation.cookie, 'blocked', `${browserName} ${width}: host cookie unavailable`);
        assert.deepEqual(consoleErrors, []);
        await context.close();
      }
    } finally { await browser.close(); }
  }
  if (process.env.GATE_G_STALE_UI === 'true') {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 850 } });
      const tokens = await webSessions.createWebSession({ id: userId, email, org_id: orgId });
      await context.addInitScript(({ access, refresh }) => {
        if (self !== top) return;
        localStorage.setItem('deft-access-token', access);
        localStorage.setItem('deft-refresh-token', refresh);
      }, { access: tokens.accessToken, refresh: tokens.refreshToken });
      let releaseResponse!: () => void;
      let markPending!: () => void;
      const pending = new Promise<void>((resolve) => { markPending = resolve; });
      const held = new Promise<void>((resolve) => { releaseResponse = resolve; });
      await context.route('**/api/app-experiences/*/main/sessions', async (route) => {
        if (route.request().method() === 'POST') { markPending(); await held; }
        await route.continue();
      });
      const page = await context.newPage();
      await page.goto(`http://localhost:4315/apps/${staged.id}/main`, { waitUntil: 'domcontentloaded' });
      await pending;
      await page.getByRole('link', { name: 'App settings' }).click();
      await page.waitForURL('**/settings/apps');
      releaseResponse();
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('[aria-label="App Experience"]').count(), 0,
        'late session response cannot restore old Experience after navigation');
      await context.close();
    } finally { await browser.close(); }
  }
  const runs = await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
    .where(eq(schema.appRuns.org_id, orgId));
  assert.equal(runs.length, results.length, 'each browser/viewport action created one reviewed Run');
  await writeFile(`${evidenceDir}/results.json`, JSON.stringify({ app_installation_id: staged.id,
    app_version_id: version.id, package_digest: version.package_digest, runs: runs.length,
    results }, null, 2));
  process.stdout.write(JSON.stringify({ runs: runs.length, results }, null, 2) + '\n');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
}
