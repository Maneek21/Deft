#!/usr/bin/env tsx
/**
 * Dogfood walkthrough — one long headed Chrome session walking 10
 * realistic user journeys end to end. Observes like a human, captures
 * friction. See dogfood-plan.md for journey list + severity scale.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const HEADLESS = process.env.DOGFOOD_HEADLESS === '1';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/dogfood';
const REPORT = 'docs/superpowers/audits/dogfood-findings.md';

type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'note';
type Finding = { journey: string; severity: Severity; area: string; issue: string; evidence?: string };
const findings: Finding[] = [];
let currentJourney = 'init';

function flag(severity: Severity, area: string, issue: string, evidence?: string) {
  findings.push({ journey: currentJourney, severity, area, issue, evidence });
  const sym = severity === 'blocker' ? '🛑' : severity === 'major' ? '⚠️' : severity === 'minor' ? '🟡' : severity === 'nit' ? '•' : 'ℹ';
  console.log(`   ${sym}  [${area}] ${issue}${evidence ? ' — ' + evidence : ''}`);
}

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  return {
    access_token: (j.access_token ?? j.accessToken) as string,
    refresh_token: (j.refresh_token ?? j.refreshToken) as string | undefined,
    org_id: (j.org_id ?? j.orgId) as string,
    user_id: (j.user as { id: string } | undefined)?.id ?? '',
  };
}

async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const txt = await res.text();
  let body: unknown = txt;
  try { body = JSON.parse(txt); } catch { /* text */ }
  return { status: res.status, body: body as T };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function step(label: string, ms = 900) {
  console.log(`   → ${label}`);
  await new Promise((r) => setTimeout(r, ms));
}

