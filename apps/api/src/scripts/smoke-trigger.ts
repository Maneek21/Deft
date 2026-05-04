/**
 * Smoke test for the employee-trigger dispatcher.
 *
 * Locates Alex PM's employee row, enqueues a synthetic `cron:standup`
 * TriggerInvocation, and polls `agent_actions` for up to 60s looking for
 * a new `trigger_dispatch` row attributed to Alex PM.
 *
 * Phase 9: every employee is BYOA. The trigger handler no longer posts
 * a message — it queues an `agent_actions` row that the BYOA agent
 * picks up via `poll_pending_work`. This smoke test verifies the
 * dispatch path; the agent's reply is its own concern.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/smoke-trigger.ts
 *
 * Required env:
 *   DATABASE_URL — Postgres connection string
 *
 * Exit codes:
 *   0 — agent_actions row found, params printed
 *   1 — Alex PM not found or inactive
 *   2 — no default space resolved
 *   3 — no agent_actions row within 60s timeout
 *   4 — unexpected error
 */
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentActions, agentEmployees, spaces } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import type { TriggerInvocation } from '../workers/handlers/employee-trigger.js';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 60_000;

async function main() {
  // 1. Locate Alex PM. The seed uses slug 'alex-pm'.
  const [alex] = await db
    .select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.slug, 'alex-pm'), eq(agentEmployees.is_active, true)))
    .limit(1);

  if (!alex) {
    console.error('[smoke-trigger] alex-pm employee not found or inactive');
    process.exit(1);
  }
  console.log(
    `[smoke-trigger] Found Alex PM employee id=${alex.id} user_id=${alex.user_id}`,
  );

  // 2. Resolve #general (or whatever the default space is for Alex PM's org).
  const [defaultSpace] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(and(eq(spaces.org_id, alex.org_id), eq(spaces.is_default, true)))
    .limit(1);

  if (!defaultSpace) {
    console.error(`[smoke-trigger] no default space found for org ${alex.org_id}`);
    process.exit(2);
  }
  console.log(`[smoke-trigger] Target space: #${defaultSpace.name} (${defaultSpace.id})`);

  // 3. Record the watermark for agent_actions polling.
  const startTime = new Date();
  console.log(`[smoke-trigger] Watermark time: ${startTime.toISOString()}`);

  // 4. Enqueue the synthetic trigger. The worker poller (running in the
  // API dev process) will pick this up within ~3 seconds and write an
  // agent_actions row.
  const invocation: TriggerInvocation = {
    employee_id: alex.id,
    trigger_kind: 'cron:standup',
    context: { smoke_test: true, generated_at: startTime.toISOString() },
    goal: 'Generate today\'s standup in a single sentence for testing. Keep it under 30 words.',
    target_space_id: defaultSpace.id,
  };

  await enqueue(
    QUEUE_NAMES.AGENT_JOBS,
    'employee-trigger',
    invocation as unknown as Record<string, unknown>,
  );
  console.log('[smoke-trigger] Enqueued employee-trigger job. Polling agent_actions...');

  // 5. Poll for the trigger_dispatch row.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const rows = await db
      .select({
        id: agentActions.id,
        action: agentActions.action,
        source: agentActions.source,
        params: agentActions.params,
        created_at: agentActions.created_at,
      })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.agent_employee_id, alex.id),
          eq(agentActions.action, 'trigger_dispatch'),
          gt(agentActions.created_at, startTime),
        ),
      )
      .orderBy(desc(agentActions.created_at))
      .limit(1);

    if (rows.length > 0) {
      const row = rows[0]!;
      console.log(
        `\n[smoke-trigger] SUCCESS after ${attempt} poll(s) (${Math.round(
          (Date.now() - startTime.getTime()) / 1000,
        )}s):\n`,
      );
      console.log(`---\n${JSON.stringify(row.params, null, 2)}\n---`);
      console.log(`\n[smoke-trigger] action_id=${row.id} created_at=${row.created_at.toISOString()}`);
      process.exit(0);
    }

    console.log(
      `[smoke-trigger] Poll ${attempt}: no row yet (${Math.round(
        (deadline - Date.now()) / 1000,
      )}s remaining)`,
    );
  }

  console.error(
    `\n[smoke-trigger] TIMEOUT: no trigger_dispatch row from Alex PM within ${POLL_TIMEOUT_MS / 1000}s.\n` +
      'Check: (a) is the API process running with the worker poller enabled?\n' +
      '       (b) is alex-pm is_active=true and below max_daily_actions?\n',
  );
  process.exit(3);
}

main().catch((err) => {
  console.error('[smoke-trigger] UNEXPECTED ERROR:', err);
  process.exit(4);
});
