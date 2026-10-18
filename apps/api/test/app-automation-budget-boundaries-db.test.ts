import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { mcpClientManager } from '@deft/mcp';
import { db, closeDb } from '../src/lib/db.js';
import { AppError } from '../src/lib/app-errors.js';
import { AppActionService } from '../src/lib/app-action-service.js';
import { persistAppAutomationFire } from '../src/lib/app-automation-definition-service.js';
import { claimAppAutomationFireWithExecutor, type AppAutomationFireRow } from '../src/lib/app-automation-repository.js';
import { shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';
import { databaseCompleteAppRunTestKeyringFixture } from './fixtures/app-run-test-keyrings.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_a05_budget_test(?:_v[0-9]+)?$/.test(target);
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
const priorKeyrings = process.env.DEFT_APP_RUN_KEYRINGS;
before(async () => {
  if (!safe) return;
  await shutdownAppRunRuntime();
  process.env.DEFT_APP_RUN_KEYRINGS = (await databaseCompleteAppRunTestKeyringFixture('a05-budget-boundaries')).environment;
});
after(async () => {
  if (!safe) return;
  await shutdownAppRunRuntime(); await mcpClientManager.shutdown(); await closeDb();
  if (priorKeyrings === undefined) delete process.env.DEFT_APP_RUN_KEYRINGS;
  else process.env.DEFT_APP_RUN_KEYRINGS = priorKeyrings;
});

type Fixture = Awaited<ReturnType<typeof createAutomationRenewalFixture>>;
type Definition = Awaited<ReturnType<Fixture['create']>>['definition'];
function occurrence(fixture: Fixture, definition: Definition, due: Date) {
  return { organization_id: fixture.orgId, definition_id: definition.id, expected_epoch: definition.definition_epoch,
    logical_local_date: due.toISOString().slice(0, 10),
    resolution: { kind: 'resolved' as const, resolved_at_utc: due } };
}
function claim(fire: AppAutomationFireRow, at: Date, organizationId = fire.org_id) {
  return db.transaction(tx => claimAppAutomationFireWithExecutor(tx, {
    organization_id: organizationId, definition_id: fire.definition_id, fire_id: fire.id,
    expected_epoch: fire.definition_epoch, claim_owner: 'a05-budget-boundary', claim_token: randomUUID(),
    claimed_at: at, lease_expires_at: new Date(at.getTime() + 60_000),
  }));
}
async function counts(observer: pg.Client, organizationId: string) {
  const [row] = (await observer.query(`SELECT
    count(*) FILTER (WHERE state IN ('pending','claimed'))::int AS unsettled,
    count(*) FILTER (WHERE state='claimed')::int AS claimed,
    count(*) FILTER (WHERE state='run_created')::int AS run_created,
    count(DISTINCT fire_identity)::int AS identities
    FROM app_automation_fires WHERE org_id=$1`, [organizationId])).rows;
  return row;
}
async function invoke(claimed: AppAutomationFireRow) {
  assert.equal(claimed.state, 'claimed'); assert.ok(claimed.claim_token);
  return new AppActionService().invokeApprovedAutomation({ organization_id: claimed.org_id,
    definition_id: claimed.definition_id, fire_id: claimed.id, claim_token: claimed.claim_token });
}

test('A05 concurrent 25th and 26th pending admission reserves one slot with full-quota replay and tenant isolation', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const other = await createAutomationRenewalFixture();
  const due = new Date('2051-01-01T10:00:00Z');
  const definitions: Definition[] = [];
  for (let index = 0; index < 26; index++) {
    definitions.push((await fixture.create(due, new Date(due.getTime() - 1_000 + index), 3600)).definition);
  }
  for (const definition of definitions.slice(0, 24)) {
    await persistAppAutomationFire(occurrence(fixture, definition, due), { now: () => due });
  }
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    assert.equal((await counts(observer, fixture.orgId)).unsettled, 24);
    const admission = await Promise.allSettled(definitions.slice(24).map(definition =>
      persistAppAutomationFire(occurrence(fixture, definition, due), { now: () => due })));
    const winners = admission.filter((result): result is PromiseFulfilledResult<AppAutomationFireRow> => result.status === 'fulfilled');
    const losers = admission.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(losers.length, 1);
    assert.ok(losers[0]!.reason instanceof AppError && losers[0]!.reason.code === 'APP_STALE');
    assert.deepEqual(await counts(observer, fixture.orgId), { unsettled: 25, claimed: 0, run_created: 0, identities: 25 });
    const winner = winners[0]!.value;
    const winningDefinition = definitions.find(definition => definition.id === winner.definition_id)!;
    const replay = await persistAppAutomationFire(occurrence(fixture, winningDefinition, due), { now: () => due });
    assert.equal(replay.id, winner.id); assert.equal(replay.fire_identity, winner.fire_identity);
    assert.ok(await claim(winner, due));
    assert.equal((await counts(observer, fixture.orgId)).unsettled, 25, 'claimed work still occupies its pending quota slot');
    const losingDefinition = definitions.slice(24).find(definition => definition.id !== winner.definition_id)!;
    await assert.rejects(persistAppAutomationFire(occurrence(fixture, losingDefinition, due), { now: () => due }),
      error => error instanceof AppError && error.code === 'APP_STALE');
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_automation_fires WHERE definition_id=$1', [losingDefinition.id])).rows[0].count, 0);
    const otherDefinition = (await other.create(due, new Date(due.getTime() - 1_000), 3600)).definition;
    const otherFire = await persistAppAutomationFire(occurrence(other, otherDefinition, due), { now: () => due });
    assert.ok(await claim(otherFire, due)); assert.equal(await claim(winner, due, other.orgId), null);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 0);
    assert.deepEqual(await fixture.effects(), []); assert.deepEqual(await other.effects(), []);
    console.log('A05_PENDING_BOUNDARY_RESULT', JSON.stringify({ admitted: 25, concurrent_winners: winners.length,
      concurrent_losers: losers.length, replay_fire_id: replay.id, claimed_still_unsettled: 25, other_tenant_admitted: true }));
  } finally { await observer.end(); }
});

