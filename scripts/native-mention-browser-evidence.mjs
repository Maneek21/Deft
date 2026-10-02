import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const fixturePath = process.env.DEFT_MENTION_FIXTURE_PATH;
const output = process.env.DEFT_MENTION_EVIDENCE_DIR;
if (!fixturePath || !output) throw new Error('Synthetic fixture and evidence paths are required');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const base = process.env.DEFT_WEB_URL ?? 'http://localhost:4010';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 },
  recordVideo: { dir: path.join(output, 'videos'), size: { width: 1440, height: 960 } } });
const page = await context.newPage();
const errors = [];
const results = [];
const extraContexts = [];
let socketConnected = false;
page.on('websocket', socket => {
  if (!socket.url().startsWith('ws://localhost:4011/socket.io/')) return;
  socket.on('framereceived', frame => {
    if (typeof frame.payload === 'string' && frame.payload.startsWith('40')) socketConnected = true;
  });
});
const shot = async name => { await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true }); results.push(name); };
const choose = async (editor, query, label) => {
  await editor.pressSequentially('@' + query, { delay: 90 });
  const menu = page.getByRole('listbox', { name: 'Mention people, agents, tasks or wikis' });
  await menu.waitFor({ state: 'visible', timeout: 15_000 });
  await menu.getByRole('option').filter({ hasText: label }).first().click();
  await page.waitForTimeout(300);
};
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.text().includes('flushSync was called from inside a lifecycle')) errors.push(message.text());
});
page.on('response', async response => {
  if (response.status() >= 500) errors.push(response.status() + ' ' + response.url());
  if (response.status() >= 400) console.log('HTTP', response.status(), response.url().split('?')[0], (await response.text()).slice(0, 220));
});
try {
  await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').fill(fixture.ownerEmail);
  await page.locator('#login-password').fill(fixture.password);
  await page.getByRole('button', { name: /Sign [Ii]n/ }).click();
  await page.waitForURL(url => !url.pathname.includes('login'));
  await page.goto(base + '/chat?space=' + fixture.publicSpaceId, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  assert(socketConnected, 'The browser establishes the live workspace socket connection');
  console.log('URL', page.url());
  console.log((await page.locator('body').innerText()).slice(-4500));
  console.log('Editors', await page.locator('[contenteditable=true]').count());
  const editor = page.locator('[contenteditable=true]').first();
  await editor.fill('Please review ');
  await editor.pressSequentially('@', { delay: 90 });
  await page.getByRole('listbox', { name: 'Mention people, agents, tasks or wikis' }).waitFor();
  await page.waitForTimeout(700);
  assert(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
    'Mention popup does not extend the document below the chat viewport');
  const desktopMenuBounds = await page.getByRole('listbox').boundingBox();
  assert(desktopMenuBounds && desktopMenuBounds.y >= 0 && desktopMenuBounds.y + desktopMenuBounds.height <= 960,
    'The complete desktop picker fits inside the viewport');
  await shot('01-universal-picker-desktop');
  await editor.press('ArrowDown');
  await editor.press('Enter');
  await editor.getByRole('button', { name: '@Sam', exact: true }).waitFor();
  await editor.pressSequentially(' review ', { delay: 50 });
  await choose(editor, 'DEFT', 'DEFT-42');
  await editor.pressSequentially(' using ', { delay: 50 });
  await choose(editor, 'Launch', 'Launch checklist');
  await editor.pressSequentially(' with ');
  await choose(editor, 'Avery', 'Avery Review');
  await shot('02-chat-composer');
  await editor.press('Enter');
  await page.waitForTimeout(2200);
  await page.locator('span[data-deft-ref-id="' + fixture.taskId + '"]').first().waitFor();
  await shot('03-chat-published');
  console.log('Chat body', (await page.locator('body').innerText()).slice(-2200));
  await page.locator('span[data-deft-ref-id="' + fixture.taskId + '"]').last().hover();
  await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await page.waitForTimeout(500);
  const thread = page.locator('[contenteditable=true]').last();
  await thread.fill('Thread review by ');
  await choose(thread, 'Sam', /^Sam$/);
  await thread.pressSequentially(' using ');
  await choose(thread, 'Launch', 'Launch checklist');
  await thread.pressSequentially(' for ');
  await choose(thread, 'DEFT', 'DEFT-42');
  await thread.pressSequentially(' with ');
  await choose(thread, 'Avery', 'Avery Review');
  await thread.press('Enter');
  await page.waitForTimeout(1800);
  await page.locator('span[data-deft-ref-id="' + fixture.wikiId + '"]').last().getByRole('link').waitFor();
  await shot('04-thread-reply');

  await page.goto(base + '/tasks?task=' + fixture.taskId, { waitUntil: 'domcontentloaded' });
  await page.locator('[contenteditable=true]').first().waitFor();
  await page.waitForTimeout(700);
  const description = page.locator('[contenteditable=true]').first();
  await description.fill('Release review by ');
  await choose(description, 'Rita', 'Rita Research');
  await description.pressSequentially(' and ');
  await choose(description, 'Sam', /^Sam$/);
  await description.pressSequentially(' using ');
  await choose(description, 'Launch', 'Launch checklist');
  await description.pressSequentially(' for ');
  await choose(description, 'DEFT', 'DEFT-42');
  // A route change inside the debounce must preserve the edit without notifying.
  const descriptionSaved = page.waitForResponse(response => response.request().method() === 'PATCH'
    && response.url().endsWith('/api/tasks/' + fixture.taskId));
  await page.getByRole('button', { name: 'Close task', exact: true }).click();
  assert((await descriptionSaved).ok(), 'Closing the task flushes its pending description save');
  await page.locator('a[href="/chat"]').first().click();
  await page.waitForURL(url => url.pathname === '/chat');
  await page.locator('[contenteditable=true]').first().waitFor();
  await page.goto(base + '/tasks?task=' + fixture.taskId);
  await page.locator('[contenteditable=true]').first().getByRole('button', { name: '@Rita Research', exact: true }).waitFor();
  await shot('05-task-description');
  await page.getByRole('button', { name: 'Notify mentions', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /notification\(s\) queued|Mentions are up to date/ }).waitFor();
  await shot('06-task-description-published');
  await page.getByRole('button', { name: 'Notify mentions', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Mentions are up to date' }).waitFor();
  await page.getByRole('button', { name: /References/ }).click();
  await page.getByText(/Mentioned in ·/).waitFor();
  await shot('07-task-backlinks');
  await page.getByRole('button', { name: /^Comments/ }).click();
  const comment = page.locator('[contenteditable=true]').first();
  await comment.fill('Comment review by ');
  await choose(comment, 'Sam', /^Sam$/);
  await comment.pressSequentially(' using ');
  await choose(comment, 'Launch', 'Launch checklist');
  await comment.pressSequentially(' for ');
  await choose(comment, 'DEFT', 'DEFT-42');
  await comment.pressSequentially(' with ');
  await choose(comment, 'Rita', 'Rita Research');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.waitForTimeout(1400);
  await shot('08-task-comment');

  await page.goto(base + '/knowledge?slug=' + fixture.wikiSlug, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Edit', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const wiki = page.locator('textarea');
  await wiki.fill('Launch checklist: review by ');
  await choose(wiki, 'Sam', /^Sam$/);
  await wiki.pressSequentially(' for ');
  await choose(wiki, 'DEFT', 'DEFT-42');
  await wiki.pressSequentially(' with ');
  await choose(wiki, 'Rita', 'Rita Research');
  await wiki.pressSequentially(' using ');
  await choose(wiki, 'Launch', 'Launch checklist');
  await shot('09-wiki-markdown-editor');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Notify mentions', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Notify mentions', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /notification\(s\) queued|Mentions are up to date/ }).waitFor();
  await page.getByRole('link', { name: /@DEFT-42 · Review release/ }).waitFor();
  await shot('10-wiki-published-and-backlinks');

  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/chat');
  await page.locator('[contenteditable=true]').waitFor();
  await shot('11-agent-explicit-request-composer');

  const recipient = await browser.newContext({ viewport: { width: 1440, height: 960 },
    recordVideo: { dir: path.join(output, 'videos'), size: { width: 1440, height: 960 } } });
  extraContexts.push(recipient);
  const recipientPage = await recipient.newPage();
  await recipientPage.goto(base + '/login');
  await recipientPage.locator('#login-email').fill(fixture.samEmail);
  await recipientPage.locator('#login-password').fill(fixture.password);
  await recipientPage.getByRole('button', { name: /Sign [Ii]n/ }).click();
  await recipientPage.waitForURL(url => !url.pathname.includes('login'));
  await recipientPage.goto(base + '/inbox');
  await recipientPage.getByText('Jordan mentioned you in task', { exact: true }).first().waitFor();
  await recipientPage.screenshot({ path: path.join(output, '12-recipient-inbox.png'), fullPage: true });
  results.push('12-recipient-inbox');
  await recipientPage.getByText('Jordan mentioned you in task', { exact: true }).first().click();
  await recipientPage.waitForURL(url => url.pathname === '/tasks' && url.searchParams.get('task') === fixture.taskId);
  await recipientPage.locator('[contenteditable]').first().waitFor();
  await recipientPage.screenshot({ path: path.join(output, '13-notification-exact-task.png'), fullPage: true });
  results.push('13-notification-exact-task');
  const recipientVideo = recipientPage.video();
  await recipient.close();
  if (recipientVideo) await recipientVideo.saveAs(path.join(output, 'recipient-native-mentions.webm'));

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    storageState: await context.storageState(), recordVideo: { dir: path.join(output, 'videos'), size: { width: 390, height: 844 } } });
  // The application session lives in localStorage, which storageState transfers.
  extraContexts.push(mobile);
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(base + '/chat?space=' + fixture.publicSpaceId);
  const mobileEditor = mobilePage.locator('[contenteditable=true]').first();
  await mobileEditor.waitFor();
  await mobileEditor.fill('Mobile review ');
  await mobileEditor.pressSequentially('@Sam', { delay: 100 });
  const mobileMenu = mobilePage.getByRole('listbox', { name: 'Mention people, agents, tasks or wikis' });
  await mobileMenu.getByRole('option').filter({ hasText: /^Sam$/ }).waitFor();
  const bounds = await mobileMenu.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'Picker fits the mobile viewport');
  await mobilePage.screenshot({ path: path.join(output, '14-mobile-picker.png'), fullPage: true });
  results.push('14-mobile-picker');
  await mobileMenu.getByRole('option').filter({ hasText: /^Sam$/ }).tap();
  await mobilePage.screenshot({ path: path.join(output, '15-mobile-reference.png'), fullPage: true });
  results.push('15-mobile-reference');
  await mobilePage.goto(base + '/knowledge?slug=' + fixture.wikiSlug);
  await mobilePage.getByRole('link', { name: /@DEFT-42 · Review release/ }).waitFor();
  await mobilePage.waitForTimeout(1000);
  await mobilePage.screenshot({ path: path.join(output, '16-mobile-wiki.png'), fullPage: true });
  results.push('16-mobile-wiki');
  const mobileVideo = mobilePage.video();
  await mobile.close();
  if (mobileVideo) await mobileVideo.saveAs(path.join(output, 'mobile-native-mentions.webm'));
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(path.join(output, 'initial-errors.json'), JSON.stringify(errors, null, 2));
} catch (error) {
  console.error(error);
  await shot('failure');
  console.log((await page.locator('body').innerText()).slice(-3500));
  throw error;
} finally {
  const video = page.video();
  await context.close();
  for (const extra of extraContexts) await extra.close();
  if (video) await video.saveAs(path.join(output, 'desktop-native-mentions.webm'));
  await browser.close();
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ results, errors, socketConnected }, null, 2));
}
