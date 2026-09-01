import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AppAutomationDefinitionRow,
  AppAutomationFireRow,
} from '../src/lib/app-automation-repository.js';
import {
  scanAppAutomations,
  type AppAutomationFireDecision,
  type AppAutomationScannerPort,
} from '../src/lib/app-automation-scanner.js';

function definition(overrides: Partial<AppAutomationDefinitionRow> = {}): AppAutomationDefinitionRow {
  return {
    id: 'definition-1',
    org_id: 'org-1',
    state: 'active',
    definition_epoch: 2,
    local_time: '09:30',
    timezone: 'Asia/Calcutta',
    valid_from: new Date('2026-08-31T00:00:00.000Z'),
    valid_until: new Date('2026-09-30T00:00:00.000Z'),
    state_changed_at: new Date('2026-08-31T00:00:00.000Z'),
    ...overrides,
  } as AppAutomationDefinitionRow;
}

function fire(
  input: AppAutomationFireDecision,
  overrides: Partial<AppAutomationFireRow> = {},
): AppAutomationFireRow {
  const skipped = input.terminal_reason !== undefined;
  return {
    id: `fire-${input.logical_local_date}`,
    org_id: input.organization_id,
    definition_id: input.definition_id,
    definition_epoch: input.expected_epoch,
    logical_local_date: input.logical_local_date,
    state: skipped ? 'skipped' : 'pending',
    terminal_reason: input.terminal_reason ?? null,
    ...overrides,
  } as AppAutomationFireRow;
}

function scannerPort(
  overrides: Partial<AppAutomationScannerPort> = {},
): AppAutomationScannerPort {
  return {
    listEligibleDefinitions: async () => [],
    listExpiredClaims: async () => [],
    reconcileExpiredClaim: async (value) => value,
    ensureFire: async () => null,
    recoverFire: async (value) => value,
    deliverFire: async () => {},
    ...overrides,
  };
}

test('scanner persists old misfires before enqueuing the one catch-up occurrence', async () => {
  const ensured: AppAutomationFireDecision[] = [];
  const enqueued: string[] = [];
  const result = await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async () => [definition()],
    listExpiredClaims: async () => [],
    reconcileExpiredClaim: async (value) => value,
    ensureFire: async (input) => {
      ensured.push(input);
      return fire(input);
    },
    recoverFire: async (value) => value,
    deliverFire: async (value) => { enqueued.push(value.id); },
  }), new Date('2026-09-01T04:10:00.000Z'));

  assert.deepEqual(ensured.map((value) => [value.logical_local_date, value.terminal_reason]), [
    ['2026-08-31', 'misfire_skipped'],
    ['2026-09-01', undefined],
  ]);
  assert.deepEqual(enqueued, ['fire-2026-09-01']);
  assert.deepEqual(result, {
    definitions: 1, occurrences: 2, pending: 1, skipped: 1, recovered: 0,
  });
});

test('resume boundary excludes the paused occurrence', async () => {
  const ensured: AppAutomationFireDecision[] = [];
  await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async () => [definition({
      state_changed_at: new Date('2026-09-01T04:00:00.000Z'),
    })],
    listExpiredClaims: async () => [],
    reconcileExpiredClaim: async (value) => value,
    ensureFire: async (input) => {
      ensured.push(input);
      return fire(input);
    },
    recoverFire: async (value) => value,
  }), new Date('2026-09-01T04:10:00.000Z'));

  assert.deepEqual(ensured, []);
});

test('eligible definitions page without starving later tenants', async () => {
  const definitions = Array.from({ length: 101 }, (_, index) => definition({
    id: `definition-${String(index).padStart(3, '0')}`,
    org_id: `org-${String(index).padStart(3, '0')}`,
    state_changed_at: new Date('2026-09-01T04:10:00.000Z'),
  }));
  let pages = 0;
  const result = await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async (_now, limit, after) => {
      pages += 1;
      const start = after
        ? definitions.findIndex((value) => value.id === after.definition_id) + 1
        : 0;
      return definitions.slice(start, start + limit);
    },
    listExpiredClaims: async () => [],
    reconcileExpiredClaim: async (value) => value,
    ensureFire: async () => { throw new Error('no occurrence should be eligible'); },
    recoverFire: async (value) => value,
  }), new Date('2026-09-01T04:10:00.000Z'));

  assert.equal(result.definitions, 101);
  assert.equal(pages, 2);
});

test('scanner recovers an expired domain claim even when its old queue row is gone', async () => {
  let recovered = false;
  const enqueued: string[] = [];
  await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async () => [definition({
      valid_from: new Date('2026-09-01T03:00:00.000Z'),
      state_changed_at: new Date('2026-09-01T03:00:00.000Z'),
    })],
    listExpiredClaims: async () => [],
    reconcileExpiredClaim: async (value) => value,
    ensureFire: async (input) => fire(input, {
      state: 'claimed',
      attempt_count: 1,
      claim_token: 'expired-token',
      lease_expires_at: new Date('2026-09-01T04:09:00.000Z'),
    }),
    recoverFire: async (value) => {
      recovered = true;
      return { ...value, state: 'pending', claim_token: null, lease_expires_at: null };
    },
    deliverFire: async (value) => { enqueued.push(value.id); },
  }), new Date('2026-09-01T04:10:00.000Z'));

  assert.equal(recovered, true);
  assert.deepEqual(enqueued, ['fire-2026-09-01']);
});

test('expired claims are reconciled even when their definition is no longer eligible', async () => {
  const claimed = fire({
    organization_id: 'org-1',
    definition_id: 'definition-1',
    expected_epoch: 1,
    logical_local_date: '2026-08-31',
    resolution: { kind: 'resolved', resolved_at_utc: new Date('2026-08-31T04:00:00.000Z') },
  }, {
    state: 'claimed',
    attempt_count: 1,
    claim_token: 'expired-token',
    lease_expires_at: new Date('2026-08-31T04:01:00.000Z'),
  });
  let reconciled = false;
  const result = await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async () => [],
    listExpiredClaims: async () => [claimed],
    reconcileExpiredClaim: async (value) => {
      reconciled = true;
      return { ...value, state: 'skipped', terminal_reason: 'definition_ineligible' };
    },
    ensureFire: async () => null,
    recoverFire: async () => null,
  }), new Date('2026-09-01T04:10:00.000Z'));

  assert.equal(reconciled, true);
  assert.equal(result.recovered, 1);
});

test('delivery delegates terminal queue recovery through one atomic port operation', async () => {
  const pending = fire({
    organization_id: 'org-1',
    definition_id: 'definition-1',
    expected_epoch: 2,
    logical_local_date: '2026-09-01',
    resolution: { kind: 'resolved', resolved_at_utc: new Date('2026-09-01T04:00:00.000Z') },
  }, { attempt_count: 2 });
  let charges = 0;

  await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async () => [definition({
      valid_from: new Date('2026-09-01T03:00:00.000Z'),
      state_changed_at: new Date('2026-09-01T03:00:00.000Z'),
    })],
    ensureFire: async () => pending,
    deliverFire: async (value) => {
      charges += 1;
      const charged = {
        ...value,
        state: 'dead_letter',
        attempt_count: 3,
        terminal_reason: 'attempts_exhausted',
      } as AppAutomationFireRow;
      assert.equal(charged.state, 'dead_letter');
    },
  }), new Date('2026-09-01T04:10:00.000Z'));

  assert.equal(charges, 1);
});
