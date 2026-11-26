/**
 * The size cap's accounting (plan Task F7, review rounds 4 and 5):
 * collab/size-account.ts.
 * - The invariant: after any interleaving of admissions, applies, drops,
 *   reservations and measurements, the estimate is at least the true
 *   normalized size of the live state. The true size is modelled: every
 *   admitted change grows the normalized size by at most its charge, and may
 *   shrink it by any amount.
 * - The charge holds that bound for real updates: for every node type and
 *   mark in the document schema, and for changes to existing blocks' ids,
 *   an update's charge is at least the growth normalization gives it.
 * - The account keeps the same few entries however many changes pass.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/collab-size-account.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { applyJsonToYDoc, ensureBlockIds, getDocumentSchema, jsonToYDoc, yDocToJson } from '@deft/doc-schema';
import { setCollabLimitsForTest } from '../src/collab/limits.js';
import * as sizeAccount from '../src/collab/size-account.js';

const { chargeFor, SizeAccount } = sizeAccount;

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

type InFlight = { seq: number; growth: number; applied: boolean; measurement: { bytes: number; covered: number } | null };

/**
 * One random interleaving. A change is admitted with a charge (fast, or
 * measured on a scratch copy that holds it: the frame path and the writer's
 * reservation), then later applied and settled (a moment apart, as
 * Hocuspocus applies a frame a few microtasks before afterHandleMessage
 * settles it) or dropped, in any order relative to other changes. A store
 * measures the live state now and re-bases later, after any number of other
 * steps. Some measurements are inexact and never re-base.
 */
function interleaving(seed: number, steps: number): void {
  const rand = generator(seed);
  let live = rand.int(0, 20_000);
  const account = new SizeAccount(live);
  const inFlight: InFlight[] = [];
  const storesWriting: Array<{ bytes: number; covered: number }> = [];
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
      // Admission: a frame (fast, or measured) or a writer's reservation; a charge of 0 too.
      const charge = rand.next() < 0.1 ? 0 : rand.int(1, 20_000);
      const growth = rand.next() < 0.25 ? -rand.int(0, Math.max(0, Math.floor(live / 3))) : rand.int(0, charge);
      const seq = account.admit(charge);
      const measured = rand.next() < 0.5;
      const exact = rand.next() < 0.8;
      // A scratch copy holds the live state as it is now plus this change.
      inFlight.push({ seq, growth, applied: false, measurement: measured && exact ? { bytes: live + growth, covered: account.covered(seq) } : null });
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
      if (change.measurement) account.rebase(change.measurement.bytes, change.measurement.covered);
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
      storesWriting.push({ bytes: live, covered: account.covered() });
    } else if (storesWriting.length > 0) {
      // A store's write finishes, in any order: an exact (derived) one re-bases.
      const store = storesWriting.splice(rand.int(0, storesWriting.length - 1), 1)[0]!;
      if (rand.next() < 0.7) account.rebase(store.bytes, store.covered);
      check(step, 'store');
    }
  }
}

test('after any interleaving, the estimate is at least the true normalized size', () => {
  for (let seed = 1; seed <= 400; seed += 1) interleaving(seed, 300);
});

test('a store measured before a frame cannot lower the estimate below that frame\'s later measurement (review round 3, finding b)', () => {
  const account = new SizeAccount(0);
  for (let k = 0; k < 4; k += 1) account.settle(account.admit(13_600));
  assert.equal(account.estimate, 4 * 13_600);
  const store = { bytes: 13_600, covered: account.covered() };
  const frame = account.admit(60_000);
  const measured = { bytes: 61_700, covered: account.covered(frame) };
  account.settle(frame);
  account.rebase(measured.bytes, measured.covered);
  account.rebase(store.bytes, store.covered);
  assert.equal(account.estimate, 61_700, 'the older, looser bound is ignored');
});

