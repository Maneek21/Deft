#!/usr/bin/env tsx
/**
 * Headed Playwright walkthrough of the Block 1 + Block 2 surfaces.
 *
 * Opens a real Chrome window (headless: false, slowMo so the user can
 * watch) and navigates through:
 *   - Library → ClawHub tab (Block 1.5)
 *   - Personality editor (Block 1.2)
 *   - HEARTBEAT.md structured builder (Block 2.9)
 *   - Dashboard → Agent Activity card (Block 2.8)
 *
 * Leaves the browser open for ~30 seconds at the end so the user can
 * poke around. Kill with Ctrl-C.
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: (j.access_token ?? j.accessToken) as string,
    refreshToken: (j.refresh_token ?? j.refreshToken) as string | undefined,
  };
}

async function pause(page: Page, ms: number, label: string) {
  console.log(`→ ${label} (waiting ${ms}ms)`);
  await page.waitForTimeout(ms);
}

async function main() {
  console.log('Logging in…');
  const auth = await login();

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: auth.accessToken, rt: auth.refreshToken ?? null },
  );
  const page = await ctx.newPage();

  // 1 — Dashboard
  console.log('\n[1/5] Dashboard → Agent Activity card (Block 2.8)');
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await pause(page, 2000, 'viewing dashboard');
  // Scroll to the Agent Activity card if not in view
  const agentCard = page.getByText('Agent Activity').first();
  if (await agentCard.count() > 0) {
    await agentCard.scrollIntoViewIfNeeded();
    await pause(page, 1500, 'Agent Activity card in view');
  }

  // 2 — Library → ClawHub tab
  console.log('\n[2/5] Library → ClawHub tab (Block 1.5)');
  await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await pause(page, 1500, 'library loaded');
  const clawhubBtn = page.getByRole('button', { name: /^clawhub$/i });
  if (await clawhubBtn.count() > 0) {
    await clawhubBtn.click();
    await pause(page, 2000, 'ClawHub tab active');
  }

  // 3 — Personality editor
  console.log('\n[3/5] Personality editor (Block 1.2)');
  const empsRes = await fetch(`${API_URL}/api/agent-employees`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  const empsBody = (await empsRes.json()) as Array<{ id: string; kind: string; name: string }>;
  const openclaw = Array.isArray(empsBody) ? empsBody.find((e) => e.kind === 'openclaw') : undefined;

  if (openclaw) {
    await page.goto(`${WEB_URL}/settings/agent-employees/${openclaw.id}/personality`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await pause(page, 2000, `personality editor for "${openclaw.name}"`);

    // 4 — Click SOUL.md (plain textarea)
    console.log('\n[4/5] SOUL.md — plain textarea (Block 1.2)');
    const soul = page.getByRole('button', { name: /SOUL\.md/i }).first();
    if (await soul.count() > 0) {
      await soul.click();
      await pause(page, 1800, 'SOUL.md selected — plain textarea');
    }

    // 5 — Click HEARTBEAT.md (structured builder)
    console.log('\n[5/5] HEARTBEAT.md — structured builder (Block 2.9)');
    const hb = page.getByRole('button', { name: /HEARTBEAT\.md/i }).first();
    if (await hb.count() > 0) {
      await hb.click();
      await pause(page, 1500, 'HEARTBEAT.md selected');
      // Add a row
      const addCheck = page.getByRole('button', { name: /add check/i });
      if (await addCheck.count() > 0) {
        await addCheck.click();
        await pause(page, 1000, 'row added');
        // Fill the instruction
        const instructionInput = page.locator('input[type="text"]').last();
        if (await instructionInput.count() > 0) {
          await instructionInput.fill('Check overdue tasks and summarize');
        }
        await pause(page, 1500, 'instruction filled');
        // Expand raw markdown
        const rawToggle = page.getByText(/raw markdown/i).first();
        if (await rawToggle.count() > 0) {
          await rawToggle.click();
          await pause(page, 2000, 'raw markdown expanded');
        }
      }
    }
  } else {
    console.log('No openclaw employee in this org — skipping personality + heartbeat views.');
  }

  console.log('\nWalkthrough complete. Leaving browser open for 30s. Ctrl-C to exit sooner.');
  await pause(page, 30_000, 'interactive window');

  await browser.close();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
