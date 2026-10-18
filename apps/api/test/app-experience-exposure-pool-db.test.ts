import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { createExperienceExposureDatabase, APP_EXPERIENCE_EXPOSURE_DB_LIMITS } from '../src/lib/app-experience-exposure-db.js';
import { ExperienceExposureBusyError } from '../src/lib/app-experience-exposure-db-error.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target !== undefined && target === process.env.DATABASE_URL
  && ['127.0.0.1', 'localhost'].includes(new URL(target).hostname)
  && /^\/(?:exposure_pool_test|deft_test)$/.test(new URL(target).pathname);

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('two concurrent review preparations complete while ordinary reads and status saturate their pool', { skip: !safe }, async () => {
  const database = createExperienceExposureDatabase(target!);
  const release = latch();
  const started = Array.from({ length: APP_EXPERIENCE_EXPOSURE_DB_LIMITS.connections }, latch);
  const reads = started.map(ready => database.transaction(async tx => {
    await tx.execute(sql`SELECT 1`);
    ready.resolve();
    await release.promise;
  }));
  const preparing = [latch(), latch()];
  const actions: Promise<unknown>[] = [];
  try {
    await Promise.race([Promise.all(started.map(ready => ready.promise)), Promise.all(reads)]);
    const status = assert.rejects(database.transaction(tx => tx.execute(sql`SELECT 'status'`)),
      error => error instanceof ExperienceExposureBusyError && error.reason === 'acquisition');
    for (const ready of preparing) actions.push(database.transaction(async tx => {
      ready.resolve();
      await Promise.race([Promise.all(preparing.map(item => item.promise)), release.promise]);
      const result = await tx.execute(sql`SELECT 42 AS answer`);
      assert.equal(result.rows[0]?.answer, 42);
    }, undefined, undefined, undefined, 'human_action_preparation'));
    await Promise.all(actions);
    await status;
  } finally {
    release.resolve();
    await Promise.allSettled([...reads, ...actions]);
    await database.close();
  }
});

test('human action capacity is bounded and cannot consume the ordinary read slots', { skip: !safe }, async () => {
  const database = createExperienceExposureDatabase(target!);
  const release = latch(), started = Array.from({ length: 2 }, latch);
  const held = Promise.all(started.map(ready => database.transaction(async tx => {
    await tx.execute(sql`SELECT 1`); ready.resolve(); await release.promise;
  }, undefined, undefined, undefined, 'human_action_confirmation')));
  try {
    await Promise.race([Promise.all(started.map(ready => ready.promise)), held]);
    assert.equal((await database.transaction(tx => tx.execute(sql`SELECT 42 AS answer`))).rows[0]?.answer, 42);
    let ran = false;
    await assert.rejects(database.transaction(async () => { ran = true; },
      undefined, undefined, undefined, 'human_action_preparation'),
      error => error instanceof ExperienceExposureBusyError && error.reason === 'acquisition');
    assert.equal(ran, false);
    release.resolve(); await held;
    assert.equal((await database.transaction(tx => tx.execute(sql`SELECT 42 AS answer`),
      undefined, undefined, undefined, 'human_action_preparation')).rows[0]?.answer, 42);
  } finally {
    release.resolve(); await Promise.allSettled([held]); await database.close();
  }
});

for (const mode of ['abort', 'deadline'] as const) {
  test(`queued human ${mode} cannot begin authority work and the pool recovers`, { skip: !safe }, async () => {
    const database = createExperienceExposureDatabase(target!);
    const release = latch(), started = Array.from({ length: 2 }, latch);
    const held = Promise.all(started.map(ready => database.transaction(async tx => {
      await tx.execute(sql`SELECT 1`); ready.resolve(); await release.promise;
    }, undefined, undefined, undefined, 'human_action_confirmation')));
    try {
      await Promise.race([Promise.all(started.map(ready => ready.promise)), held]);
      const controller = new AbortController();
      let ran = false;
      const waiting = database.transaction(async () => { ran = true; }, controller.signal,
        mode === 'deadline' ? performance.now() + 25 : undefined, undefined, 'human_action_preparation');
      const denied = assert.rejects(waiting, error => mode === 'abort'
        ? error instanceof Error && error.message === 'synthetic queued cancellation'
        : error instanceof ExperienceExposureBusyError && error.reason === 'deadline');
      if (mode === 'abort') controller.abort(new Error('synthetic queued cancellation'));
      await Promise.race([denied, delay(300).then(() => { throw new Error('queued cancellation must settle while both slots remain occupied'); })]);
      release.resolve(); await Promise.all([held, denied]);
      assert.equal(ran, false);
      assert.equal((await database.transaction(tx => tx.execute(sql`SELECT 42 AS answer`),
        undefined, undefined, undefined, 'human_action_preparation')).rows[0]?.answer, 42);
    } finally {
      release.resolve(); await Promise.allSettled([held]); await database.close();
    }
  });
}

