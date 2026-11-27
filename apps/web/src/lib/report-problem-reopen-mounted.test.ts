import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// "Report a problem" (telemetry contract, section 2): every time the dialog
// opens, "Email me about this report" is unticked again, so one report's
// choice never carries over to the next. The real dialog stays mounted in
// Chromium while its `open` prop is toggled, so this exercises the reset when
// it opens; the API is answered by page.route.
const web = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const ORIGIN = 'http://127.0.0.1';
const REFERENCE = 'D3F7620A';

let bundle: string | undefined;

async function mount(t: TestContext) {
  if (bundle === undefined) {
    const result = await build({
      stdin: {
        contents: `import { createElement, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ReportProblemDialog } from ${JSON.stringify(path.join(web, 'src/components/report-problem-dialog.tsx'))};
function Harness() {
  const [open, setOpen] = useState(false);
  return createElement('div', null,
    createElement('button', { onClick: () => flushSync(() => setOpen(true)) }, 'Open report'),
    createElement(ReportProblemDialog, { open, onClose: () => flushSync(() => setOpen(false)) }));
}
flushSync(() => createRoot(document.getElementById('root')).render(createElement(Harness)));`,
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
    bundle = result.outputFiles[0].text as string;
  }
  const browser = await chromium.launch({ headless: true, ...(process.env.DEFT_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.DEFT_TEST_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const tab = await browser.newPage();
  tab.setDefaultTimeout(6000);
  const sent: unknown[] = [];
  await tab.route('**/*', (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/report-test') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/support/report') {
      sent.push(JSON.parse(route.request().postData() ?? 'null'));
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ reference: REFERENCE }) });
    }
    return route.abort();
  });
  await tab.goto(`${ORIGIN}/report-test`);
  await tab.addScriptTag({ content: bundle });
  const open = async () => {
    await tab.getByRole('button', { name: 'Open report', exact: true }).click();
    await tab.getByRole('dialog', { name: 'Report a problem', exact: true }).waitFor();
  };
  await open();
  const checkbox = tab.getByRole('checkbox', { name: 'Email me about this report', exact: true });
  // The dialog unticks the box in an effect that React runs after the first
  // frame is painted, so a read straight after opening can still see the last
  // tick. Wait for the unticked box instead of reading it once.
  const unticked = tab.getByRole('checkbox', { name: 'Email me about this report', exact: true, checked: false });
  return { tab, checkbox, unticked, sent, open };
}

test('closing and reopening the dialog unticks a box the person had ticked', async (t) => {
  const { tab, checkbox, unticked, sent, open } = await mount(t);
  await assert.doesNotReject(unticked.waitFor(), 'the box starts unticked');
  await checkbox.check();
  await tab.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tab.getByRole('dialog').waitFor({ state: 'detached' });
  await open();
  await assert.doesNotReject(unticked.waitFor(), 'reopening must untick the box');
  assert.equal(sent.length, 0, 'closing and reopening sends nothing');
});

test('after a report sent with the box ticked, the next report starts unticked', async (t) => {
  const { tab, checkbox, unticked, sent, open } = await mount(t);
  await checkbox.check();
  await tab.getByLabel('What happened?').fill('The calendar opens on the wrong week.');
  await tab.getByRole('button', { name: 'Send report', exact: true }).click();
  await tab.getByText(REFERENCE, { exact: true }).waitFor();
  assert.equal((sent[0] as { email_me: boolean }).email_me, true);
  await tab.getByRole('button', { name: 'Done', exact: true }).click();
  await tab.getByRole('dialog').waitFor({ state: 'detached' });
  await open();
  await assert.doesNotReject(unticked.waitFor(), 'the next report must not inherit the last choice');
});
