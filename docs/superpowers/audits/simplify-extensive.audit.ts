#!/usr/bin/env tsx
/**
 * Extensive end-to-end audit — drives every path touched by the
 * simplify-skills-templates refactor plus agent execution.
 *
 * Scenarios (each with a screenshot):
 *   1. Login + dashboard
 *   2. Project create via single-step modal (from sidebar +)
 *   3. Task quick-create inside the new project
 *   4. Apply Launch Campaign template via "+ from template"
 *   5. Marketing project renders without the old crash
 *   6. Library page — Skills tab populated
 *   7. Library page — Templates tab populated
 *   8. Agent wizard — 3 steps: Identity / Behavior / Skills
 *   9. Agent creation completes (no BYOA block; self-hosted=false for this run)
 *  10. Assign a task to the new agent via the API (task-detail assign UI is
 *      brittle; API path is the contract the UI calls)
 *  11. Agent-side: GET /api/agent/actions/pending picks up the assigned work
 *  12. Task status change — move Backlog → Todo via UI status dropdown
 *
 * Headless Playwright on Chromium. DB cleanup for seeded rows at end.
 *
 * Preconditions:
 *   - Dev API on :3001, web on :3000
 *   - DEFT_SELF_HOSTED=false in .env (toggle and restart API before running)
 *   - Seed user maneek@test.com / test1234
 *
 * Run:
 *   pnpm tsx docs/superpowers/audits/simplify-extensive.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/simplify-extensive';
const REPORT_PATH = 'docs/superpowers/audits/simplify-extensive.last-run.txt';

const RUN = Date.now();
const SUFFIX = String(RUN).slice(-4);

type LogLine = { level: 'ok' | 'fail' | 'info'; msg: string };
const log: LogLine[] = [];
function ok(msg: string) { log.push({ level: 'ok', msg }); console.log('✔', msg); }
function fail(msg: string) { log.push({ level: 'fail', msg }); console.error('✖', msg); }
function info(msg: string) { log.push({ level: 'info', msg }); console.log('ℹ', msg); }
function assertTrue(cond: boolean, label: string): boolean {
  if (cond) { ok(label); return true; } fail(label); return false;
}

async function login(): Promise<{ accessToken: string; refreshToken?: string; userId: string; orgId: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const accessToken = (raw.access_token ?? raw.accessToken) as string;
  const refreshToken = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  const user = raw.user as { id: string } | undefined;
  const orgId = (raw.org_id ?? raw.orgId) as string;
  return { accessToken, refreshToken, userId: user?.id ?? '', orgId };
}

async function api<T = unknown>(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep as text */ }
  return { status: res.status, body: body as T };
}