test('a measurement keeps the charges after it on top', () => {
  const account = new SizeAccount(5_000);
  const first = account.admit(400);
  const inFlight = account.covered();
  assert.equal(account.estimate, 5_400);
  account.settle(first);
  const atEncode = account.covered();
  assert.equal(atEncode - inFlight, 400, 'an admission in flight is not covered by a measurement of the live state');
  const second = account.admit(800);
  account.settle(second);
  account.rebase(1_500, atEncode);
  assert.equal(account.estimate, 1_500 + 800);
  // A looser bound than the estimate leaves it as it is.
  account.rebase(3_000, atEncode);
  assert.equal(account.estimate, 1_500 + 800);
});

test('a dropped admission gives its charge back', () => {
  const account = new SizeAccount(5_000);
  const seq = account.admit(4_000);
  assert.equal(account.estimate, 9_000);
  account.settle(seq, false);
  assert.equal(account.estimate, 5_000);
});

test('the fast path holds only while the bound with the charge stays below 90% of the cap', (t) => {
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const threshold = Math.floor(65_536 * 0.9);
  const account = new SizeAccount(threshold - 1_001);
  assert.equal(account.fitsFast(1_000), true);
  assert.equal(account.fitsFast(1_001), false);
});

// ---------------------------------------------------------------------------
// Review round 5

test('the account keeps the same few entries however many changes pass with nothing exact', () => {
  // As after a struct Yjs holds back: no measurement is exact, so nothing re-bases.
  const account = new SizeAccount(10_000);
  account.settle(account.admit(4_000));
  const retainedAfterOne = account.retained;
  let expected = 14_000;
  for (let k = 0; k < 5_000; k += 1) {
    account.settle(account.admit(2));
    expected += 2;
  }
  assert.equal(account.retained, retainedAfterOne, `the account grew from ${retainedAfterOne} to ${account.retained} entries`);
  assert.ok(account.retained <= 1);
  assert.equal(account.estimate, expected, 'and the estimate still adds every charge');
});

const fragmentOf = (doc: Y.Doc) => doc.getXmlFragment('default');

/** The encoded size `doc` has once normalized as the server does it (deriveContent: ids written back with every attribute default). */
function normalizedSize(doc: Y.Doc): number | null {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const json = yDocToJson(scratch);
    const withIds = ensureBlockIds(json);
    if (JSON.stringify(withIds) !== JSON.stringify(json)) scratch.transact(() => applyJsonToYDoc(scratch, withIds));
    return Y.encodeStateAsUpdate(scratch).byteLength;
  } catch {
    // Content outside the schema: nothing can be written back.
    return null;
  } finally {
    scratch.destroy();
  }
}

/** Normalized growth and charge of the update `change` makes to a copy of `start`, with one block without an id so the write-back runs. */
function chargeAndGrowth(start: Y.Doc, change: (doc: Y.Doc) => void, o: { worstIds?: boolean } = {}) {
  const draft = new Y.Doc();
  const live = new Y.Doc();
  try {
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(start));
    Y.applyUpdate(live, Y.encodeStateAsUpdate(start));
    const before = normalizedSize(draft);
    const vector = Y.encodeStateVector(draft);
    // The largest client id a client can pick, and clocks past 2^21 (4-byte varints).
    if (o.worstIds) draft.clientID = Number.MAX_SAFE_INTEGER;
    draft.transact(() => {
      if (o.worstIds) {
        const pad = draft.getText('pad');
        pad.insert(0, 'x'.repeat(3_000_000));
        pad.delete(0, 3_000_000);
      }
      change(draft);
      fragmentOf(draft).push([new Y.XmlElement('paragraph')]);
    });
    const update = Y.encodeStateAsUpdate(draft, vector);
    const after = normalizedSize(draft);
    return { charge: chargeFor(update, live), growth: before === null || after === null ? null : after - before, bytes: update.byteLength };
  } finally {
    draft.destroy();
    live.destroy();
  }
}

