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
    errors: { definitions: 0, occurrences: 0, expired_claims: 0, deliveries: 0 },
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
  assert.equal(result.errors.occurrences, 0, 'no occurrence is eligible at the resume boundary');
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

test('scanner isolates recurring delivery failures and reaches later tenants across keyset pages', async () => {
  const definitions = Array.from({ length: 101 }, (_, i) => definition({
    id: `definition-${String(i).padStart(3, '0')}`, org_id: `org-${String(i).padStart(3, '0')}`,
    valid_from: new Date('2026-09-01T03:00:00Z'), state_changed_at: new Date('2026-09-01T03:00:00Z'),
  }));
  const ledger = new Map<string, AppAutomationFireRow>();
  const delivered: string[] = [];
  let pages = 0;
  const port = scannerPort({
    listEligibleDefinitions: async (_now, limit, after) => {
      pages++;
      const start = after ? definitions.findIndex(row => row.id === after.definition_id) + 1 : 0;
      return definitions.slice(start, start + limit);
    },
    ensureFire: async input => {
      const identity = `${input.definition_id}:${input.expected_epoch}:${input.logical_local_date}`;
      if (!ledger.has(identity)) ledger.set(identity, fire(input, { id: identity }));
      return ledger.get(identity)!;
    },
    deliverFire: async row => {
      if (row.definition_id === definitions[0]!.id || row.definition_id === definitions[99]!.id) throw Error('private synthetic queue detail');
      delivered.push(row.definition_id);
    },
  });
  for (let retry = 0; retry < 3; retry++) {
    const result = await scanAppAutomations(port, new Date('2026-09-01T04:10:00Z'));
    assert.equal(result.definitions, 101);
    assert.equal(result.errors.deliveries, 2);
    assert.ok(!JSON.stringify(result).includes('private synthetic queue detail'));
  }
  assert.equal(pages, 6);
  assert.equal(ledger.size, 101, 'retry preserves occurrence identity rather than manufacturing replacement work');
  assert.equal(delivered.length, 99 * 3);
  assert.equal(delivered.filter(id => id === definitions[100]!.id).length, 3, 'last tenant reached on every scan');
});

test('scanner isolates expired claim failures across pages before serving eligible definitions', async () => {
  const expired = Array.from({ length: 101 }, (_, i) => fire({
    organization_id: `org-${i}`, definition_id: `definition-${i}`, expected_epoch: 1,
    logical_local_date: '2026-09-01', resolution: { kind: 'resolved', resolved_at_utc: new Date('2026-09-01T04:00:00Z') },
  }, { id: `expired-${i}`, state: 'claimed' }));
  let pages = 0;
  const delivered: string[] = [];
  const result = await scanAppAutomations(scannerPort({
    listExpiredClaims: async (_now, limit, after) => {
      pages++;
      const start = after ? expired.findIndex(row => row.id === after.fire_id) + 1 : 0;
      return expired.slice(start, start + limit);
    },
    reconcileExpiredClaim: async row => {
      if (row.id === expired[0]!.id) throw Error('synthetic reconciliation failure');
      return { ...row, state: 'pending' };
    },
    listEligibleDefinitions: async () => [definition({ valid_from: new Date('2026-09-01T03:00:00Z'), state_changed_at: new Date('2026-09-01T03:00:00Z') })],
    ensureFire: async input => fire(input, { id: 'new-healthy-fire' }),
    deliverFire: async row => {
      if (row.id === expired[1]!.id) throw Error('synthetic queue failure');
      delivered.push(row.id);
    },
  }), new Date('2026-09-01T04:10:00Z'));
  assert.equal(pages, 2);
  assert.equal(result.recovered, 100, 'successful reconciliation remains observed when queue delivery fails');
  assert.deepEqual(result.errors, { definitions: 0, occurrences: 0, expired_claims: 1, deliveries: 1 });
  assert.ok(delivered.includes(expired[100]!.id));
  assert.ok(delivered.includes('new-healthy-fire'));
});