for (const exceedsStatementLimit of [false, true]) {
test(`active human cancellation ${exceedsStatementLimit ? 'discards a timed-out' : 'rolls back a healthy'} PostgreSQL backend before capacity recovers`, { skip: !safe }, async () => {
  const database = createExperienceExposureDatabase(target!);
  const monitor = new pg.Client({ connectionString: target });
  await monitor.connect();
  const started = latch(), controller = new AbortController();
  let backend = 0;
  const running = database.transaction(async tx => {
    backend = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid);
    started.resolve();
    await tx.execute(sql`SELECT pg_sleep(${exceedsStatementLimit ? 10 : 0.15})`);
  }, controller.signal, undefined, undefined, 'human_action_preparation');
  const denied = assert.rejects(running, /synthetic active cancellation/);
  try {
    await started.promise;
    let sleeping = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await monitor.query('SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [backend]);
      if (result.rows[0]?.wait_event === 'PgSleep') { sleeping = true; break; }
      await delay(5);
    }
    assert.equal(sleeping, true, 'cancellation must exercise a real active PostgreSQL statement');
    controller.abort(new Error('synthetic active cancellation'));
    await denied;
    if (exceedsStatementLimit) {
      let present = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        present = (await monitor.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [backend])).rowCount !== 0;
        if (!present) break;
        await delay(5);
      }
      assert.equal(present, false, 'discarded backend must leave no active transaction');
    } else {
      const result = await monitor.query('SELECT state, xact_start, wait_event FROM pg_stat_activity WHERE pid = $1', [backend]);
      assert.equal(result.rows[0]?.state, 'idle');
      assert.equal(result.rows[0]?.xact_start, null);
      assert.notEqual(result.rows[0]?.wait_event, 'PgSleep');
    }
    const recovered = await database.transaction(tx => tx.execute(sql`SELECT pg_backend_pid() AS pid, 42 AS answer`),
      undefined, undefined, undefined, 'human_action_preparation');
    if (exceedsStatementLimit) assert.notEqual(Number(recovered.rows[0]?.pid), backend);
    else assert.equal(Number(recovered.rows[0]?.pid), backend);
    assert.equal(recovered.rows[0]?.answer, 42);
  } finally {
    controller.abort(new Error('synthetic active cancellation'));
    await Promise.allSettled([running, denied]);
    await monitor.end(); await database.close();
  }
});
}

test('server-enforced operation deadline reports retryable saturation and recovers', { skip: !safe }, async () => {
  const database = createExperienceExposureDatabase(target!);
  try {
    await assert.rejects(database.transaction(tx => tx.execute(sql`SELECT pg_sleep(10)`),
      undefined, performance.now() + 150, undefined, 'human_action_preparation'),
      error => error instanceof ExperienceExposureBusyError && error.reason === 'deadline' && error.retryable);
    assert.equal((await database.transaction(tx => tx.execute(sql`SELECT 42 AS answer`),
      undefined, undefined, undefined, 'human_action_preparation')).rows[0]?.answer, 42);
  } finally { await database.close(); }
});

test('failed human authority work rolls back transaction-local state before slot reuse', { skip: !safe }, async () => {
  const database = createExperienceExposureDatabase(target!);
  let backend = 0;
  try {
    await assert.rejects(database.transaction(async tx => {
      backend = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid);
      await tx.execute(sql`SELECT set_config('application_name', 'uncommitted-authority-work', true)`);
      throw new Error('synthetic authority withdrawal');
    }, undefined, undefined, undefined, 'human_action_preparation'), /synthetic authority withdrawal/);
    const recovered = await database.transaction(tx => tx.execute(sql`SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name`),
      undefined, undefined, undefined, 'human_action_preparation');
    assert.equal(Number(recovered.rows[0]?.pid), backend, 'settled rollback can safely reuse the same connection');
    assert.equal(recovered.rows[0]?.name, 'deft-experience-human-action');
  } finally { await database.close(); }
});