async function typeLikeHuman(page: Page, locator: ReturnType<Page['locator']>, text: string) {
  await locator.click();
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 30 + Math.floor(Math.random() * 40) });
  }
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  console.log('Logging in via API…');
  const auth = await login();

  const browser: Browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 180 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: auth.access_token, rt: auth.refresh_token ?? null },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(12_000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text().slice(0, 200)}`);
  });

  // Resolve a test employee
  const empsRes = await api<Array<{ id: string; kind: string; name: string; slug: string }>>(
    '/api/agent-employees', auth.access_token,
  );
  const emp = Array.isArray(empsRes.body)
    ? (empsRes.body.find((e) => e.kind === 'openclaw') ?? empsRes.body[0])
    : undefined;
  if (!emp) {
    console.warn('No employees in test org — most journeys will be skipped.');
  }

  try {
    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J1-morning-check-in';
    console.log(`\n🌅 ${currentJourney}`);
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('arrive at dashboard, look around', 1500);
    await shot(page, '01-j1-dashboard-initial');

    // What's visible above the fold?
    const todayCard = await page.getByText(/^Today$/).count();
    const quickStats = await page.getByText(/Quick Stats/i).count();
    const agentActivity = await page.getByText(/Agent Activity/i).count();
    if (todayCard === 0) flag('major', 'dashboard', '"Today" card not visible on default viewport');
    if (agentActivity === 0) flag('major', 'dashboard', '"Agent Activity" card not rendering');
    if (quickStats === 0) flag('minor', 'dashboard', 'Quick Stats card missing');

    // Scroll to Agent Activity
    const activityHeader = page.getByText('Agent Activity').first();
    if (await activityHeader.count() > 0) {
      await activityHeader.scrollIntoViewIfNeeded();
      await step('scroll to Agent Activity', 1200);
      await shot(page, '02-j1-agent-activity');
      const pendingBtns = await page.getByRole('button', { name: /^approve$/i }).count();
      if (pendingBtns === 0) flag('note', 'dashboard', 'No pending actions to exercise inline approve/reject');
    }

    // Empty-state check — is the "All caught up!" branch tested?
    const unreadAllCaught = await page.getByText(/all caught up/i).count();
    if (unreadAllCaught > 0) flag('note', 'dashboard', 'Unread empty-state "All caught up!" rendered');

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J2-tune-personality';
    console.log(`\n🎨 ${currentJourney}`);
    await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('landed on agent settings', 1200);
    await shot(page, '03-j2-agent-settings');

    if (emp) {
      const kebab = page.locator(`[data-testid="employee-menu-${emp.slug}"]`);
      if (await kebab.count() === 0) {
        flag('blocker', 'nav', 'Employee row kebab menu missing');
      } else {
        // Hit-target check — kebab bounding box ≥ 24×24?
        const box = await kebab.boundingBox();
        if (box && (box.width < 20 || box.height < 20)) {
          flag('minor', 'a11y', `Kebab hit target ${Math.round(box.width)}×${Math.round(box.height)} — smaller than recommended 24×24`);
        }
        await kebab.click();
        await step('opened kebab menu', 900);
        await shot(page, '04-j2-kebab-open');

        // Click Personality
        const personalityLink = page.getByRole('link', { name: /personality/i }).first();
        if (await personalityLink.count() === 0) {
          flag('blocker', 'nav', 'Personality link missing from kebab menu');
        } else {
          await personalityLink.click();
          await step('navigated to Personality', 1500);
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await shot(page, '05-j2-personality');

          // Soul file load
          const soulBtn = page.getByRole('button', { name: /SOUL\.md/i }).first();
          if (await soulBtn.count() > 0) {
            await soulBtn.click();
            await step('clicked SOUL.md', 1200);
            await shot(page, '06-j2-soul-selected');
            const editorTextarea = page.locator('textarea').first();
            if (await editorTextarea.count() === 0) {
              flag('major', '1.2 personality', 'SOUL.md selected but no textarea rendered');
            }

            // Save button should be disabled (gateway unreachable in dev)
            const saveBtn = page.getByRole('button', { name: /^save$/i });
            if (await saveBtn.count() > 0) {
              const isDisabled = await saveBtn.isDisabled();
              if (!isDisabled) {
                flag('major', '1.2 save', 'Save button enabled when gateway unreachable — should be disabled');
              }
              const title = await saveBtn.getAttribute('title');
              if (!title || !/offline|unreachable/i.test(title)) {
                flag('minor', '1.2 save', 'Save tooltip missing/unclear when disabled');
              }
            }

            // Back-nav behavior
            const backLink = page.getByText(/back to agents/i).first();
            if (await backLink.count() === 0) {
              flag('minor', 'nav', 'No back-to-agents link on Personality page');
            }
          }
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J3-heartbeat-builder';
    console.log(`\n💓 ${currentJourney}`);
    if (emp) {
      await page.goto(`${WEB_URL}/settings/agent-employees/${emp.id}/personality`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await step('reopened personality for heartbeat', 1000);
      const hb = page.getByRole('button', { name: /HEARTBEAT\.md/i }).first();
      if (await hb.count() > 0) {
        await hb.click();
        await step('opened HEARTBEAT.md', 1200);
        await shot(page, '07-j3-heartbeat-empty');

        const addBtn = page.getByRole('button', { name: /add check/i });
        if (await addBtn.count() === 0) {
          flag('major', '2.9 heartbeat', '"Add check" button missing on HEARTBEAT.md');
        } else {
          await addBtn.click();
          await step('added first check', 800);
          await addBtn.click();
          await step('added second check', 800);
          await shot(page, '08-j3-heartbeat-two-rows');

          // Fill both rows
          const instructionInputs = page.locator('input[type="text"]');
          const count = await instructionInputs.count();
          if (count >= 2) {
            await typeLikeHuman(page, instructionInputs.nth(count - 2), 'Check unread mentions');
            await step('filled row 1', 500);
            await typeLikeHuman(page, instructionInputs.nth(count - 1), 'Summarize overdue tasks');
            await step('filled row 2', 500);
            await shot(page, '09-j3-heartbeat-filled');
          }

          // Expand raw markdown to verify round-trip
          const rawToggle = page.getByText(/raw markdown/i).first();
          if (await rawToggle.count() > 0) {
            await rawToggle.click();
            await step('expanded raw markdown', 1000);
            await shot(page, '10-j3-heartbeat-raw');
            const rawTextarea = page.locator('details textarea');
            if (await rawTextarea.count() > 0) {
              const text = await rawTextarea.inputValue();
              if (!text.includes('every') || !text.includes('Check unread')) {
                flag('major', '2.9 heartbeat', 'Structured rows did not round-trip into raw markdown');
              }
            }
          } else {
            flag('minor', '2.9 heartbeat', 'No "Raw markdown" expander visible');
          }

          // Try deleting a row — is there a trash icon?
          const trashBtns = page.getByRole('button', { name: /remove check/i });
          const trashCount = await trashBtns.count();
          if (trashCount === 0) {
            flag('minor', '2.9 heartbeat', 'No visible way to remove a row');
          } else {
            await trashBtns.first().click();
            await step('removed first row', 600);
          }
        }
      } else {
        flag('major', '2.9 heartbeat', 'HEARTBEAT.md file button missing from list');
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J4-developer-creds';
    console.log(`\n🔑 ${currentJourney}`);
    if (emp) {
      await page.goto(`${WEB_URL}/settings/agent-employees/${emp.id}/developer`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await step('opened developer page', 1200);
      await shot(page, '11-j4-developer');

      // Reveal gated?
      const reveal = page.getByRole('button', { name: /^reveal$/i });
      if (await reveal.count() === 0) {
        flag('major', '3.2 developer', 'Reveal button missing');
      } else {
        await reveal.click();
        await step('clicked Reveal', 1500);
        await shot(page, '12-j4-developer-revealed');
        const hideBtn = page.getByRole('button', { name: /^hide$/i });
        if (await hideBtn.count() === 0) {
          flag('minor', '3.2 developer', 'After Reveal, no Hide button to re-mask — user can\'t undo exposure');
        }
      }

      // Docs links should open in new tab
      const openclawDoc = page.getByRole('link', { name: /openclaw gateway protocol/i });
      if (await openclawDoc.count() === 0) {
        flag('minor', '3.2 developer', 'OpenClaw docs link missing');
      } else {
        const target = await openclawDoc.getAttribute('target');
        if (target !== '_blank') flag('nit', '3.2 developer', 'Docs link missing target="_blank"');
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J5-webhook-wiring';
    console.log(`\n🪝 ${currentJourney}`);
    if (emp) {
      await page.goto(`${WEB_URL}/settings/agent-employees/${emp.id}/webhooks`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await step('opened webhooks page', 1200);
      await shot(page, '13-j5-webhooks-initial');

      // Empty state copy present?
      const emptyState = await page.getByText(/no webhooks yet/i).count();
      if (emptyState === 0) {
        flag('note', '3.3 webhooks', 'No empty-state copy on webhooks — user may have existing hooks already');
      }

      // Create one
      const labelInput = page.locator('input[placeholder*="Label"]');
      const createBtn = page.getByRole('button', { name: /create webhook/i });
      if (await labelInput.count() === 0 || await createBtn.count() === 0) {
        flag('major', '3.3 webhooks', 'Create form missing inputs/button');
      } else {
        await typeLikeHuman(page, labelInput.first(), 'Dogfood test webhook');
        await step('typed label', 600);
        await createBtn.click();
        await step('submitted', 1500);
        await shot(page, '14-j5-webhooks-created');

        // Secret banner visible?
        const secretBanner = await page.getByText(/save this secret now/i).count();
        if (secretBanner === 0) {
          flag('major', '3.3 webhooks', 'Create succeeded but no "save the secret" warning banner');
        }

        // Dismiss the banner
        const dismiss = page.getByRole('button', { name: /i've saved it/i });
        if (await dismiss.count() > 0) {
          await dismiss.click();
          await step('dismissed secret banner', 700);
        }

        // New row in Active webhooks?
        const hookRow = await page.getByText(/dogfood test webhook/i).count();
        if (hookRow === 0) {
          flag('minor', '3.3 webhooks', 'New webhook not appearing in Active list post-create');
        }

        // Revoke — but handle the confirm() dialog
        page.on('dialog', (dialog) => dialog.accept().catch(() => undefined));
        const revokeBtn = page.getByRole('button', { name: /revoke webhook/i }).first();
        if (await revokeBtn.count() > 0) {
          await revokeBtn.click();
          await step('revoked', 1200);
          await shot(page, '15-j5-webhooks-after-revoke');
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J6-clawhub-browse';
    console.log(`\n🛒 ${currentJourney}`);
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('arrived at Library', 1200);
    await shot(page, '16-j6-library-skills');

    const clawhubTab = page.getByRole('button', { name: /^clawhub$/i });
    if (await clawhubTab.count() === 0) {
      flag('blocker', '1.5 clawhub', 'ClawHub tab missing from Library');
    } else {
      await clawhubTab.click();
      await step('switched to ClawHub', 1000);
      await shot(page, '17-j6-clawhub-tab');

      const imports = page.getByRole('button', { name: /^import$/i });
      const importCount = await imports.count();
      if (importCount === 0) {
        flag('note', '1.5 clawhub', 'No importable entries in allowlist (cron not seeded?)');
      } else {
        await imports.first().click();
        await step('imported first skill', 1800);
        await shot(page, '18-j6-clawhub-imported');

        // Attach CTA
        const attachCta = page.getByRole('button', { name: /attach to an agent/i });
        if (await attachCta.count() === 0) {
          flag('major', '1.5 clawhub', 'Attach-to-agent CTA missing after import');
        } else {
          await attachCta.click();
          await step('clicked Attach CTA → should jump to Skills tab', 1000);
          const skillsTabActive = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const skillsBtn = btns.find((b) => b.textContent?.trim().toLowerCase() === 'skills');
            if (!skillsBtn) return null;
            return window.getComputedStyle(skillsBtn).borderBottomColor;
          });
          await shot(page, '19-j6-after-attach-click');
          if (!skillsTabActive) flag('minor', '1.5 clawhub', 'Could not verify Skills tab became active after CTA');
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J7-agent-conversation';
    console.log(`\n💬 ${currentJourney}`);
    // /chat is the workspace DM route — the agent chat lives at /agent
    await page.goto(`${WEB_URL}/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('opened chat page', 1500);
    await shot(page, '20-j7-chat-landing');

    const composer = page.locator('textarea').first();
    if (await composer.count() === 0) {
      flag('major', 'chat', 'Composer textarea not rendering');
    } else {
      await typeLikeHuman(page, composer, 'List my in-progress tasks');
      await step('typed a message', 800);
      // Find send button and submit
      const sendBtn = page.locator('button[aria-label*="send" i]').or(page.locator('button:has(svg)').last());
      // Try Enter instead for naturalness
      await page.keyboard.press('Enter');
      await step('sent message — waiting for agent reply', 4000);
      await shot(page, '21-j7-chat-sent');

      // Wait for an assistant message to appear or streaming indicator to finish
      await page.waitForFunction(() => {
        const body = document.body.innerText;
        return body.includes('in_progress') || body.includes('tasks') || body.includes('Defty');
      }, { timeout: 15_000 }).catch(() => undefined);
      await step('assistant responded (or timed out)', 2000);
      await shot(page, '22-j7-chat-reply');

      // Export trace button should now appear
      const exportBtn = page.getByRole('button', { name: /export trace/i });
      if (await exportBtn.count() === 0) {
        flag('minor', '3.8 trace export', 'Export trace button not visible after conversation started');
      } else {
        flag('note', '3.8 trace export', 'Export trace button visible');
      }

      // Show trace expander if tool_calls happened
      const showTrace = page.getByText(/show trace/i).first();
      if (await showTrace.count() === 0) {
        flag('note', '1.10 trace', 'No "Show trace" — reply may not have had tool calls');
      } else {
        await showTrace.click();
        await step('expanded trace', 1000);
        await shot(page, '23-j7-trace-open');
        const hideTrace = await page.getByText(/hide trace/i).count();
        if (hideTrace === 0) flag('nit', '1.10 trace', 'Expander doesn\'t show "Hide trace" label when open');
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J8-clone-and-template';
    console.log(`\n🧬 ${currentJourney}`);
    if (emp) {
      await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await step('back at agent settings', 1000);

      // Count existing rows
      const countBefore = await page.locator('[data-testid^="employee-row-"]').count();

      const kebab = page.locator(`[data-testid="employee-menu-${emp.slug}"]`);
      if (await kebab.count() > 0) {
        await kebab.click();
        await step('kebab open', 700);
        const cloneBtn = page.getByRole('button', { name: /clone agent/i });
        if (await cloneBtn.count() === 0) {
          flag('major', '3.1 clone', 'Clone button missing from kebab');
        } else {
          await cloneBtn.click();
          await step('clicked Clone — waiting for list refresh', 2500);
          const countAfter = await page.locator('[data-testid^="employee-row-"]').count();
          if (countAfter <= countBefore) {
            flag('minor', '3.1 clone', 'After clone, employee row count did not grow');
          }
          await shot(page, '24-j8-after-clone');
        }
      }

      // Save as template on the first row
      const kebab2 = page.locator(`[data-testid="employee-menu-${emp.slug}"]`);
      if (await kebab2.count() > 0) {
        await kebab2.click();
        await step('reopen kebab', 700);
        const saveTpl = page.getByRole('button', { name: /save as template/i });
        if (await saveTpl.count() === 0) {
          flag('major', '3.1 save-as-template', 'Save as template button missing');
        } else {
          await saveTpl.click();
          await step('opened save-as-template modal', 1200);
          await shot(page, '25-j8-template-modal');
          const cancelBtn = page.getByRole('button', { name: /cancel/i }).first();
          if (await cancelBtn.count() === 0) {
            flag('minor', '3.1 save-as-template', 'No Cancel button in modal');
          } else {
            await cancelBtn.click();
            await step('cancelled modal', 600);
          }
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J9-tablet-viewport';
    console.log(`\n📱 ${currentJourney}`);
    await page.setViewportSize({ width: 1024, height: 768 });
    await step('resized to 1024×768 (tablet landscape)', 900);
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('revisit dashboard at tablet width', 1500);
    await shot(page, '26-j9-tablet-landscape');

    // Check for horizontal overflow
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = 1024;
    if (bodyScrollWidth > viewportWidth + 10) {
      flag('minor', 'responsive', `Horizontal scroll at 1024px (body scrollWidth=${bodyScrollWidth})`);
    }

    await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('settings/agent at tablet width', 1200);
    await shot(page, '27-j9-tablet-settings');

    // Portrait
    await page.setViewportSize({ width: 768, height: 1024 });
    await step('resized to 768×1024 (tablet portrait)', 900);
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '28-j9-tablet-portrait');

    // Sidebar state
    const sidebar = page.locator('aside, nav').first();
    if (await sidebar.count() > 0) {
      const sbBox = await sidebar.boundingBox();
      if (sbBox && sbBox.width > 300) {
        flag('minor', 'responsive', `Sidebar still ${Math.round(sbBox.width)}px wide on 768px viewport — should collapse or narrow`);
      }
    }

    // Reset
    await page.setViewportSize({ width: 1440, height: 900 });
    await step('back to desktop', 600);

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'J10-keyboard-nav';
    console.log(`\n⌨️ ${currentJourney}`);
    await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await step('tab through sidebar', 600);

    // Tab into the page several times
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 80));
    }
    await shot(page, '29-j10-tab-20');

    // Where is focus now?
    const activeTag = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName}${a.getAttribute('data-testid') ? `[${a.getAttribute('data-testid')}]` : ''}` : 'NONE';
    });
    console.log(`   focus after 20 tabs: ${activeTag}`);
    if (activeTag === 'NONE' || activeTag === 'BODY') {
      flag('major', 'a11y', 'After 20 tabs, focus did not land on any interactive element — keyboard nav broken');
    }

    // Can we open a kebab with Enter?
    if (emp) {
      const kebab = page.locator(`[data-testid="employee-menu-${emp.slug}"]`);
      if (await kebab.count() > 0) {
        await kebab.focus();
        await step('focused first kebab', 500);
        await page.keyboard.press('Enter');
        await step('Enter on kebab', 700);
        const menuOpen = await page.getByRole('link', { name: /personality/i }).count();
        if (menuOpen === 0) {
          flag('minor', 'a11y', 'Enter on kebab does not open menu');
        }
        // ESC to close
        await page.keyboard.press('Escape');
        await step('ESC to close', 600);
        const menuStillOpen = await page.getByRole('link', { name: /personality/i }).count();
        if (menuStillOpen > 0) {
          flag('minor', 'a11y', 'ESC does not close kebab menu');
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    currentJourney = 'finalize';
    if (consoleErrors.length > 5) {
      flag('major', 'console', `${consoleErrors.length} JS console errors/page errors during walkthrough`, consoleErrors.slice(0, 4).join(' | '));
    } else if (consoleErrors.length > 0) {
      flag('minor', 'console', `${consoleErrors.length} JS console errors`, consoleErrors.slice(0, 3).join(' | '));
    }
  } finally {
    if (!HEADLESS) {
      console.log('\n⏸  Holding browser open for 20s so you can poke around. Ctrl-C to exit sooner.');
      await new Promise((r) => setTimeout(r, 20_000));
    }
    await browser.close();
  }

  // Report
  const bySev = (s: Severity) => findings.filter((f) => f.severity === s);
  const out: string[] = [
    '# Dogfood walkthrough findings',
    '',
    `Run: ${new Date().toISOString()}`,
    `Viewport: 1440×900 (desktop), 1024×768 (tablet-landscape), 768×1024 (tablet-portrait)`,
    `Env: ${WEB_URL}`,
    `Mode: ${HEADLESS ? 'headless' : 'headed with slow-mo'}`,
    '',
    '## Summary',
    '',
    '| Severity | Count |',
    '| --- | --- |',
    `| 🛑 Blocker | ${bySev('blocker').length} |`,
    `| ⚠️ Major   | ${bySev('major').length} |`,
    `| 🟡 Minor   | ${bySev('minor').length} |`,
    `| • Nit     | ${bySev('nit').length} |`,
    `| ℹ Note    | ${bySev('note').length} |`,
  ];
  for (const sev of ['blocker', 'major', 'minor', 'nit', 'note'] as Severity[]) {
    const items = bySev(sev);
    if (items.length === 0) continue;
    out.push(`\n## ${sev.charAt(0).toUpperCase()}${sev.slice(1)}${items.length > 1 ? 's' : ''}`);
    for (const f of items) {
      out.push(`\n- **[${f.journey} · ${f.area}]** ${f.issue}${f.evidence ? `\n  - _${f.evidence}_` : ''}`);
    }
  }
  writeFileSync(REPORT, out.join('\n') + '\n');
  console.log(`\n${findings.length} findings → ${REPORT}`);
  console.log(`screenshots → ${SHOT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(REPORT, `FATAL: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
