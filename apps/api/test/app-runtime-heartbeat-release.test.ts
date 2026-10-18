import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/lib/db.js';

test('heartbeat renews an approved claimed Run and retains release, authority, attempt and expiry fences', async () => {
  const now = new Date('2026-10-13T16:00:00.000Z');
  const future = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const authority = { pin: { runtime_binding_id: 'binding', runtime_epoch: 1, session_epoch: 2 } };
  let live = true, matches = true, authorityChecks = 0;
  const unused = () => { throw new Error('UNEXPECTED_FIXTURE_AUTHORITY_OPERATION'); };
  mock.module(new URL('../src/lib/app-runtime-authority.ts', import.meta.url).href, {
    namedExports: {
      loadLiveRuntimeAuthority: async () => { authorityChecks++; return live ? authority : null; },
      runtimeRunMatchesAuthority: async () => matches ? { input_schema: { properties: {} } } : null,
      hashAppRuntimeToken: unused, issueAppRuntimeSession: unused, renewAppRuntimeSession: unused,
    },
  });
  mock.module(new URL('../src/lib/app-future-record-action-dispatch.ts', import.meta.url).href, {
    namedExports: { optionalFutureRecordAction: async () => null,
      futureRecordActionGate: unused, settleFutureRecordAction: unused },
  });
  const { AppRunAttemptRunner } = await import('../src/lib/app-run-attempt-runner.js');
  const originalSelect = db.select;
  const freshRun = () => ({ id: 'run', provider_kind: 'app_runtime', state: 'pending_approval',
    cancel_requested_at: null, execution_released_at: future(-1),
    input_expires_at: future(30), result_expires_at: future(120) });
  const freshAttempt = () => ({ claim_token: 'claim', state: 'claimed',
    runtime_session_id: 'session', runtime_binding_id: 'binding', runtime_epoch: 1,
    runtime_session_epoch: 2, runtime_sequence: 1, lease_expires_at: future(10) });
  let run: Record<string, unknown> = freshRun(), attempt: Record<string, unknown> = freshAttempt();
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    execute: async () => ({ rows: [] }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [attempt] }) }) }),
    update: () => ({ set: (value: Record<string, unknown>) => ({ where: () => ({ returning: async () => {
      writes.push(value); return [{ id: 'attempt' }];
    } }) }) }),
  };
  const repository = { transaction: async (callback: (value: unknown) => unknown) => callback(tx),
    lockRun: async () => run };
  const runner = new AppRunAttemptRunner(repository as never, {} as never, {} as never,
    { execute: unused } as never, undefined, () => now, 60_000);
  db.select = (() => ({ from: () => ({ where: () => ({ limit: async () => [{ run_id: 'run' }] }) }) })) as typeof db.select;
  const invoke = () => runner.renewLease('org', 'attempt', 'claim', {
    run_id: 'run', session_id: 'session', token_hash: 'synthetic-fingerprint', sequence: 1,
  });
  try {
    assert.equal(await invoke(), true, 'released pending_approval must reach authority and claimed-attempt renewal');
    assert.equal(authorityChecks, 1);
    assert.equal(writes.length, 1);
    assert.equal((writes[0]!.lease_expires_at as Date).toISOString(), future(30).toISOString(),
      'renewal remains capped by retained input expiry');
    const denials: Array<[string, () => void]> = [
      ['unreleased', () => { run.execution_released_at = null; }],
      ['cancelled', () => { run.cancel_requested_at = future(-1); }],
      ['expired input', () => { run.input_expires_at = now; }],
      ['expired result', () => { run.result_expires_at = now; }],
      ...['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome'].map(state =>
        [state, () => { run.state = state; }] as [string, () => void]),
      ['revoked authority', () => { live = false; }],
      ['mismatched action authority', () => { matches = false; }],
      ['wrong claim', () => { attempt.claim_token = 'different'; }],
      ['wrong runtime session', () => { attempt.runtime_session_id = 'different'; }],
      ['wrong binding', () => { attempt.runtime_binding_id = 'different'; }],
      ['wrong runtime epoch', () => { attempt.runtime_epoch = 2; }],
      ['wrong session epoch', () => { attempt.runtime_session_epoch = 3; }],
      ['wrong sequence', () => { attempt.runtime_sequence = 2; }],
      ['expired attempt', () => { attempt.lease_expires_at = now; }],
      ['terminal attempt', () => { attempt.state = 'succeeded'; }],
    ];
    for (const [name, change] of denials) {
      run = freshRun(); attempt = freshAttempt(); live = true; matches = true; change();
      assert.equal(await invoke(), false, name);
      assert.equal(writes.length, 1, `${name} cannot renew an attempt`);
    }
  } finally { db.select = originalSelect; mock.restoreAll(); }
});
