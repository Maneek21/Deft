import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const mode = process.argv[2] || 'fixed';
const delayedOnly = process.argv.includes('--delayed-back-only');
const webUrl = (process.env.DEFT_NOTES_WEB_URL || (mode === 'broken' ? 'http://127.0.0.1:3140' : 'http://127.0.0.1:3160')).replace(/\/$/, '');
const apiUrl = 'http://127.0.0.1:3141';
const password = 'Preview-only-password-2026!';
const ownerEmail = 'owner@preview-fixture-alpha.local';
const outsiderEmail = 'member@preview-fixture-beta.local';
const outputDir = path.resolve('tmp/preview-stabilization/notes-browser', mode);
const results = [];

async function login(email) {
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Login failed for ${email}: ${response.status}`);
  return response.json();
}

async function apiRequest(token, route, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${apiUrl}${route}`, { ...options, headers });
}

async function createNote(token, suffix) {
  const response = await apiRequest(token, '/api/daily-notes', {
    method: 'POST',
    body: JSON.stringify({
      title: `Browser probe ${suffix}`,
      content: '<p>server-original</p>',
      visibility: 'private',
    }),
  });
  if (!response.ok) throw new Error(`Create note failed: ${response.status}`);
  return response.json();
}

async function readNote(token, id) {
  const response = await apiRequest(token, `/api/daily-notes/${id}`);
  if (!response.ok) throw new Error(`Read note failed: ${response.status}`);
  return response.json();
}

async function openNote(browser, auth, noteId, viewport) {
  const context = await browser.newContext({ viewport });
  if (mode === 'fixed') {
    await context.route(`${apiUrl}/**`, async route => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': webUrl,
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          },
        });
      }
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), 'Access-Control-Allow-Origin': webUrl },
      });
    });
  }
  await context.addInitScript(({ accessToken, refreshToken }) => {
    localStorage.setItem('deft-access-token', accessToken);
    localStorage.setItem('deft-refresh-token', refreshToken);
  }, auth);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${webUrl}/notes?id=${noteId}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForTimeout(250);
  return { context, page, pageErrors };
}

async function replaceBody(page, value) {
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
}

async function anyVisible(locator) {
  return locator.evaluateAll(elements => elements.some(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }));
}

