import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchAppAutomationFire,
  type AppAutomationDispatchPort,
  type AppAutomationFireDelivery,
} from '../src/lib/app-automation-dispatch.js';
import { AppError } from '../src/lib/app-errors.js';
import type { AppAutomationFireRow } from '../src/lib/app-automation-repository.js';
import { RetryLaterJobError } from '../src/lib/queues.js';

const now = new Date('2026-09-01T04:10:00.000Z');
const delivery: AppAutomationFireDelivery = {
  job_id: 'job-1',
  lease_expires_at: new Date('2026-09-01T04:11:00.000Z'),
  organization_id: 'org-1',
  definition_id: 'definition-1',
  fire_id: 'fire-1',
  definition_epoch: 2,
};

function fire(overrides: Partial<AppAutomationFireRow> = {}): AppAutomationFireRow {
  return {
    id: 'fire-1',
    org_id: 'org-1',
    definition_id: 'definition-1',
    definition_epoch: 2,
    state: 'pending',
    attempt_count: 0,
    resolved_at_utc: now,
    ...overrides,
  } as AppAutomationFireRow;
}

function port(overrides: Partial<AppAutomationDispatchPort> = {}): AppAutomationDispatchPort {
  return {
    enabled: () => true,
    newClaimToken: () => 'claim-1',
    preflight: async () => {},
    load: async () => fire(),
    recover: async () => fire(),
    claim: async () => fire({ state: 'claimed', attempt_count: 1, claim_token: 'claim-1' }),
    terminalize: async () => fire({ state: 'skipped', terminal_reason: 'definition_ineligible' }),
    terminalizeMisfire: async () => fire({ state: 'skipped', terminal_reason: 'misfire_skipped' }),
    settleFailure: async () => fire({ state: 'pending', attempt_count: 1 }),
    invoke: async () => {},
    ...overrides,
  };
}

test('disabled automation delivery defers without reading authority', async () => {
  let loaded = false;
  await assert.rejects(dispatchAppAutomationFire(port({
    enabled: () => false,
    load: async () => { loaded = true; return fire(); },
  }), delivery, now), RetryLaterJobError);
  assert.equal(loaded, false);
});

test('pending delivery claims with the queue lease and invokes the exact fire', async () => {
  const calls: unknown[] = [];
  await dispatchAppAutomationFire(port({
    claim: async (input) => {
      calls.push(input);
      return fire({ state: 'claimed', attempt_count: 1, claim_token: input.claim_token });
    },
    invoke: async (input) => { calls.push(input); },
  }), delivery, now);

  assert.deepEqual(calls, [{
    organization_id: 'org-1',
    definition_id: 'definition-1',
    fire_id: 'fire-1',
    expected_epoch: 2,
    claim_owner: 'job:job-1',
    claim_token: 'claim-1',
    claimed_at: now,
    lease_expires_at: delivery.lease_expires_at,
  }, {
    organization_id: 'org-1',
    definition_id: 'definition-1',
    fire_id: 'fire-1',
    claim_token: 'claim-1',
  }]);
});

test('a live prior claim defers, while a run-created replay is a no-op', async () => {
  await assert.rejects(dispatchAppAutomationFire(port({
    load: async () => fire({
      state: 'claimed',
      claim_token: 'prior',
      lease_expires_at: new Date('2026-09-01T04:10:30.000Z'),
    }),
  }), delivery, now), RetryLaterJobError);

  let invoked = false;
  await dispatchAppAutomationFire(port({
    load: async () => fire({ state: 'run_created', app_run_id: 'run-1' }),
    invoke: async () => { invoked = true; },
  }), delivery, now);
  assert.equal(invoked, false);
});

test('a pause or kill after preflight terminalizes only the exact claimed fire', async () => {
  const calls: string[] = [];
  await dispatchAppAutomationFire(port({
    preflight: async () => { calls.push('preflight'); },
    claim: async (input) => {
      calls.push('claim');
      return fire({ state: 'claimed', attempt_count: 1, claim_token: input.claim_token });
    },
    invoke: async () => {
      calls.push('invoke');
      throw new AppError('stale', 'APP_STALE', 409);
    },
    terminalize: async (input) => {
      calls.push('terminalize');
      assert.equal(input.expected_state, 'claimed');
      assert.equal(input.expected_claim_token, 'claim-1');
      assert.equal(input.expected_epoch, delivery.definition_epoch);
      return fire({ state: 'skipped', terminal_reason: 'definition_ineligible' });
    },
  }), delivery, now);
  assert.deepEqual(calls, ['preflight', 'claim', 'invoke', 'terminalize']);
});

test('a transient invocation failure releases the exact claim for bounded recovery', async () => {
  const failure = new Error('temporary');
  let settled = false;
  await assert.rejects(dispatchAppAutomationFire(port({
    invoke: async () => { throw failure; },
    settleFailure: async (input) => {
      assert.equal(input.expected_claim_token, 'claim-1');
      assert.equal(input.expected_epoch, delivery.definition_epoch);
      settled = true;
      return fire({ state: 'pending', attempt_count: 1 });
    },
  }), delivery, now), failure);
  assert.equal(settled, true);
});

test('late first delivery becomes a misfire before preflight or claim', async () => {
  let preflight = false;
  let claimed = false;
  let misfire = false;
  await dispatchAppAutomationFire(port({
    load: async () => fire({ resolved_at_utc: new Date('2026-09-01T03:54:59.000Z') }),
    preflight: async () => { preflight = true; },
    claim: async () => { claimed = true; return null; },
    terminalizeMisfire: async () => {
      misfire = true;
      return fire({ state: 'skipped', terminal_reason: 'misfire_skipped' });
    },
  }), delivery, now);

  assert.equal(misfire, true);
  assert.equal(preflight, false);
  assert.equal(claimed, false);
});

test('stale preflight terminalizes pending authority without consuming an attempt', async () => {
  let claimed = false;
  let terminalized = false;
  await dispatchAppAutomationFire(port({
    preflight: async () => { throw new AppError('stale', 'APP_STALE', 409); },
    claim: async () => { claimed = true; return null; },
    terminalize: async () => {
      terminalized = true;
      return fire({ state: 'skipped', terminal_reason: 'definition_ineligible' });
    },
  }), delivery, now);

  assert.equal(terminalized, true);
  assert.equal(claimed, false);
});