/** A normalized document of `n` blocks of `type`, ids written back by the document's own client (consecutive clocks). */
function normalizedBlocks(type: string, n: number): Y.Doc {
  const doc = jsonToYDoc({ type: 'doc', content: Array.from({ length: n }, () => ({ type })) });
  const withIds = ensureBlockIds(yDocToJson(doc));
  doc.transact(() => applyJsonToYDoc(doc, withIds));
  return doc;
}

test('for every node type and mark in the schema, and for changes to existing ids, an update is charged at least the growth normalization gives it', () => {
  const N = 300;
  const base = normalizedBlocks('paragraph', 1);
  const schema = getDocumentSchema();
  const short: string[] = [];
  const checked: string[] = [];
  const expect = (scenario: string, r: { charge: number; growth: number | null; bytes: number }) => {
    if (r.growth === null) return;
    checked.push(scenario);
    if (r.charge < r.growth) short.push(`${scenario}: charged ${r.charge} for ${r.bytes} bytes, normalization grows it by ${r.growth}`);
  };
  for (const name of Object.keys(schema.nodes)) {
    if (name === 'doc' || name === 'text') continue;
    expect(`${N} empty ${name}`, chargeAndGrowth(base, (d) => {
      for (let k = 0; k < N; k += 1) fragmentOf(d).push([new Y.XmlElement(name)]);
    }));
    if (schema.nodes[name]!.isInline) {
      expect(`${N} empty ${name} in a paragraph`, chargeAndGrowth(base, (d) => {
        const paragraph = new Y.XmlElement('paragraph');
        fragmentOf(d).push([paragraph]);
        for (let k = 0; k < N; k += 1) paragraph.push([new Y.XmlElement(name)]);
      }));
    }
  }
  for (const mark of Object.keys(schema.marks)) {
    expect(`${N} text runs marked ${mark} with no attributes`, chargeAndGrowth(base, (d) => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      fragmentOf(d).push([paragraph]);
      for (let k = 0; k < N; k += 1) {
        text.insert(text.length, 'a', { [mark]: {} });
        text.insert(text.length, 'b', { [mark]: null });
      }
    }));
  }
  for (const name of ['callout', 'heading', 'orderedList', 'paragraph']) {
    expect(`${N} empty ${name}, from the worst client id and clock`, chargeAndGrowth(base, (d) => {
      for (let k = 0; k < N; k += 1) fragmentOf(d).push([new Y.XmlElement(name)]);
    }, { worstIds: true }));
  }
  const elements = (d: Y.Doc) => fragmentOf(d).toArray() as Y.XmlElement[];
  for (const type of ['paragraph', 'heading', 'callout']) {
    const blocks = normalizedBlocks(type, N);
    expect(`${N} ${type} ids removed (consecutive clocks)`, chargeAndGrowth(blocks, (d) => { for (const el of elements(d)) el.removeAttribute('id'); }));
    expect(`${N} ${type}: every attribute removed`, chargeAndGrowth(blocks, (d) => {
      for (const el of elements(d)) for (const key of Object.keys(el.getAttributes())) el.removeAttribute(key);
    }));
    expect(`${N} ${type} ids overwritten with an invalid one`, chargeAndGrowth(blocks, (d) => { for (const el of elements(d)) el.setAttribute('id', 'x'); }));
    expect(`${N} new ${type} taking existing ids`, chargeAndGrowth(blocks, (d) => {
      for (const id of elements(d).map((el) => el.getAttribute('id'))) {
        const block = new Y.XmlElement(type);
        block.setAttribute('id', id as string);
        fragmentOf(d).insert(0, [block]);
      }
    }));
    blocks.destroy();
  }
  base.destroy();
  assert.ok(checked.length > 30, `scenarios that normalize: ${checked.length}`);
  assert.deepEqual(short, [], short.join('\n'));
});
