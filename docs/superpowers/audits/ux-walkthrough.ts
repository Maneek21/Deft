#!/usr/bin/env tsx
/**
 * Human-style UX walkthrough. Doesn't just assert "does the element
 * exist" — it walks the realistic user journey through the features
 * built across Blocks 0–3 and flags friction:
 *   - features that work via API but have no UI entrypoint
 *   - navigation dead-ends (can reach X but nothing points to X)
 *   - slow-loading states, unexpected errors, confusing copy
 *   - broken affordances (buttons that don't do anything visible)
 *
 * Writes a structured findings report to
 * docs/superpowers/audits/ux-walkthrough-findings.md that a human can
 * review and triage.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/ux-walkthrough';
const REPORT = 'docs/superpowers/audits/ux-walkthrough-findings.md';

type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'note';
type Finding = { severity: Severity; area: string; issue: string; evidence?: string };
const findings: Finding[] = [];
const log = (...args: unknown[]) => console.log(...args);

function flag(severity: Severity, area: string, issue: string, evidence?: string) {
  findings.push({ severity, area, issue, evidence });
  const symbol = severity === 'blocker' ? '🛑' : severity === 'major' ? '⚠️' : severity === 'minor' ? '🟡' : severity === 'nit' ? '•' : 'ℹ';
  console.log(`  ${symbol}  [${area}] ${issue}${evidence ? ' — ' + evidence : ''}`);
}

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  // API returns camelCase; earlier snake_case destructure silently wrote
  // "undefined" into localStorage and every API call 401'd — hence the
  // "features missing" false positives on the first walkthrough.
  return {
    access_token: (j.access_token ?? j.accessToken) as string,
    refresh_token: (j.refresh_token ?? j.refreshToken) as string | undefined,
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  const ms = Date.now() - start;
  return { value, ms };
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });
  const auth = await login();

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: auth.access_token, rt: auth.refresh_token ?? null },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(10_000);

  // Capture JS console errors as potential friction
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });

  try {
    // ───────────────────────────────────────────────────────────────
    // Journey 1 — "I want to tune my agent's personality."
    // ───────────────────────────────────────────────────────────────
    log('\n═══ J1 — Tune an agent\'s personality ═══');

    // Start at the agent settings page (the canonical entrypoint)
    const dashLoad = await timed('dashboard', async () => {
      await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
    });
    log(`  dashboard loaded in ${dashLoad.ms}ms`);
    if (dashLoad.ms > 3000) flag('minor', 'perf', `Dashboard slow to first paint (${dashLoad.ms}ms)`);
    await shot(page, '01-dashboard');

    // Try to get to /settings/agent. Is there a nav link? Match loosely.
    await page.waitForTimeout(600); // let sidebar hydrate
    const agentNavItem = await page.getByRole('link', { name: /^Agent/i }).count();
    if (agentNavItem === 0) {
      flag('major', 'nav', 'No "Agent" nav item in sidebar');
    }

    // Navigate directly to agent-employees list
    await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(500);
    await shot(page, '03-settings-agent');

    // Does each employee row expose a link to Personality / Developer?
    // If not, the user has to type the URL manually — big friction.
    const personalityLinks = await page.locator('a[href*="/personality"]').count();
    const developerLinks = await page.locator('a[href*="/developer"]').count();
    if (personalityLinks === 0) {
      flag('major', '1.2 personality', 'No link from the agent-employees list to the Personality editor — user has no way to discover it without knowing the URL.');
    }
    if (developerLinks === 0) {
      flag('major', '3.2 developer', 'No link from the agent-employees list to the Developer credentials page — user has no way to discover it without knowing the URL.');
    }

    // ───────────────────────────────────────────────────────────────
    // Journey 2 — visit personality editor directly (fall back to any
    // employee — the API route only restricts by kind inside handler,
    // so we exercise the UI regardless).
    // ───────────────────────────────────────────────────────────────
    log('\n═══ J2 — Personality editor directly ═══');
    const empsRes = await fetch(`${API_URL}/api/agent-employees`, {
      headers: { authorization: `Bearer ${auth.access_token}` },
    });
    const empsBody = (await empsRes.json()) as Array<{ id: string; kind: string; name: string; slug: string }>;
    const openclawEmp = Array.isArray(empsBody)
      ? (empsBody.find((e) => e.kind === 'openclaw') ?? empsBody[0])
      : undefined;
    if (!openclawEmp) {
      flag('note', '1.2 personality', 'No employees in test org; cannot walk through personality editor.');
    } else {
      const p = await timed('personality', async () => {
        await page.goto(`${WEB_URL}/settings/agent-employees/${openclawEmp.id}/personality`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => undefined);
      });
      log(`  personality page loaded in ${p.ms}ms`);
      if (p.ms > 3000) flag('minor', 'perf', `Personality page slow (${p.ms}ms)`);
      await shot(page, '04-personality');

      // Check the "Gateway unreachable" warning wording
      const gatewayWarning = await page.getByText(/gateway unreachable/i).count();
      const gatewayMessage = await page.getByText(/sidecar is offline/i).count();
      if (gatewayWarning > 0 && gatewayMessage > 0) {
        flag('note', '1.2 personality', 'Gateway-unreachable banner renders when no sidecar — correct behavior, but in a dev env with 0 provisioned gateways this is the default experience for every agent, which may be confusing.');
      }

      // Click HEARTBEAT.md → structured builder
      const hb = page.getByRole('button', { name: /HEARTBEAT\.md/i }).first();
      if (await hb.count() > 0) {
        await hb.click();
        await page.waitForTimeout(400);
        await shot(page, '05-heartbeat');
        // Click "Add check"
        const addBtn = page.getByRole('button', { name: /add check/i });
        if (await addBtn.count() > 0) {
          await addBtn.click();
          await page.waitForTimeout(300);
          // Type an instruction
          const instr = page.locator('input[type="text"]').last();
          if (await instr.count() > 0) {
            await instr.fill('Check overdue tasks');
            await page.waitForTimeout(200);
            await shot(page, '06-heartbeat-filled');
          }
          // Try to click Save — will it fail gracefully with no gateway?
          const save = page.getByRole('button', { name: /^save$/i });
          if (await save.count() > 0) {
            await save.click();
            await page.waitForTimeout(1500);
            await shot(page, '07-heartbeat-save-attempt');
            const errorText = await page.getByText(/gateway|offline|unreachable|error/i).count();
            if (errorText > 0) {
              flag('minor', '1.2 save', 'Save attempt surfaces "gateway unreachable" as an error banner — correct, but the Save button is not disabled upfront when gateway_unreachable=true, so the user clicks before seeing the warning.');
            }
          }
        } else {
          flag('blocker', '2.9 heartbeat', '"Add check" button missing on HEARTBEAT.md editor — structured builder not rendering.');
        }
      }

      // ───────────────────────────────────────────────────────────────
      // Journey 3 — Developer page
      // ───────────────────────────────────────────────────────────────
      log('\n═══ J3 — Developer credentials ═══');
      await page.goto(`${WEB_URL}/settings/agent-employees/${openclawEmp.id}/developer`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(600);
      await shot(page, '08-developer');

      // Click Reveal
      const reveal = page.getByRole('button', { name: /^reveal$/i });
      if (await reveal.count() > 0) {
        await reveal.click();
        await page.waitForTimeout(800);
        await shot(page, '09-developer-revealed');
      }

      // Try the copy button on wscat — tricky: clipboard API may not work headless
      const copyButtons = await page.locator('button[aria-label="Copy"]').count();
      if (copyButtons === 0) {
        flag('minor', '3.2 developer', 'No standalone Copy buttons on example frames.');
      }

      // Is there any guidance on "what do I do with these credentials"?
      const guidance = await page.getByText(/learn more|docs|guide|getting started/i).count();
      if (guidance === 0) {
        flag('minor', '3.2 developer', 'No link to documentation or a getting-started guide — raw credentials but no path for a new developer to learn what to do with them.');
      }
    }

    // ───────────────────────────────────────────────────────────────
    // Journey 4 — Library → ClawHub → Import
    // ───────────────────────────────────────────────────────────────
    log('\n═══ J4 — Library → ClawHub → Import a skill ═══');
    const libLoad = await timed('library', async () => {
      try {
        await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        console.warn('  library nav errored, retrying:', (err as Error).message);
        await page.waitForTimeout(500);
        await page.goto(`${WEB_URL}/library`, { waitUntil: 'load' }).catch(() => undefined);
      }
      await page.waitForLoadState('networkidle').catch(() => undefined);
    });
    log(`  library loaded in ${libLoad.ms}ms`);
    if (libLoad.ms > 3000) flag('minor', 'perf', `Library slow (${libLoad.ms}ms)`);
    await shot(page, '10-library');

    // Click ClawHub tab
    const clawhubTab = page.getByRole('button', { name: /^clawhub$/i });
    if (await clawhubTab.count() > 0) {
      await clawhubTab.click();
      await page.waitForTimeout(1000);
      await shot(page, '11-library-clawhub');

      // Click first Import button
      const importBtns = page.getByRole('button', { name: /^import$/i });
      const importCount = await importBtns.count();
      log(`  ${importCount} Import buttons on ClawHub tab`);
      if (importCount > 0) {
        await importBtns.first().click();
        await page.waitForTimeout(1500);
        await shot(page, '12-library-imported');

        // Is there any indication of success? A toast, banner, or row state change?
        const success = await page.getByText(/imported|attached|added|installed/i).count();
        if (success === 0) {
          flag('minor', '1.5 clawhub', 'After clicking Import, no visible success message — user can\'t tell if the action worked.');
        }

        // "Then attach it from the Skills tab" — user has to switch tabs manually.
        const attachHint = await page.getByText(/attach it from the skills tab/i).count();
        if (attachHint === 0) {
          flag('minor', '1.5 clawhub', 'After import, no direct "Attach to an agent" CTA — user has to context-switch to the Skills tab and find the new row.');
        }
      } else {
        flag('note', '1.5 clawhub', 'No Import buttons — allowlist may be empty in this env.');
      }
    }

    // ───────────────────────────────────────────────────────────────
    // Journey 5 — Dashboard Agent Activity inline approve/reject
    // ───────────────────────────────────────────────────────────────
    log('\n═══ J5 — Dashboard Agent Activity inline controls ═══');
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(800);
    await shot(page, '13-dashboard');

    // Scroll to the Agent Activity card (may be below the fold)
    const activityCard = page.getByText('Agent Activity', { exact: false }).first();
    if (await activityCard.count() === 0) {
      flag('blocker', '2.8 dashboard', 'Agent Activity card missing from dashboard.');
    } else {
      await activityCard.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot(page, '14-dashboard-activity');

      // Any pending items with Approve buttons?
      const approveBtn = page.getByRole('button', { name: /^approve$/i });
      const approveCount = await approveBtn.count();
      log(`  ${approveCount} pending actions with inline Approve`);
      if (approveCount === 0) {
        flag('note', '2.8 dashboard', 'No pending actions in this env — inline approve/reject could not be exercised.');
      } else {
        // Observe the visual hierarchy — is Approve the primary action?
        const rejectBtn = page.getByRole('button', { name: /^reject$/i });
        const rejectCount = await rejectBtn.count();
        if (rejectCount !== approveCount) {
          flag('minor', '2.8 dashboard', `Approve count (${approveCount}) != Reject count (${rejectCount}) — rows should have both buttons.`);
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    // Journey 6 — Features without UI (audit gaps)
    // ───────────────────────────────────────────────────────────────
    log('\n═══ J6 — Features shipped as API-only ═══');

    // Clone agent — is there a UI button?
    // Look on the agent row in settings/agent
    try {
      await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'load', timeout: 15_000 });
    } catch {
      await page.waitForTimeout(500);
      await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(500);
    const cloneBtn = await page.getByRole('button', { name: /clone|duplicate/i }).count();
    if (cloneBtn === 0) {
      flag('major', '3.1 clone', 'POST /:id/clone endpoint exists but no UI affordance — the "Clone agent button" from the plan is missing. User must curl to use it.');
    }
    const saveTplBtn = await page.getByRole('button', { name: /save as template/i }).count();
    if (saveTplBtn === 0) {
      flag('major', '3.1 save-as-template', 'Save-as-template endpoint shipped but no UI button — wizard step 1 queries the template table so the saved rows would appear there, but user can\'t save one without an API call.');
    }

    // Webhooks — is there any UI?
    const webhooksNav = await page.getByText(/webhook/i).count();
    if (webhooksNav === 0) {
      flag('major', '3.3 webhooks', 'agent_webhooks backend ships with full API + HMAC dispatch but no UI — users cannot create/revoke webhooks through the app. Biggest remaining gap for "power users" surface.');
    }

    // Trace export — any download button on the current page?
    const traceExportBtn = await page.getByRole('button', { name: /export|download.*trace/i }).count();
    if (traceExportBtn === 0) {
      flag('minor', '3.8 trace export', 'GET /trace.json endpoint ships but no UI button — user has to construct the URL + auth themselves.');
    }

    // Reasoning trace component exists but not wired into chat
    // Check any open chat page for a "Show trace" expander
    const spacesRes = await fetch(`${API_URL}/api/spaces`, { headers: { authorization: `Bearer ${auth.access_token}` } });
    const spacesBody = await spacesRes.json() as Array<{ id: string }>;
    const firstSpace = Array.isArray(spacesBody) ? spacesBody[0] : undefined;
    if (firstSpace) {
      try {
        await page.goto(`${WEB_URL}/spaces/${firstSpace.id}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1200);
        await shot(page, '15-chat');
        const showTrace = await page.getByText(/show trace/i).count();
        if (showTrace === 0) {
          flag('major', '1.10 reasoning trace', 'ReasoningTrace component ships + hook subscribes to socket events but it is not wired into the chat message UI. Users cannot see tool-call trees until the chat component imports the expander.');
        }
      } catch (err) {
        flag('note', '1.10 reasoning trace', `Could not load chat space: ${(err as Error).message}`);
      }
    }

    // ───────────────────────────────────────────────────────────────
    // Summary console errors
    // ───────────────────────────────────────────────────────────────
    if (consoleErrors.length > 0) {
      flag('major', 'console', `${consoleErrors.length} JS console errors/page errors during walkthrough.`, consoleErrors.slice(0, 5).join(' | '));
    }
  } finally {
    await browser.close();
  }

  // ─── Write findings report ──────────────────────────────────────
  const bySeverity = (s: Severity) => findings.filter((f) => f.severity === s);
  const body: string[] = [
    '# UX walkthrough findings',
    `\nRun: ${new Date().toISOString()}`,
    `\nEnv: ${WEB_URL} (dev) / org=maneek@test.com`,
    '\nAutomated human-style click-through of Blocks 0–3. Script: `docs/superpowers/audits/ux-walkthrough.ts`.',
    '\n## Summary',
    '',
    `| Severity | Count |`,
    `| --- | --- |`,
    `| 🛑 Blocker | ${bySeverity('blocker').length} |`,
    `| ⚠️ Major | ${bySeverity('major').length} |`,
    `| 🟡 Minor | ${bySeverity('minor').length} |`,
    `| • Nit | ${bySeverity('nit').length} |`,
    `| ℹ Note | ${bySeverity('note').length} |`,
  ];
  for (const sev of ['blocker', 'major', 'minor', 'nit', 'note'] as Severity[]) {
    const items = bySeverity(sev);
    if (items.length === 0) continue;
    body.push(`\n## ${sev.charAt(0).toUpperCase()}${sev.slice(1)}${items.length > 1 ? 's' : ''}`);
    for (const f of items) {
      body.push(`\n- **[${f.area}]** ${f.issue}${f.evidence ? `\n  - _${f.evidence}_` : ''}`);
    }
  }
  writeFileSync(REPORT, body.join('\n') + '\n');
  console.log(`\nfindings: ${findings.length} total — see ${REPORT}`);
  console.log(`screenshots: ${SHOT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(REPORT, `FATAL: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