async function runBodyTitle(browser, auth, viewport) {
  const note = await createNote(auth.accessToken, `body-title-${mode}-${viewport.width}`);
  const { context, page, pageErrors } = await openNote(browser, auth, note.id, viewport);
  const patches = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/daily-notes/${note.id}`)) {
      patches.push(request.postDataJSON());
    }
  });
  try {
    await replaceBody(page, `body-title-${mode}-${viewport.width}`);
    await page.getByPlaceholder('Untitled').fill(`Changed title ${mode}`);
    await page.waitForTimeout(1800);
    const persisted = await readNote(auth.accessToken, note.id);
    const visibleStatus = await page.getByText(/^(Saved|Saving|Not saved)/).allTextContents();
    const bodyPersisted = persisted.content.includes(`body-title-${mode}-${viewport.width}`);
    const pass = mode === 'broken'
      ? !bodyPersisted && patches.length === 1 && patches[0]?.title
      : bodyPersisted && patches.some(body => body.title) && patches.some(body => body.content) && visibleStatus.some(text => text.includes('Saved'));
    results.push({ scenario: 'body-title', viewport, pass: Boolean(pass), patches, persistedContent: persisted.content, visibleStatus, pageErrors });
    await page.screenshot({ path: path.join(outputDir, `body-title-${viewport.width}.png`), fullPage: true });
  } finally {
    await context.close();
    await apiRequest(auth.accessToken, `/api/daily-notes/${note.id}`, { method: 'DELETE' });
  }
}

async function runBodyIcon(browser, auth) {
  const viewport = { width: 1440, height: 900 };
  const note = await createNote(auth.accessToken, `body-icon-${mode}`);
  const { context, page, pageErrors } = await openNote(browser, auth, note.id, viewport);
  const patches = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && request.url().endsWith(`/api/daily-notes/${note.id}`)) patches.push(request.postDataJSON());
  });
  try {
    await replaceBody(page, `body-icon-${mode}`);
    await page.getByRole('button', { name: 'Change icon' }).click();
    await page.getByPlaceholder('Search emoji...').fill('rocket');
    await page.getByRole('button', { name: '🚀', exact: true }).first().click();
    await page.waitForTimeout(1800);
    const persisted = await readNote(auth.accessToken, note.id);
    const bodyPersisted = persisted.content.includes(`body-icon-${mode}`);
    const pass = mode === 'broken'
      ? !bodyPersisted && patches.length === 1 && patches[0]?.icon === '🚀'
      : bodyPersisted && patches.some(body => body.icon === '🚀') && patches.some(body => body.content);
    results.push({ scenario: 'body-icon', viewport, pass, patches, persistedContent: persisted.content, pageErrors });
    await page.screenshot({ path: path.join(outputDir, 'body-icon-1440.png'), fullPage: true });
  } finally {
    await context.close();
    await apiRequest(auth.accessToken, `/api/daily-notes/${note.id}`, { method: 'DELETE' });
  }
}

async function runImmediateBack(browser, auth, viewport, field) {
  if (mode === 'broken') return;
  const note = await createNote(auth.accessToken, `immediate-back-${field}-${viewport.width}`);
  const { context, page, pageErrors } = await openNote(browser, auth, note.id, viewport);
  const changedValue = `immediate-back-${field}-${viewport.width}`;
  try {
    if (field === 'content') await replaceBody(page, changedValue);
    else await page.getByPlaceholder('Untitled').fill(changedValue);
    await page.getByRole('button', { name: 'Back to all notes' }).click();
    await page.waitForURL(url => !url.searchParams.has('id'), { timeout: 15_000 });
    const persisted = await readNote(auth.accessToken, note.id);
    const pass = field === 'content'
      ? persisted.content.includes(changedValue)
      : persisted.title === changedValue;
    results.push({
      scenario: `immediate-back-${field}`, viewport, pass,
      persistedContent: persisted.content, persistedTitle: persisted.title, pageErrors,
    });
    await page.screenshot({ path: path.join(outputDir, `immediate-back-${field}-${viewport.width}.png`), fullPage: true });
  } finally {
    await context.close();
    await apiRequest(auth.accessToken, `/api/daily-notes/${note.id}`, { method: 'DELETE' });
  }
}

async function runDelayedInFlightBack(browser, auth, viewport, outcome) {
  if (mode === 'broken') return;
  const note = await createNote(auth.accessToken, `delayed-back-${outcome}-${viewport.width}`);
  const { context, page, pageErrors } = await openNote(browser, auth, note.id, viewport);
  const changedValue = `delayed-back-${outcome}-${viewport.width}`;
  let releasePatch;
  const patchStarted = new Promise(resolve => { releasePatch = resolve; });
  await page.route(`**/api/daily-notes/${note.id}`, async route => {
    const request = route.request();
    if (request.method() !== 'PATCH' || !request.postDataJSON()?.content) return route.continue();
    releasePatch();
    await new Promise(resolve => setTimeout(resolve, 800));
    if (outcome === 'failure') {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': webUrl },
        body: JSON.stringify({ error: 'Injected delayed save failure' }),
      });
    }
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), 'Access-Control-Allow-Origin': webUrl } });
  });
  try {
    await replaceBody(page, changedValue);
    await patchStarted;
    await page.getByRole('button', { name: 'Back to all notes' }).click();
    await page.waitForTimeout(150);
    const retainedWhilePending = new URL(page.url()).searchParams.get('id') === note.id;
    if (outcome === 'success') {
      await page.waitForURL(url => !url.searchParams.has('id'), { timeout: 15_000 });
    } else {
      await page.getByText('Not saved — edit to retry', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    }
    const persisted = await readNote(auth.accessToken, note.id);
    const retainedAfterFailure = new URL(page.url()).searchParams.get('id') === note.id;
    const pass = retainedWhilePending && (outcome === 'success'
      ? persisted.content.includes(changedValue)
      : retainedAfterFailure && !persisted.content.includes(changedValue));
    results.push({
      scenario: `delayed-in-flight-back-${outcome}`, viewport, pass,
      retainedWhilePending, retainedAfterFailure, persistedContent: persisted.content, pageErrors,
    });
    await page.screenshot({ path: path.join(outputDir, `delayed-in-flight-back-${outcome}-${viewport.width}.png`), fullPage: true });
  } finally {
    await context.close();
    await apiRequest(auth.accessToken, `/api/daily-notes/${note.id}`, { method: 'DELETE' });
  }
}

async function runNoteSwitchIsolation(browser, auth) {
  if (mode === 'broken') return;
  const viewport = { width: 1440, height: 900 };
  const first = await createNote(auth.accessToken, 'switch-first');
  const second = await createNote(auth.accessToken, 'switch-second');
  const { context, page, pageErrors } = await openNote(browser, auth, first.id, viewport);
  const changedValue = 'first-note-switch-pending-body';
  try {
    await replaceBody(page, changedValue);
    await page.getByRole('button', { name: 'Back to all notes' }).click();
    await page.waitForURL(url => !url.searchParams.has('id'), { timeout: 15_000 });
    await page.getByRole('button', { name: new RegExp(`^${second.title}`) }).click();
    await page.waitForURL(url => url.searchParams.get('id') === second.id, { timeout: 15_000 });
    await page.locator('.ProseMirror').waitFor({ state: 'visible', timeout: 15_000 });
    const editorText = await page.locator('.ProseMirror').innerText();
    const [persistedFirst, persistedSecond] = await Promise.all([
      readNote(auth.accessToken, first.id),
      readNote(auth.accessToken, second.id),
    ]);
    const pass = persistedFirst.content.includes(changedValue)
      && persistedSecond.content.includes('server-original')
      && editorText.includes('server-original')
      && !editorText.includes(changedValue);
    results.push({
      scenario: 'note-switch-isolation', viewport, pass, editorText,
      firstContent: persistedFirst.content, secondContent: persistedSecond.content, pageErrors,
    });
    await page.screenshot({ path: path.join(outputDir, 'note-switch-isolation-1440.png'), fullPage: true });
  } finally {
    await context.close();
    await Promise.all([
      apiRequest(auth.accessToken, `/api/daily-notes/${first.id}`, { method: 'DELETE' }),
      apiRequest(auth.accessToken, `/api/daily-notes/${second.id}`, { method: 'DELETE' }),
    ]);
  }
}

async function runFailedSave(browser, auth, viewport) {
  const note = await createNote(auth.accessToken, `failure-${mode}-${viewport.width}`);
  const { context, page, pageErrors } = await openNote(browser, auth, note.id, viewport);
  let rejected = 0;
  await page.route(`**/api/daily-notes/${note.id}`, async route => {
    const request = route.request();
    if (request.method() === 'PATCH' && request.postDataJSON()?.content) {
      rejected += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) });
    }
    return route.continue();
  });
  try {
    await replaceBody(page, `failed-body-${mode}-${viewport.width}`);
    await page.waitForTimeout(1200);
    const persisted = await readNote(auth.accessToken, note.id);
    const savedVisible = await anyVisible(page.getByText('Saved', { exact: true }));
    const errorVisible = await anyVisible(page.getByText('Not saved — edit to retry', { exact: true }));
    const pass = mode === 'broken'
      ? rejected === 1 && savedVisible && !errorVisible && !persisted.content.includes('failed-body')
      : rejected === 1 && !savedVisible && errorVisible && !persisted.content.includes('failed-body');
    results.push({ scenario: 'http-500', viewport, pass, rejected, savedVisible, errorVisible, persistedContent: persisted.content, pageErrors });
    await page.screenshot({ path: path.join(outputDir, `http-500-${viewport.width}.png`), fullPage: true });
  } finally {
    await context.close();
    await apiRequest(auth.accessToken, `/api/daily-notes/${note.id}`, { method: 'DELETE' });
  }
}

async function runProtectedImage(browser, auth, outsiderAuth, viewport) {
  if (mode === 'broken') return;
  const note = await createNote(auth.accessToken, `image-${viewport.width}`);
  const { context, page, pageErrors } = await openNote(browser, auth, note.id, viewport);
  const fileRequests = [];
  page.on('request', request => {
    if (request.url().includes('/api/files/')) {
      fileRequests.push({
        url: request.url(),
        hasBearerAuthorization: request.headers().authorization?.startsWith('Bearer ') === true,
      });
    }
  });
  try {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Insert image' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'deft-icon.png',
      mimeType: 'image/png',
      buffer: await fs.readFile(path.resolve('apps/web/public/brand/deft-icon.png')),
    });
    await page.locator('.deft-protected-note-image img[src^="blob:"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(1200);
    const persisted = await readNote(auth.accessToken, note.id);
    const match = persisted.content.match(/data-file-id="([^"]+)"/);
    const fileId = match?.[1];
    if (!fileId) throw new Error(`Persisted note did not contain a file id: ${persisted.content}`);
    const ownerResponse = await apiRequest(auth.accessToken, `/api/files/${fileId}`);
    const outsiderResponse = await apiRequest(outsiderAuth.accessToken, `/api/files/${fileId}`);
    const anonymousResponse = await fetch(`${apiUrl}/api/files/${fileId}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.deft-protected-note-image img[src^="blob:"]').waitFor({ state: 'visible', timeout: 15_000 });
    const serializedSafe = !persisted.content.includes('Bearer')
      && !persisted.content.includes('blob:')
      && !persisted.content.includes('/api/files/');
    const pass = serializedSafe
      && ownerResponse.status === 200
      && outsiderResponse.status === 404
      && anonymousResponse.status === 401
      && fileRequests.length >= 2
      && fileRequests.every(request => request.hasBearerAuthorization);
    results.push({
      scenario: 'protected-image-upload-reload', viewport, pass, fileId,
      persistedContent: persisted.content, serializedSafe,
      ownerStatus: ownerResponse.status, outsiderStatus: outsiderResponse.status,
      anonymousStatus: anonymousResponse.status, fileRequests, pageErrors,
    });
    await page.screenshot({ path: path.join(outputDir, `protected-image-${viewport.width}.png`), fullPage: true });
  } finally {
    await context.close();
    await apiRequest(auth.accessToken, `/api/daily-notes/${note.id}`, { method: 'DELETE' });
  }
}

await fs.mkdir(outputDir, { recursive: true });
const [auth, outsiderAuth] = await Promise.all([login(ownerEmail), login(outsiderEmail)]);
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    if (!delayedOnly) {
      await runBodyTitle(browser, auth, viewport);
      await runFailedSave(browser, auth, viewport);
      await runProtectedImage(browser, auth, outsiderAuth, viewport);
      await runImmediateBack(browser, auth, viewport, 'content');
      await runImmediateBack(browser, auth, viewport, 'title');
    }
    await runDelayedInFlightBack(browser, auth, viewport, 'success');
    await runDelayedInFlightBack(browser, auth, viewport, 'failure');
  }
  if (!delayedOnly) {
    await runBodyIcon(browser, auth);
    await runNoteSwitchIsolation(browser, auth);
  }
} finally {
  await browser.close();
}

const report = { mode, webUrl, apiUrl, timestamp: new Date().toISOString(), results };
await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.every(result => result.pass) ? 0 : 1;
