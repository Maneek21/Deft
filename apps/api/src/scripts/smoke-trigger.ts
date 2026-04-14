/**
 * Phase 6 — smoke test for the employee-trigger dispatcher.
 *
 * Loads Alex PM's employee row, enqueues a synthetic `cron:standup`
 * TriggerInvocation, and polls the messages table for up to 60s looking
 * for a new reply authored by Alex PM's shadow user in #general.
 *
 * This script hits the REAL Anthropic API (or the real OpenClaw Gateway
 * for an OpenClaw-kind Alex PM) and is intended for manual verification
 * after committing Phase 6. Do not run in CI — it burns model tokens.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/smoke-trigger.ts
 *
 * Required env:
 *   DATABASE_URL   — Postgres connection string
 *   ANTHROPIC_API_KEY — required for native Alex PM; ignored for openclaw
 *
 * Exit codes:
 *   0 — reply received, content printed to stdout
 *   1 — Alex PM not found or inactive
 *   2 — no default space resolved
 *   3 — no reply within 60s timeout
 *   4 — unexpected error
 */
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { agentEmployees, messages, spaces } from '@deft/db/schema';
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
    `[smoke-trigger] Found Alex PM employee id=${alex.id} kind=${alex.kind} user_id=${alex.user_id}`,
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

  // 3. Record the watermark: count existing messages authored by Alex's
  // shadow user so we can tell when a new one lands.
  const startTime = new Date();
  console.log(`[smoke-trigger] Watermark time: ${startTime.toISOString()}`);

  // 4. Enqueue the synthetic trigger. The worker poller (running in the
  // API dev process) will pick this up within ~3 seconds.
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
  console.log('[smoke-trigger] Enqueued employee-trigger job. Polling for reply...');

  // 5. Poll.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const rows = await db
      .select({
        id: messages.id,
        content: messages.content,
        created_at: messages.created_at,
      })
      .from(messages)
      .where(
        and(
          eq(messages.space_id, defaultSpace.id),
          eq(messages.user_id, alex.user_id),
          gt(messages.created_at, startTime),
        ),
      )
      .orderBy(desc(messages.created_at))
      .limit(1);

    if (rows.length > 0) {
      const reply = rows[0]!;
      console.log(
        `\n[smoke-trigger] SUCCESS after ${attempt} poll(s) (${Math.round(
          (Date.now() - startTime.getTime()) / 1000,
        )}s):\n`,
      );
      console.log(`---\n${reply.content}\n---`);
      console.log(`\n[smoke-trigger] Reply id=${reply.id} created_at=${reply.created_at.toISOString()}`);
      process.exit(0);
    }

    console.log(
      `[smoke-trigger] Poll ${attempt}: no reply yet (${Math.round(
        (deadline - Date.now()) / 1000,
      )}s remaining)`,
    );
  }

  console.error(
    `\n[smoke-trigger] TIMEOUT: no reply from Alex PM within ${POLL_TIMEOUT_MS / 1000}s.\n` +
      'Check: (a) is the API process running with worker poller enabled?\n' +
      '       (b) for openclaw kind, is the Gateway reachable + token valid?\n' +
      '       (c) for native kind, is ANTHROPIC_API_KEY set?\n',
  );
  process.exit(3);
}

main().catch((err) => {
  console.error('[smoke-trigger] UNEXPECTED ERROR:', err);
  process.exit(4);
});
