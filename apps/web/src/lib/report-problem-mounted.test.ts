import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// "Report a problem" (telemetry contract, section 2), the real dialog in
// Chromium with the API answered by page.route: the note the person reads,
// "Email me about this report" unticked when the dialog opens (a report
// carries the person's email only when they tick it), what is sent
// (category, text, the box, the page path, recent error references) and the
// reference shown back. A refusal is shown, not swallowed.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');

const ORIGIN = 'http://127.0.0.1';
const NOTE = "What you write is sent to the Deft team with technical details (release, browser, recent request IDs). Don't include passwords or private content.";

async function mount(answer: { status: number; body: unknown }) {
  const dialog = path.join(web, 'src/components/report-problem-dialog.tsx');
  const bundle = await build({
    stdin: {
      contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReportProblemDialog } from ${JSON.stringify(dialog)};
import { setCurrentPageTemplate } from ${JSON.stringify(path.join(web, 'src/lib/error-telemetry.ts'))};
setCurrentPageTemplate('/tasks/:id');
createRoot(document.getElementById('root')).render(createElement(ReportProblemDialog, { open: true, onClose() {} }));`,
      resolveDir: web,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    banner: { js: 'var process = { env: {} };' },
    jsx: 'automatic',
    alias: { '@': path.join(web, 'src') },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(ORIGIN) },
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  const sent: unknown[] = [];
  const tab = await browser.newPage();
  tab.setDefaultTimeout(6000);
  await tab.route('**/*', (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/tasks/board') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/support/report') {
      sent.push(JSON.parse(route.request().postData() ?? 'null'));
      return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
    }
    return route.abort();
  });
  await tab.goto(`${ORIGIN}/tasks/board?view=list`);
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  await tab.getByRole('dialog').waitFor();
  return { browser, tab, sent };
}

test('the box starts unticked, and a report sent without ticking it asks for no email', async () => {
  const { browser, tab, sent } = await mount({ status: 201, body: { reference: '7A1E9C02' } });
  try {
    await tab.getByText(NOTE).waitFor();
    assert.equal(await tab.getByLabel('Email me about this report').isChecked(), false);
    await tab.getByLabel('What happened?').fill('The calendar shows the wrong week.');
    await tab.getByRole('button', { name: 'Send report' }).click();
    await tab.getByText('7A1E9C02').waitFor();
    assert.deepEqual(sent, [{
      category: 'bug', text: 'The calendar shows the wrong week.', email_me: false, page: '/tasks/:id', request_ids: [],
    }]);
    assert.equal(await tab.getByText('We will email you', { exact: false }).count(), 0);
  } finally {
    await browser.close();
  }
});

test('the person reads the note, ticks the box, and a sent report shows its reference', async () => {
  const { browser, tab, sent } = await mount({ status: 201, body: { reference: '3F2B1C4D' } });
  try {
    await tab.getByText(NOTE).waitFor();
    await tab.getByLabel('Email me about this report').check();
    await tab.getByLabel('Something is confusing').check();
    await tab.getByLabel('What happened?').fill('The board does not show my tasks.');
    await tab.getByRole('button', { name: 'Send report' }).click();
    await tab.getByText('3F2B1C4D').waitFor();
    assert.deepEqual(sent, [{
      category: 'confusing', text: 'The board does not show my tasks.', email_me: true, page: '/tasks/:id', request_ids: [],
    }]);
    await tab.getByText('We will email you at your account address', { exact: false }).waitFor();
  } finally {
    await browser.close();
  }
});

test('a report the server could not send is shown as not sent, with the text kept', async () => {
  const { browser, tab, sent } = await mount({ status: 503, body: { error: 'Your report could not be sent. Try again in a few minutes.', code: 'REPORT_NOT_SENT' } });
  try {
    await tab.getByLabel('Email me about this report').check();
    await tab.getByLabel('Email me about this report').uncheck();
    await tab.getByLabel('What happened?').fill('Search is empty.');
    await tab.getByRole('button', { name: 'Send report' }).click();
    await tab.getByRole('alert').getByText('Your report could not be sent', { exact: false }).waitFor();
    assert.equal(await tab.getByLabel('What happened?').inputValue(), 'Search is empty.');
    assert.equal((sent[0] as { email_me: boolean }).email_me, false);
  } finally {
    await browser.close();
  }
});
