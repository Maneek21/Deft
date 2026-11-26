/**
 * The size cap's accounting (plan Task F7, review round 4): collab/size-account.ts.
 * The invariant: after any interleaving of admissions, applies, drops,
 * reservations and measurements, the estimate is at least the true
 * normalized size of the live state. The true size is modelled: every
 * admitted change grows the normalized size by at most its charge (the
 * ID_GROWTH bound the live server measured), and may shrink it by any amount.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/collab-size-account.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setCollabLimitsForTest } from '../src/collab/limits.js';
import { chargeFor, ID_GROWTH, SizeAccount } from '../src/collab/size-account.js';

/** A small deterministic generator (mulberry32), so a failing interleaving can be replayed by its seed. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

type InFlight = { seq: number; growth: number; applied: boolean; measurement: { bytes: number; covers: number } | null };

/**
 * One random interleaving. A change is admitted (fast, or measured on a
 * scratch copy that holds it: the frame path and the writer's reservation),
 * then later applied and settled (a moment apart, as Hocuspocus applies a
 * frame a few microtasks before afterHandleMessage settles it) or dropped,
 * in any order relative to other changes. A store measures the live state
 * now and re-bases later, after any number of other steps. Some
 * measurements are inexact and never re-base.
 */
function interleaving(seed: number, steps: number): void {
  const rand = generator(seed);
  let live = rand.int(0, 20_000);
  const account = new SizeAccount(live);
  const inFlight: InFlight[] = [];
  const storesWriting: Array<{ bytes: number; covers: number }> = [];
  const check = (step: number, what: string) => {
    assert.ok(account.estimate >= live,
      `seed ${seed}, step ${step} (${what}): estimate ${account.estimate} is below the true normalized size ${live}`);
  };
  const some = (applied: boolean) => {
    const candidates = inFlight.filter((change) => change.applied === applied);
    return candidates.length > 0 ? rand.pick(candidates) : null;
  };
  for (let step = 0; step < steps; step += 1) {
    const roll = rand.next();
    if (roll < 0.3) {
      // Admission: a frame (fast, or measured) or a writer's reservation.
      const bytes = rand.int(1, 6_000);
      const growth = rand.next() < 0.25 ? -rand.int(0, Math.max(0, Math.floor(live / 3))) : rand.int(0, chargeFor(bytes));
      const seq = account.admit(bytes);
      const measured = rand.next() < 0.5;
      const exact = rand.next() < 0.8;
      // A scratch copy holds the live state as it is now plus this change.
      inFlight.push({ seq, growth, applied: false, measurement: measured && exact ? { bytes: live + growth, covers: account.covers(seq) } : null });
      check(step, 'admit');
    } else if (roll < 0.45) {
      // Applied to the live document, not yet settled.
      const change = some(false);
      if (!change) continue;
      change.applied = true;
      live += change.growth;
      check(step, 'apply');
    } else if (roll < 0.58) {
      // Settled after it was applied; its measurement re-bases then, as afterHandleMessage does.
      const change = some(true);
      if (!change) continue;
      inFlight.splice(inFlight.indexOf(change), 1);
      account.settle(change.seq);
      if (change.measurement) account.rebase(change.measurement.bytes, change.measurement.covers);
      check(step, 'settle');
    } else if (roll < 0.64) {
      // Dropped after admission (a late refusal, a failed write): never applied.
      const change = some(false);
      if (!change) continue;
      inFlight.splice(inFlight.indexOf(change), 1);
      account.settle(change.seq, false);
      check(step, 'drop');
    } else if (roll < 0.8) {
      // A store encodes the live state now; its write is awaited.
      storesWriting.push({ bytes: live, covers: account.covers() });
    } else if (storesWriting.length > 0) {
      // A store's write finishes, in any order: an exact (derived) one re-bases.
      const store = storesWriting.splice(rand.int(0, storesWriting.length - 1), 1)[0]!;
      if (rand.next() < 0.7) account.rebase(store.bytes, store.covers);
      check(step, 'store');
    }
  }
}

test('after any interleaving, the estimate is at least the true normalized size', () => {
  for (let seed = 1; seed <= 400; seed += 1) interleaving(seed, 300);
});

test('a store measured before a frame cannot lower the estimate below that frame\'s later measurement (review finding b)', () => {
  // At test limits: fast frames of text that already has ids, then a store
  // encodes, then a frame of blocks without ids is measured during its write.
  const account = new SizeAccount(0);
  for (let k = 0; k < 4; k += 1) account.settle(account.admit(3_400));
  assert.equal(account.estimate, 4 * chargeFor(3_400));
  const store = { bytes: 13_600, covers: account.covers() };
  const frame = account.admit(13_000);
  const measured = { bytes: 61_700, covers: account.covers(frame) };
  account.settle(frame);
  account.rebase(measured.bytes, measured.covers);
  account.rebase(store.bytes, store.covers);
  assert.equal(account.estimate, 61_700, 'the older measurement is ignored');
});

test('a measurement keeps the admissions after it on top', () => {
  const account = new SizeAccount(1_000);
  const first = account.admit(100);
  const covers = account.covers();
  assert.equal(covers, 0, 'an admission not yet applied is not covered by a measurement of the live state');
  account.settle(first);
  const atEncode = account.covers();
  const second = account.admit(200);
  account.settle(second);
  account.rebase(1_500, atEncode);
  assert.equal(account.estimate, 1_500 + chargeFor(200));
});

test('a dropped admission gives its charge back; a measurement of a dropped frame is never used', () => {
  const account = new SizeAccount(5_000);
  const seq = account.admit(1_000);
  assert.equal(account.estimate, 5_000 + chargeFor(1_000));
  account.settle(seq, false);
  assert.equal(account.estimate, 5_000);
  assert.equal(account.covers(), seq, 'nothing is waiting');
});

test('the fast path holds only while the bound with the change stays below 90% of the cap', (t) => {
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const threshold = Math.floor(65_536 * 0.9);
  const account = new SizeAccount(threshold - chargeFor(1_000) - 1);
  assert.equal(account.fitsFast(1_000), true);
  assert.equal(account.fitsFast(1_001), false);
  assert.equal(ID_GROWTH, 3);
});
