import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppAutomationDefinitionRow, AppAutomationFireRow } from '../src/lib/app-automation-repository.js';
import { scanAppAutomationSlice, type AppAutomationSlicePort } from '../src/lib/app-automation-scan-slice.js';
import { initialAppAutomationScanProgress, parseAppAutomationScanProgress } from '../src/lib/app-automation-scan-progress.js';

const now = new Date('2038-01-30T10:01:00Z');
const definition = { id: 'definition', org_id: 'tenant', definition_epoch: 1, state: 'active',
  valid_from: new Date('2038-01-01T09:00:00Z'), state_changed_at: new Date('2038-01-01T09:00:00Z'),
  valid_until: new Date('2038-01-31T09:00:00Z'), local_time: '10:00', timezone: 'UTC' } as AppAutomationDefinitionRow;
function port(overrides: Partial<AppAutomationSlicePort> = {}): AppAutomationSlicePort {
  return { listEligibleDefinitions: async () => [], loadDefinition: async () => definition,
    listUnsettledFires: async () => [], reconcileFire: async () => {}, ensureFire: async () => null,
    deliverFire: async () => {}, save: async () => {}, ...overrides };
}
const options = () => ({ now: () => now, deadline: performance.now() + 10_000 });

test('A05 continuation interleaves more than100 recovery fires with single definition occurrence decisions', async () => {
  const events: string[] = [];
  const fires = Array.from({ length: 105 }, (_, index) => ({ id: String(index).padStart(3, '0'), org_id: 'tenant' } as AppAutomationFireRow));
  const result = await scanAppAutomationSlice(port({
    listEligibleDefinitions: async (_at, _limit, after) => after ? [] : [definition],
    listUnsettledFires: async (_at, limit, after) => fires.filter(fire => !after || fire.id > after.fire_id).slice(0, limit),
    reconcileFire: async fire => { events.push(`fire:${fire.id}`); },
    ensureFire: async input => { events.push(`date:${input.logical_local_date}`); return null; },
  }), initialAppAutomationScanProgress(), options());
  assert.equal(result.state, 'complete'); assert.equal(result.fireItems, 105); assert.equal(result.decisions, 30);
  assert.deepEqual(events.slice(0, 4), ['fire:000', 'date:2038-01-01', 'fire:001', 'date:2038-01-02']);
});

test('A05 partial logical history resumes after settled progress and safely replays before progress', async () => {
  let saved = initialAppAutomationScanProgress();
  const decided: string[] = [];
  const controller = new AbortController();
  const reason = new Error('worker stopped between work and progress');
  let interrupted = false;
  const original = port({
    listEligibleDefinitions: async (_at, _limit, after) => after ? [] : [definition],
    ensureFire: async input => { decided.push(input.logical_local_date); return null; },
    save: async progress => {
      if (progress.definitions.partial?.next_logical_local_date === '2038-01-03' && !interrupted) {
        interrupted = true; controller.abort(reason); throw reason;
      }
      saved = structuredClone(progress);
    },
  });
  await assert.rejects(scanAppAutomationSlice(original, saved, { ...options(), signal: controller.signal }), error => error === reason);
  assert.equal(saved.definitions.partial?.next_logical_local_date, '2038-01-02');
  assert.equal(saved.definitions.after, null);
  await scanAppAutomationSlice(original, saved, options());
  assert.deepEqual(decided.slice(0, 4), ['2038-01-01', '2038-01-02', '2038-01-02', '2038-01-03']);
  assert.equal(saved.complete, true);
});

test('A05 catalog failure preserves its cursor while another lane progresses then backs off without progress', async () => {
  let saved = initialAppAutomationScanProgress();
  saved.fires.after = { organization_id: 'tenant', fire_id: 'old' };
  const outage = port({ listUnsettledFires: async () => { throw new Error('catalog locked'); },
    save: async progress => { saved = structuredClone(progress); } });
  const result = await scanAppAutomationSlice(outage, saved, options());
  assert.equal(result.state, 'partial'); assert.equal(saved.definitions.done, true);
  assert.deepEqual(saved.fires.after, { organization_id: 'tenant', fire_id: 'old' });
  await assert.rejects(scanAppAutomationSlice(outage, saved, options()), /catalog unavailable/);
});

test('A05 failed occurrence advances the definition hint and stale partial epoch discards obsolete history', async () => {
  let saved = initialAppAutomationScanProgress();
  const oneDay = { ...definition, valid_from: new Date('2038-01-30T09:00:00Z'), state_changed_at: new Date('2038-01-30T09:00:00Z') };
  await scanAppAutomationSlice(port({
    listEligibleDefinitions: async (_at, _limit, after) => after ? [] : [oneDay],
    ensureFire: async () => { throw new Error('item locked'); },
    save: async progress => { saved = structuredClone(progress); },
  }), saved, options());
  assert.deepEqual(saved.definitions.after, { organization_id: 'tenant', definition_id: 'definition' });
  saved = initialAppAutomationScanProgress();
  saved.definitions.partial = { organization_id: 'tenant', definition_id: 'definition', definition_epoch: 99, next_logical_local_date: '2038-01-02' };
  let decisions = 0;
  await scanAppAutomationSlice(port({ ensureFire: async () => { decisions++; return null; },
    save: async progress => { saved = structuredClone(progress); } }), saved, options());
  assert.equal(decisions, 0); assert.equal(saved.definitions.partial, null); assert.equal(saved.complete, true);
});

test('A05 invalid version oversized cursor and invalid logical date restart bounded progress', () => {
  const progress = initialAppAutomationScanProgress();
  for (const invalid of [ { ...progress, version: 2 },
    { ...progress, fires: { done: false, after: { organization_id: 'x'.repeat(257), fire_id: 'f' } } },
    { ...progress, definitions: { done: false, after: null, partial: { organization_id: 'o', definition_id: 'd', definition_epoch: 1, next_logical_local_date: '2038-02-30' } } } ]) {
    assert.deepEqual(parseAppAutomationScanProgress({ automation_scan: invalid }), initialAppAutomationScanProgress());
  }
});
