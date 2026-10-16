import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../../src/lib/db.js';

/** Exercise the actual pending Runtime input-review method while an approval
 * holds its Run row and a manager requests an App UPDATE lock. A review that
 * holds App SHARE while waiting on Run blocks that manager. */
export async function assertRuntimeInputReviewLockOrder(input: Readonly<{
  org_id: string;
  run_id: string;
  installation_id: string;
  review: () => Promise<unknown>;
}>) {
  let releaseHolder!: () => void;
  let signalRunLocked!: () => void;
  const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const runLocked = new Promise<void>((resolve) => { signalRunLocked = resolve; });
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '6000ms'`);
    await tx.execute(sql`SELECT id FROM app_runs WHERE org_id = ${input.org_id}
      AND id = ${input.run_id} FOR UPDATE`);
    signalRunLocked();
    await release;
    await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${input.org_id}
      AND id = ${input.installation_id} FOR SHARE`);
  });
  await runLocked;
  const review = input.review();
  let manager: Promise<unknown> | undefined;
  let managerWaiting = false;
  try {
    // A waiting Run FOR UPDATE proves review entered its transaction before
    // manager attempts its parent-App lock; no timing-only success is accepted.
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const result = await db.execute(sql`SELECT count(*)::int AS value FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%SELECT id FROM app_runs%'
          AND query ILIKE '%FOR UPDATE%'`);
      waiting = Number(result.rows[0]?.value ?? 0) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(waiting, 'review must be observed waiting on the held Run row');
    manager = db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '6000ms'`);
      await tx.execute(sql`SELECT set_config('application_name',
        'gate_g_runtime_review_manager', true)`);
      await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${input.org_id}
        AND id = ${input.installation_id} FOR UPDATE`);
    });
    void manager.catch(() => undefined);
    for (let attempt = 0; attempt < 25 && !managerWaiting; attempt += 1) {
      const result = await db.execute(sql`SELECT count(*)::int AS value FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'gate_g_runtime_review_manager'
          AND wait_event_type = 'Lock'`);
      managerWaiting = Number(result.rows[0]?.value ?? 0) > 0;
      if (!managerWaiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    releaseHolder();
  }
  const outcomes = await Promise.allSettled([holder, review, manager!]);
  assert.equal(managerWaiting, false,
    'review must not hold App SHARE while waiting for the approval-held Run');
  assert.deepEqual(outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled', 'fulfilled'],
    `Runtime review lock cycle: ${outcomes.map((outcome) => outcome.status === 'rejected'
      ? String((outcome.reason as { cause?: { code?: string } })?.cause?.code
        ?? (outcome.reason as { code?: string })?.code ?? outcome.reason)
      : 'ok').join(', ')}`);
}
