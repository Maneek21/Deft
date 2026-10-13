import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { appRunAttempts, appRunHumanAuthorizations, appRuns, appVersions } from '@deft/db/schema';

test('expiry injection selects post-marker input delivery and its committed envelope', async () => {
  const rollout = await import('../src/lib/env.js');
  mock.module(new URL('../src/lib/env.ts', import.meta.url).href, { namedExports: {
    ...rollout, isAppRuntimeChannelEnabled: () => true, isAppV5RuntimeActionsEnabled: () => true,
  } });
  let now = new Date('2026-10-13T17:00:00.000Z');
  const deadline = new Date(now.getTime() + 15_000), later = new Date(now.getTime() + 120_000);
  const authority = { pin: { runtime_binding_id: 'binding', runtime_epoch: 1, session_epoch: 2 } };
  const action = { protocol_version: '6', action_key: 'send_message', input_schema: { properties: {} },
    owner_target_consent_expires_at: deadline };
  const unused = () => { throw Error('UNEXPECTED_BOUNDARY_FIXTURE_OPERATION'); };
  mock.module(new URL('../src/lib/app-runtime-authority.ts', import.meta.url).href, { namedExports: {
    loadLiveRuntimeAuthority: async () => authority, runtimeRunMatchesAuthority: async () => action,
    hashAppRuntimeToken: unused, issueAppRuntimeSession: unused, renewAppRuntimeSession: unused,
  } });
  mock.module(new URL('../src/lib/app-private-access-clock.ts', import.meta.url).href, { namedExports: {
    samplePrivateAccessClock: async () => ({ current: () => now }),
  } });
  mock.module(new URL('../src/lib/app-future-record-action-dispatch.ts', import.meta.url).href, { namedExports: {
    optionalFutureRecordAction: async () => null, futureRecordActionGate: async () => true,
    settleFutureRecordAction: unused,
  } });
  const { AppRunAttemptRunner } = await import('../src/lib/app-run-attempt-runner.js');
  const identity = { org_id: 'org', run_id: 'run', attempt_id: 'attempt', session_id: 'session',
    token_hash: 'synthetic-fingerprint', claim_token: 'claim', sequence: 1 };
  const plaintext = { body: 'synthetic private input' };
  try {
    for (const boundary of ['old first read', 'retained input', 'old raw return', 'committed transaction'] as const) {
      now = new Date(deadline.getTime() - 15_000);
      const run = { id: 'run', org_id: 'org', provider_kind: 'app_runtime', state: 'pending_approval',
        origin_kind: 'human', cancel_requested_at: null, execution_released_at: new Date(now.getTime() - 1),
        input_expires_at: later, result_expires_at: later, retry_class: 'unsafe_or_unknown' };
      const attempt = { id: 'attempt', state: 'claimed', claim_token: 'claim', runtime_session_id: 'session',
        runtime_binding_id: 'binding', runtime_epoch: 1, runtime_session_epoch: 2, runtime_sequence: 1,
        lease_expires_at: later, provider_call_started_at: null as Date | null };
      let entered = false, exactInput: unknown, deliveryRead = false;
      const readStates: string[] = [];
      const tx = {
        execute: async () => ({ rows: [] }),
        select: () => ({ from: (table: unknown) => {
          const rows = () => table === appRuns ? [run] : table === appRunAttempts ? [attempt]
            : table === appVersions ? [{ protocol_version: '6' }] : table === appRunHumanAuthorizations ? [] : [];
          const limited = { for: async () => rows(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows()).then(resolve) };
          return { where: () => ({ limit: () => limited }) };
        } }),
        update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => {
          Object.assign(attempt, values); return [attempt];
        } }) }) }),
      };
      const repository = {
        lockRun: async () => run, appendEvent: async () => {},
        transition: async (_tx: unknown, values: { state: string }) => { run.state = values.state; return run; },
        transaction: async (work: (tx: unknown) => Promise<unknown>) => {
          const value = await work(tx);
          // The actual delivery transaction returns an envelope, not raw input.
          const matched = boundary === 'old raw return' ? deliveryRead && value === exactInput
            : deliveryRead && value && typeof value === 'object' && 'exact' in value && value.exact === exactInput;
          if ((boundary === 'old raw return' || boundary === 'committed transaction') && matched) {
            entered = true; assert.equal(attempt.state, 'provider_call_started'); now = new Date(deadline.getTime() + 1);
          }
          return value;
        },
      };
      const secrets = { readInput: async () => {
        readStates.push(attempt.state);
        deliveryRead = attempt.state === 'provider_call_started';
        if (boundary === 'old first read' || boundary === 'retained input' && deliveryRead) {
          entered = true; now = new Date(deadline.getTime() + 1);
        }
        const value = { ...plaintext };
        if (deliveryRead) exactInput = value;
        return value;
      } };
      const runner = new AppRunAttemptRunner(repository as never, secrets as never, {} as never,
        { execute: unused } as never, undefined, () => now);
      const started = await runner.startRuntimeAttempt(identity);
      if (boundary === 'old first read') {
        assert.equal(started, null); assert.equal(attempt.state, 'claimed', 'preflight expiry must not invent a dispatch marker');
        assert.deepEqual(readStates, ['claimed']);
      } else if (boundary === 'old raw return') {
        assert.equal(entered, false, 'the former raw-value hook never reached the committed delivery envelope');
        assert.deepEqual(started?.input, plaintext);
      } else {
        assert.equal(entered, true, `${boundary} must be reached`); assert.equal(started, null, `${boundary} expiry must deny plaintext`);
        assert.deepEqual(readStates, ['claimed', 'provider_call_started']);
        assert.equal(attempt.state, 'provider_call_started', 'a committed marker remains honest after delivery denial');
        assert.ok(attempt.provider_call_started_at);
      }
    }
  } finally { mock.restoreAll(); }
});