test('A05 concurrent 99th 100th 101st daily reservations and replay remain bounded across controlled UTC midnight', { skip: !safe }, async context => {
  // PostgreSQL's Run authority trigger deliberately uses its own now(). Keep
  // Run creation on the real UTC date; mock only application policy time.
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const midnight = new Date(dayStart.getTime() + 86_400_000);
  const beforeMidnight = new Date(midnight.getTime() - 1);
  const due = new Date(midnight.getTime() - 10 * 60_000);
  context.mock.timers.enable({ apis: ['Date'], now: beforeMidnight });
  const fixture = await createAutomationRenewalFixture();
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    const definitions: Definition[] = [];
    for (let index = 0; index < 101; index++) {
      definitions.push((await fixture.create(due, new Date(dayStart.getTime() + index), 2 * 86_400)).definition);
    }
    for (const definition of definitions.slice(0, 98)) {
      const fire = await persistAppAutomationFire(occurrence(fixture, definition, due), { now: () => beforeMidnight });
      const claimed = await claim(fire, beforeMidnight); assert.ok(claimed);
      await invoke(claimed);
    }
    assert.deepEqual(await counts(observer, fixture.orgId), { unsettled: 0, claimed: 0, run_created: 98, identities: 98 });
    const fires = await Promise.all(definitions.slice(98).map(definition =>
      persistAppAutomationFire(occurrence(fixture, definition, due), { now: () => beforeMidnight })));
    const reservations = await Promise.all(fires.map(fire => claim(fire, beforeMidnight)));
    const winners = reservations.filter((fire): fire is AppAutomationFireRow => fire !== null);
    assert.equal(winners.length, 2); assert.equal(reservations.filter(fire => fire === null).length, 1);
    assert.deepEqual(await counts(observer, fixture.orgId), { unsettled: 3, claimed: 2, run_created: 98, identities: 101 });
    const loser = fires.find(fire => !winners.some(winner => winner.id === fire.id))!;
    assert.equal(await claim(loser, beforeMidnight), null);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 98,
      'rejected101st reservation creates no Run');
    const runs = await Promise.all(winners.map(invoke));
    assert.equal(new Set(runs.map(run => run.id)).size, 2);
    const replay = await new AppActionService().invokeApprovedAutomation({ organization_id: fixture.orgId,
      definition_id: winners[0]!.definition_id, fire_id: winners[0]!.id, claim_token: winners[0]!.claim_token! });
    assert.equal(replay.id, runs[0]!.id);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 100);
    assert.deepEqual(await counts(observer, fixture.orgId), { unsettled: 1, claimed: 0, run_created: 100, identities: 101 });
    assert.equal(await claim(loser, beforeMidnight), null);
    context.mock.timers.setTime(midnight.getTime());
    const newDay = await claim(loser, midnight); assert.ok(newDay); assert.equal(newDay.attempt_count, 1);
    // These columns store UTC as timestamp without time zone; ::date is
    // therefore independent of the PostgreSQL session timezone.
    const days = (await observer.query(`SELECT coalesce(terminal_at,claimed_at)::date::text AS day,count(*)::int AS count
      FROM app_automation_fires WHERE org_id=$1 AND state IN ('claimed','run_created')
      GROUP BY coalesce(terminal_at,claimed_at)::date ORDER BY day`, [fixture.orgId])).rows;
    assert.deepEqual(days, [{ day: dayStart.toISOString().slice(0, 10), count: 100 }, { day: midnight.toISOString().slice(0, 10), count: 1 }]);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 100,
      'midnight proof stops at persisted claim reservation; database authority clock is not mocked');
    assert.deepEqual(await fixture.effects(), []);
    console.log('A05_DAILY_UTC_BOUNDARY_RESULT', JSON.stringify({ prior_day: 100, next_day: 1,
      concurrent_claim_winners: 2, concurrent_claim_losers: 1, replay_consumed_extra_reservation: false,
      policy_clock_before: beforeMidnight.toISOString(), policy_clock_after: midnight.toISOString(), provider_effects: 0 }));
  } finally { await observer.end(); context.mock.timers.reset(); }
});