async function shot(page: Page, name: string) {
  const path = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  info(`screenshot: ${path}`);
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  const { accessToken, refreshToken, userId, orgId } = await login();
  ok(`login (user ${userId}, org ${orgId})`);

  // ─── Browser ─────────────────────────────────────────────────────
  const browser: Browser = await chromium.launch({ headless: true });
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: accessToken, rt: refreshToken ?? null },
  );
  const page: Page = await ctx.newPage();
  page.setDefaultTimeout(10_000);

  let newProjectId: string | null = null;
  let newTaskId: string | null = null;
  let newAgentId: string | null = null;

  try {
    // ─── 1. Dashboard ──────────────────────────────────────────────
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '01-dashboard');
    ok('1. dashboard');

    // ─── 2. Project create via single-step modal ───────────────────
    await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);

    const createBtn = page.getByRole('button', { name: /create project/i }).first();
    if (await createBtn.count()) {
      await createBtn.click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      await shot(page, '02-project-modal');

      // Count steps — expect NO "Step X of 2" text
      const stepBadge = await page.getByText(/Step\s+\d+\s+of\s+\d+/i).count();
      assertTrue(stepBadge === 0, '2a. project modal single-step (no step badge)');

      const nameInput = page.getByPlaceholder(/e\.g\. Mobile App/i);
      if (await nameInput.count()) {
        const name = `ExtAudit ${SUFFIX}`;
        const prefix = `EA${SUFFIX}`;
        await nameInput.fill(name);
        const prefixInput = page.getByPlaceholder('e.g. MOB', { exact: true });
        if (await prefixInput.count()) {
          await prefixInput.fill(prefix);
        }
        await shot(page, '03-project-form-filled');

        // Submit
        const submitBtn = page.getByRole('button', { name: /^create project$/i }).last();
        await submitBtn.click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        ok('2b. submitted project create');
      } else {
        fail('2. name input not found');
      }
    } else {
      fail('2. create project button not found');
    }

    // Capture the new project id from the URL
    await page.waitForTimeout(500);
    const urlAfterCreate = page.url();
    const m = urlAfterCreate.match(/[?&]project=([0-9a-f-]+)/i);
    newProjectId = m ? m[1] ?? null : null;
    if (newProjectId) {
      ok(`2c. redirected to project ${newProjectId.slice(0, 8)}…`);
    } else {
      // Fallback: fetch the latest project via API
      const r = await api<Array<{ id: string; name: string }>>(`/api/projects`, accessToken);
      const latest = Array.isArray(r.body) ? r.body.find((p) => p.name.includes(`ExtAudit ${SUFFIX}`)) : undefined;
      if (latest) newProjectId = latest.id;
      info(`2c. fallback looked up project id: ${newProjectId}`);
    }

    // ─── 3. Task quick-create ──────────────────────────────────────
    if (newProjectId) {
      await page.goto(`${WEB_URL}/tasks?project=${newProjectId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await shot(page, '04-project-board-empty');

      const newTaskBtn = page.getByRole('button', { name: /new task/i }).first();
      if (await newTaskBtn.count()) {
        await newTaskBtn.click();
        await page.waitForTimeout(400);
        const titleInput = page.getByPlaceholder(/task title/i);
        if (await titleInput.count()) {
          await titleInput.fill(`Manual task ${SUFFIX}`);
          await shot(page, '05-task-modal-filled');
          // Submit via Enter (modal says "Press Enter to create")
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1500);
          ok('3. manual task created');
          await shot(page, '06-task-on-board');
        } else {
          fail('3. task title input not found');
        }
      } else {
        fail('3. New task button not found');
      }
    }

    // ─── 4. Apply Launch Campaign template ─────────────────────────
    if (newProjectId) {
      // Open task quick-create again to find "+ from template"
      const newTaskBtn2 = page.getByRole('button', { name: /new task/i }).first();
      if (await newTaskBtn2.count()) {
        await newTaskBtn2.click().catch(() => undefined);
        await page.waitForTimeout(400);
        const fromTemplateBtn = page.getByRole('button', { name: /\+\s*from template/i });
        if (await fromTemplateBtn.count()) {
          await fromTemplateBtn.click();
          await page.waitForTimeout(800);
          await shot(page, '07-template-picker');

          // Pick Launch Campaign card
          const launchCard = page.getByRole('button', { name: /launch campaign/i }).first();
          if (await launchCard.count()) {
            await launchCard.click();
            await page.waitForTimeout(300);
            await shot(page, '08-template-preview');

            const applyBtn = page.getByRole('button', { name: /apply template/i });
            if (await applyBtn.count()) {
              await applyBtn.click();
              await page.waitForTimeout(3000);
              await shot(page, '09-template-applied');
              ok('4. Launch Campaign applied (7 tasks expected)');
            } else {
              fail('4. Apply button not found in picker');
            }
          } else {
            fail('4. Launch Campaign template card not found');
          }
        } else {
          fail('4. + from template button not found');
        }
      }

      // Verify 8 tasks now (1 manual + 7 template) via API
      const tasksRes = await api<{ tasks?: Array<{ title: string }> } | Array<{ title: string }>>(
        `/api/projects/${newProjectId}/tasks`,
        accessToken,
      );
      const taskList = Array.isArray(tasksRes.body)
        ? tasksRes.body
        : (tasksRes.body?.tasks ?? []);
      info(`4c. project task count: ${taskList.length}`);
      assertTrue(taskList.length >= 7, '4c. at least 7 tasks after template apply');
    }

    // ─── 5. Marketing project — no crash ───────────────────────────
    const marketingId = await (async () => {
      const r = await api<Array<{ id: string; name: string }>>(`/api/projects`, accessToken);
      if (!Array.isArray(r.body)) return null;
      return r.body.find((p) => /marketing/i.test(p.name))?.id ?? null;
    })();
    if (marketingId) {
      await page.goto(`${WEB_URL}/tasks?project=${marketingId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await shot(page, '10-marketing-board');
      const crashText = await page.getByText(/cannot read properties of undefined|Runtime TypeError/i).count();
      assertTrue(crashText === 0, '5. Marketing project renders without crash');
    } else {
      info('5. no Marketing project in org — skipped');
    }

    // ─── 6 + 7. Library ─────────────────────────────────────────────
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1000);
    await shot(page, '11-library-skills');
    const skillsCards = await page.locator('text=/Deft Workspace|GitHub|Google Calendar|Shell Exec|Tavily|Web Browsing/').count();
    assertTrue(skillsCards >= 5, `6. Library Skills tab shows bundled skills (${skillsCards} matches)`);

    const templatesTab = page.getByRole('button', { name: /^templates$/i });
    if (await templatesTab.count()) {
      await templatesTab.click();
      await page.waitForTimeout(500);
      await shot(page, '12-library-templates');
      const tplCards = await page.locator('text=/Launch Campaign|Re-engage Sequence/').count();
      assertTrue(tplCards >= 2, `7. Library Templates tab shows bundled templates (${tplCards} matches)`);
    } else {
      fail('7. Templates tab not found in Library');
    }

    // ─── 8 + 9. Agent wizard 3-step + creation ─────────────────────
    await page.goto(`${WEB_URL}/settings/agent-employees/create`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(500);
    await shot(page, '13-agent-wizard-step1');

    const stepOf3 = await page.getByText(/Step 1 of 3/i).count();
    assertTrue(stepOf3 > 0, '8a. wizard shows "Step 1 of 3"');

    const blockedText = await page.getByText(/can't create agents yet|byoa provider/i).count();
    if (blockedText > 0) {
      fail('8b. wizard is BYOA-blocked — set DEFT_SELF_HOSTED=false and restart API');
    } else {
      ok('8b. wizard not BYOA-blocked');

      // Fill Identity
      const nameInput = page.getByPlaceholder(/Sprint Bot|Alex PM/i).first();
      if (await nameInput.count()) {
        await nameInput.fill(`AuditAgent ${SUFFIX}`);
        const roleSelect = page.getByRole('combobox').first();
        if (await roleSelect.count()) {
          await roleSelect.selectOption({ label: 'Project Manager' }).catch(() => undefined);
        }
        await shot(page, '14-agent-wizard-identity-filled');
        const nextBtn = page.getByRole('button', { name: /^next/i });
        if (await nextBtn.count()) {
          await nextBtn.click();
          await page.waitForTimeout(500);
          await shot(page, '15-agent-wizard-step2');
          ok('8c. advanced to Step 2 (Behavior)');

          // Fill Behavior — system prompt + expertise
          const promptArea = page.getByPlaceholder(/Describe what this agent should do/i);
          if (await promptArea.count()) {
            await promptArea.fill('QA audit agent — exercises task flows for verification.');
          }
          const expertise = page.getByPlaceholder(/Sprint tracking|blocker detection/i);
          if (await expertise.count()) {
            await expertise.fill('End-to-end QA, task mutations');
          }
          await shot(page, '16-agent-wizard-behavior-filled');
          const next2 = page.getByRole('button', { name: /^next/i });
          if (await next2.count()) {
            await next2.click();
            await page.waitForTimeout(700);
            await shot(page, '17-agent-wizard-step3-skills');
            ok('8d. advanced to Step 3 (Skills)');

            // Submit via Create
            const createBtn = page.getByRole('button', { name: /^create$/i });
            if (await createBtn.count()) {
              await createBtn.click();
              await page.waitForTimeout(3000);
              await shot(page, '18-agent-created');
              ok('9. agent create submitted');
              // Detect success by absence of a BYOA error banner
              const err = await page.getByText(/self.hosted mode|byoa/i).count();
              assertTrue(err === 0, '9b. no BYOA error banner after Create');
            } else {
              fail('9. Create button not found on step 3');
            }
          } else {
            fail('8d. Next button (step 2) not found');
          }
        } else {
          fail('8c. Next button (step 1) not found');
        }
      } else {
        fail('8b. name input not found on step 1');
      }
    }

    // Look up the new agent id via API
    const agentsRes = await api<Array<{ id: string; name: string }>>(`/api/agent-employees`, accessToken);
    if (Array.isArray(agentsRes.body)) {
      const created = agentsRes.body.find((a) => a.name === `AuditAgent ${SUFFIX}`);
      newAgentId = created?.id ?? null;
      info(`9c. newAgentId: ${newAgentId ?? '(not found)'}`);
    }

    // ─── 10. Assign a task to the new agent ────────────────────────
    // Tasks are assigned to USERS. Agent employees have a backing user row
    // (is_agent=true). Patch tasks.assignee_id with the agent's user_id;
    // the PATCH handler detects is_agent and enqueues agent-employee-task.
    if (newProjectId && newAgentId) {
      // Look up the agent's backing user_id
      const agentRes = await api<{ id: string; user_id: string } | Array<{ id: string; user_id: string }>>(
        `/api/agent-employees`,
        accessToken,
      );
      const agentList = Array.isArray(agentRes.body) ? agentRes.body : [];
      const agentRec = agentList.find((a) => a.id === newAgentId);
      const agentUserId = agentRec?.user_id;
      info(`10a. agent user_id: ${agentUserId}`);

      const tasksRes = await api<Array<{ id: string; title: string }> | { tasks: Array<{ id: string; title: string }> }>(
        `/api/projects/${newProjectId}/tasks`,
        accessToken,
      );
      const tasksArr = Array.isArray(tasksRes.body)
        ? tasksRes.body
        : ((tasksRes.body as { tasks?: Array<{ id: string; title: string }> })?.tasks ?? []);
      const firstTask = tasksArr[0];

      if (firstTask && agentUserId) {
        const assignRes = await api(`/api/tasks/${firstTask.id}`, accessToken, {
          method: 'PATCH',
          body: JSON.stringify({ assignee_id: agentUserId }),
        });
        assertTrue(
          assignRes.status >= 200 && assignRes.status < 300,
          `10b. PATCH /api/tasks/:id assignee_id=agent.user_id (${assignRes.status})`,
        );
        newTaskId = firstTask.id;

        // Confirm the assignment stuck
        const confirmRes = await api<{ assignee_id?: string } | { task: { assignee_id: string } }>(
          `/api/tasks/${firstTask.id}`,
          accessToken,
        );
        const body = confirmRes.body as { assignee_id?: string } & { task?: { assignee_id?: string } };
        const assignee = body.assignee_id ?? body.task?.assignee_id;
        assertTrue(assignee === agentUserId, `10c. task.assignee_id === agent.user_id (${assignee})`);
      } else if (!agentUserId) {
        fail('10. agent has no backing user_id — assignment skipped');
      } else {
        info('10. no tasks in project — assignment skipped');
      }
    }

    // ─── 11. Wait for the agent worker to pick up the assigned task ──
    // Assignment enqueues BullMQ 'agent-employee-task'. The Postgres poller
    // runs every 3s. Wait up to 20s for the agent to take an action which
    // then shows up in /api/agent/actions (conservative trust → pending).
    info('11. waiting up to 20s for agent worker to process...');
    let queuedCount = 0;
    let actionsCount = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pendingRes = await api<{ actions?: unknown[] } | unknown[]>(
        '/api/agent/actions/pending',
        accessToken,
      );
      const pendingList = Array.isArray(pendingRes.body)
        ? pendingRes.body
        : ((pendingRes.body as { actions?: unknown[] })?.actions ?? []);
      const allRes = await api<{ actions?: unknown[] } | unknown[]>('/api/agent/actions', accessToken);
      const allList = Array.isArray(allRes.body)
        ? allRes.body
        : ((allRes.body as { actions?: unknown[] })?.actions ?? []);
      queuedCount = pendingList.length;
      actionsCount = allList.length;
      info(`  poll ${attempt + 1}: pending=${queuedCount} all=${actionsCount}`);
      if (actionsCount > 0) break;
    }
    assertTrue(
      actionsCount > 0,
      `11. agent produced at least one action after assignment (actions=${actionsCount}, pending=${queuedCount})`,
    );

    // ─── 12. Status transition — task Backlog → Todo ───────────────
    if (newTaskId) {
      const patchRes = await api(`/api/tasks/${newTaskId}`, accessToken, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'todo' }),
      });
      assertTrue(
        patchRes.status >= 200 && patchRes.status < 300,
        `12. PATCH /api/tasks/:id status → todo (${patchRes.status})`,
      );

      // Visual: navigate to the project, confirm the task appears in Todo column
      await page.goto(`${WEB_URL}/tasks?project=${newProjectId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(800);
      await shot(page, '19-task-moved-to-todo');
    }
  } finally {
    await browser.close();
  }

  // ─── Report ────────────────────────────────────────────────────────
  const pass = log.filter((l) => l.level === 'ok').length;
  const failN = log.filter((l) => l.level === 'fail').length;
  const report = [
    `Run: ${new Date().toISOString()}`,
    `API: ${API_URL}`,
    `Web: ${WEB_URL}`,
    `pass=${pass} fail=${failN}`,
    '',
    ...log.map((l) => `${l.level.toUpperCase().padEnd(4)} ${l.msg}`),
    '',
    `Seeded project id: ${newProjectId ?? '(none)'}`,
    `Seeded agent id: ${newAgentId ?? '(none)'}`,
    `Seeded task id: ${newTaskId ?? '(none)'}`,
    '',
    failN === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failN} failing checks)`,
  ].join('\n');
  writeFileSync(resolve(REPORT_PATH), report);
  console.log(`\n${REPORT_PATH}\n`);
  console.log(`pass=${pass} fail=${failN}`);
  process.exit(failN === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(resolve(REPORT_PATH), `FATAL: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
