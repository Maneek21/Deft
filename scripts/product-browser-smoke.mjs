import { chromium } from 'playwright';

const webUrl = (process.env.DEFT_WEB_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const email = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const password = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const approvalMarker = process.env.DEFT_APPROVAL_SMOKE_MARKER;
const runMarker = process.env.GITHUB_RUN_ID || String(Date.now());
const chatMarker = `CI browser chat ${runMarker}`;
const taskMarker = `CI browser task ${runMarker}`;

if (!approvalMarker) throw new Error('DEFT_APPROVAL_SMOKE_MARKER is required');

const results = [];
const record = (name, detail = '') => {
  results.push({ name, detail });
  console.log(`[PASS] ${name}${detail ? ` - ${detail}` : ''}`);
};

async function settle(page, path) {
  await page.goto(`${webUrl}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(350);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__deftGetUserMediaCalls = 0;
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    if (!originalGetUserMedia) return;
    navigator.mediaDevices.getUserMedia = (...args) => {
      window.__deftGetUserMediaCalls += 1;
      return originalGetUserMedia.apply(navigator.mediaDevices, args);
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(`${webUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-email').fill(email);
    await page.locator('#login-password').fill(password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 }),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    record('Login through the production UI', email);

    await settle(page, '/chat');
    const general = page.getByText('general', { exact: true }).first();
    await general.click();
    const huddleControl = page.locator('button[title="Start a huddle"]');
    await huddleControl.waitFor({ state: 'visible', timeout: 10_000 });
    const mediaRequests = await page.evaluate(() => window.__deftGetUserMediaCalls ?? 0);
    if (mediaRequests !== 0) {
      throw new Error(`Rendering the huddle control requested microphone access ${mediaRequests} time(s)`);
    }
    record('Expose the huddle start control without requesting microphone access', '#general');

    const composer = page.locator('[contenteditable="true"]').last();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill(chatMarker);
    await composer.press('Enter');
    const renderedMessages = page.locator('[data-message-id]').filter({ hasText: chatMarker });
    await renderedMessages.first().waitFor({ timeout: 10_000 });
    const renderedMessageCount = await renderedMessages.count();
    if (renderedMessageCount !== 1) {
      throw new Error(`Expected one rendered chat message, found ${renderedMessageCount}`);
    }
    record('Post and render a chat message', '#general');

    await settle(page, '/tasks');
    await page.getByRole('button', { name: /New task/i }).first().click();
    await page.getByPlaceholder('Task title').fill(taskMarker);
    await page.getByRole('button', { name: 'Create task', exact: true }).click();
    const createdTask = page.getByText(taskMarker, { exact: true }).first();
    await createdTask.waitFor({ timeout: 10_000 });
    record('Create a task through the production UI');

    await createdTask.click();
    await page.getByRole('heading', { name: taskMarker, exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Backlog', exact: true }).last().click();
    await page.getByRole('button', { name: 'To Do', exact: true }).last().click();
    await page.getByRole('button', { name: 'To Do', exact: true }).last().waitFor({ timeout: 10_000 });
    record('Update task status inline', 'Backlog -> To Do');

    await settle(page, '/inbox?tab=approvals');
    const approveButton = page.getByRole('button', { name: /Approve post/i }).first();
    await approveButton.waitFor({ state: 'visible', timeout: 10_000 });
    const [approvalResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/agent/actions/') && response.url().endsWith('/approve')),
      approveButton.click(),
    ]);
    if (!approvalResponse.ok()) {
      throw new Error(`Approval returned ${approvalResponse.status()}: ${await approvalResponse.text()}`);
    }
    record('Approve a governed write from Inbox');

    await settle(page, '/chat');
    await page.getByText('general', { exact: true }).first().click();
    await page.getByText(approvalMarker, { exact: true }).waitFor({ timeout: 10_000 });
    record('Verify the approved write on its destination surface');

    for (const [path, heading] of [
      ['/settings', 'Settings'],
      ['/settings/profile', 'Profile'],
      ['/settings/apps', 'Apps'],
      ['/settings/mcp-access', 'Your connections'],
    ]) {
      await settle(page, path);
      await page.getByRole('heading', { name: heading }).first().waitFor({ timeout: 10_000 });
      if (path === '/settings/apps') {
        await page.getByText('No Apps installed', { exact: true }).waitFor({ timeout: 10_000 });
      }
    }
    record('Navigate core settings surfaces');

    await page.getByRole('searchbox', { name: 'Search connections' }).fill('no-such-smoke-connection');
    await page.getByRole('heading', { name: 'No matching connections' }).waitFor();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await page.getByRole('heading', { name: 'Which app would you like to connect?', exact: true }).waitFor();
    await page.getByRole('button', { name: /^Claude Code Use a personal token/ }).click();
    await page.getByRole('button', { name: 'Review access', exact: true }).click();
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('custom');
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const setupOverflow = await page.locator('section[aria-labelledby="setup-heading"]').evaluate((section) => section.scrollWidth - section.clientWidth);
      if (setupOverflow > 2) throw new Error(`Claude Code setup overflows its cards by ${setupOverflow}px at ${width}px`);
      await page.getByRole('button', { name: 'Continue to connect', exact: true }).click();
      await page.getByRole('textbox', { name: 'Connection name', exact: true }).fill('Smoke test draft');
      const commandOverflow = await page.getByRole('textbox', { name: 'Connection name', exact: true }).evaluate((input) => {
        const section = input.closest('section');
        return section.scrollWidth - section.clientWidth;
      });
      if (commandOverflow > 2) throw new Error(`Claude Code command expands its card at ${width}px`);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Continue to connect', exact: true }).click();
      if (await page.getByRole('textbox', { name: 'Connection name', exact: true }).inputValue() !== 'Smoke test draft') {
        throw new Error('Connection name was lost between setup steps');
      }
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    }
    record('Claude Code custom permissions stay inside setup cards at desktop, tablet and mobile widths');

    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
    if (await page.getByRole('button', { name: 'Continue to connect', exact: true }).isEnabled()) {
      throw new Error('Setup permits an empty permission selection');
    }
    await page.getByRole('checkbox', { name: 'Read tasks, comments and progress', exact: true }).check();
    await page.getByRole('button', { name: 'Continue to connect', exact: true }).click();
    const personalConnectionName = `Browser smoke ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Connection name', exact: true }).fill(personalConnectionName);
    await page.getByRole('button', { name: 'Generate token', exact: true }).click();
    await page.getByRole('checkbox', { name: 'I have saved this token securely.', exact: true }).waitFor({ timeout: 10_000 });
    if (await page.getByRole('button', { name: 'Check connection', exact: true }).isEnabled()) {
      throw new Error('Setup skipped the one-time token acknowledgement');
    }
    await page.getByRole('checkbox', { name: 'I have saved this token securely.', exact: true }).check();
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByRole('heading', { name: 'Waiting for the first request', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Your connections', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search connections' }).fill(personalConnectionName);
    await page.getByText(personalConnectionName, { exact: true }).click();
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.getByRole('button', { name: 'Keep connection', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
    await page.getByRole('heading', { name: 'No matching connections', exact: true }).waitFor();
    await page.getByRole('button', { name: /^Connection history/ }).click();
    await page.locator('summary').filter({ hasText: personalConnectionName }).waitFor();
    record('Create, acknowledge, inspect and revoke a personal connection without exposing its token');

    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page, '/settings/modules');
    const availableTab = page.getByRole('button', { name: /Available/i }).first();
    if (await availableTab.count()) await availableTab.click();
    const installModule = page.getByRole('button', { name: 'Install module' }).first();
    if (await installModule.count()) {
      await installModule.click();
      await page.getByText(/installed and ready/i).first().waitFor({ timeout: 15_000 });
    }
    await settle(page, '/modules/contacts/contacts');
    const collectionTabs = page.getByRole('tablist', { name: /contacts collections/i });
    await collectionTabs.waitFor({ state: 'visible', timeout: 10_000 });
    const collectionAside = page.locator('aside').filter({ hasText: /^Collections$/ });
    if (await collectionAside.count()) {
      throw new Error('Desktop Contacts still renders a second collections sidebar');
    }
    for (const label of ['Contacts', 'Companies', 'Deals', 'Activities']) {
      await collectionTabs.getByRole('tab', { name: label, exact: true }).waitFor({ state: 'visible' });
    }
    await collectionTabs.getByRole('tab', { name: 'Companies', exact: true }).click();
    await page.waitForURL((url) => url.pathname.includes('/modules/contacts/companies'), { timeout: 10_000 });
    record('Contacts uses collection tabs without a second left rail');

    await page.setViewportSize({ width: 390, height: 844 });
    const mobilePaths = ['/chat', '/tasks', '/knowledge', '/calendar', '/notes', '/inbox', '/settings', '/modules/contacts/contacts'];
    for (const path of mobilePaths) {
      await settle(page, path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 2) throw new Error(`${path} overflows the mobile viewport by ${overflow}px`);
    }
    record('Core mobile surfaces avoid document-level horizontal overflow', `${mobilePaths.length} routes`);

    if (pageErrors.length > 0) {
      throw new Error(`Browser page errors: ${pageErrors.join(' | ')}`);
    }
    record('No uncaught browser page errors');

    console.log(`\nProduct browser smoke passed: ${results.length} checks`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('[FAIL] Product browser smoke');
  console.error(error);
  process.exitCode = 1;
});