test('scanner isolates malformed definitions and occurrence persistence or recovery errors without widening eligibility', async () => {
  const delivered: string[] = [];
  const result = await scanAppAutomations(scannerPort({
    listEligibleDefinitions: async () => [definition({ id: 'malformed', timezone: 'invalid-zone' }),
      definition({ id: 'persistence' }), definition({ id: 'recovery', valid_from: new Date('2026-09-01T03:00:00Z'), state_changed_at: new Date('2026-09-01T03:00:00Z') }),
      definition({ id: 'denied' }), definition({ id: 'healthy' })],
    ensureFire: async input => {
      if (input.definition_id === 'denied') return null;
      if (input.definition_id === 'persistence' && input.logical_local_date === '2026-08-31') throw Error('synthetic persistence failure');
      return fire(input, { id: `${input.definition_id}:${input.logical_local_date}`,
        ...(input.definition_id === 'recovery' ? { state: 'claimed', claim_token: 'expired', lease_expires_at: new Date('2026-09-01T04:00:00Z') } : {}) });
    },
    recoverFire: async () => { throw Error('synthetic recovery failure'); },
    deliverFire: async row => { delivered.push(row.id); },
  }), new Date('2026-09-01T04:10:00Z'));
  assert.deepEqual(result.errors, { definitions: 1, occurrences: 2, expired_claims: 0, deliveries: 0 });
  assert.deepEqual(delivered, ['persistence:2026-09-01', 'healthy:2026-09-01']);
  assert.equal(result.skipped, 1, 'healthy older occurrence remains a misfire rather than a new effect');
});

test('scanner keeps catalog listing failures visible rather than advancing an unknown page', async () => {
  const outage = new Error('synthetic listing outage');
  await assert.rejects(scanAppAutomations(scannerPort({ listExpiredClaims: async () => { throw outage; } })), error => error === outage);
  await assert.rejects(scanAppAutomations(scannerPort({ listEligibleDefinitions: async () => { throw outage; } })), error => error === outage);
});
test('scanner propagates explicit cancellation from item work without starting later writes', async () => {
  const cancelled = new Error('scan cancelled');
  cancelled.name = 'AbortError';
  for (const stage of ['reconcile', 'ensure', 'recover', 'deliver'] as const) {
    const visited: string[] = [];
    const claimed = fire({ organization_id: 'org-1', definition_id: 'first', expected_epoch: 1,
      logical_local_date: '2026-09-01', resolution: { kind: 'resolved', resolved_at_utc: new Date('2026-09-01T04:00:00Z') } },
      { state: 'claimed', claim_token: 'expired', lease_expires_at: new Date('2026-09-01T04:00:00Z') });
    await assert.rejects(scanAppAutomations(scannerPort({
      listExpiredClaims: async () => stage === 'reconcile' ? [claimed] : [],
      reconcileExpiredClaim: async () => { throw cancelled; },
      listEligibleDefinitions: async () => ['first', 'later'].map(id => definition({ id,
        valid_from: new Date('2026-09-01T03:00:00Z'), state_changed_at: new Date('2026-09-01T03:00:00Z') })),
      ensureFire: async input => {
        visited.push(input.definition_id);
        if (stage === 'ensure') throw cancelled;
        return stage === 'recover' ? claimed : fire(input);
      },
      recoverFire: async () => { throw cancelled; },
      deliverFire: async () => { throw cancelled; },
    }), new Date('2026-09-01T04:10:00Z')), error => error === cancelled);
    assert.ok(!visited.includes('later'));
  }
});

test('scanner propagates worker signals with arbitrary reasons at every awaited item boundary', async () => {
  for (const reason of [new Error('worker lease lost'), 'host shutdown']) {
    for (const stage of ['reconcile', 'ensure', 'recover', 'deliver'] as const) {
      const controller = new AbortController();
      const visited: string[] = [];
      const abort = (): never => { controller.abort(reason); throw new Error('underlying I/O settled'); };
      const claimed = fire({ organization_id: 'org-1', definition_id: 'first', expected_epoch: 1,
        logical_local_date: '2026-09-01', resolution: { kind: 'resolved', resolved_at_utc: new Date('2026-09-01T04:00:00Z') } },
        { state: 'claimed', claim_token: 'expired', lease_expires_at: new Date('2026-09-01T04:00:00Z') });
      await assert.rejects(scanAppAutomations(scannerPort({
        listExpiredClaims: async () => stage === 'reconcile' ? [claimed] : [],
        reconcileExpiredClaim: async () => abort(),
        listEligibleDefinitions: async () => ['first', 'later'].map(id => definition({ id,
          valid_from: new Date('2026-09-01T03:00:00Z'), state_changed_at: new Date('2026-09-01T03:00:00Z') })),
        ensureFire: async input => {
          visited.push(input.definition_id);
          if (stage === 'ensure') abort();
          return stage === 'recover' ? claimed : fire(input);
        },
        recoverFire: async () => abort(),
        deliverFire: async () => abort(),
      }), new Date('2026-09-01T04:10:00Z'), { signal: controller.signal }), error => error === reason);
      assert.ok(!visited.includes('later'));
    }
  }
});
