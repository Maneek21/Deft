// The size cap's accounting (plan Task F7, review round 4): one upper bound
// on a live document's normalized size, the encoded size its Yjs state has
// once the server has written every block id back (the next derive does).
//
// The invariant: the estimate is the last exact normalized measurement plus,
// for every change admitted since that measurement, the change's bytes ×
// (1 + ID_GROWTH), the most its block ids can add once written back.
//
// - A change is charged when it is admitted (a socket frame on the fast or
//   the measured path, a writer's reservation), never when Yjs integrates it:
//   Yjs holds back an update whose structs wait for a missing clock and fires
//   no event for it, then integrates it all at once when the missing struct
//   arrives. Held-back structs are charged like any other change.
// - Each admission gets a sequence number. It is settled once it has been
//   applied to the live document (or dropped: it never will be, and its
//   charge goes).
// - A measurement records the admissions it covers. A measurement of the
//   live document covers every admission before the first one not yet
//   settled (that one isn't in the state measured); a scratch copy with an
//   admitted change applied also covers that change.
// - Only an exact measurement re-bases: the copy derived (no content outside
//   the schema) and Yjs held nothing back, so its encoded size is the
//   normalized size. A re-base replaces only the admissions it covers;
//   later ones stay added on top. A measurement older than the current base
//   (it covers fewer admissions) is ignored.
//
// Every path that changes the estimate goes through this class:
// collab/server.ts admits socket frames and writer reservations, settles
// them, and re-bases from loads, derived stores, measured frames (after they
// are applied) and writes (after they are applied).
import { fastAcceptBelowBytes } from './limits.js';

/**
 * How much a client update can grow once the server writes block ids back,
 * per byte of the update. Measured 26 Nov 2026 (yjs 13.6.33, F1's
 * ensureBlockIds + applyJsonToYDoc), growth of the encoded state divided by
 * the update's length, for updates of n = 50, 500 and 3000 tiny blocks:
 * empty paragraphs 2.69–2.75 (the worst), horizontal rules 2.13–2.16, bullet
 * lists of one empty item 1.73–1.77, empty headings 1.46–1.51,
 * one-character paragraphs 1.28–1.35; one transaction or one per block alike.
 * Rounded up. A whole state is one such update, so a state that can't be
 * normalized yet (Yjs holds structs back, or it holds content outside the
 * schema) normalizes to at most its encoded size × (1 + ID_GROWTH).
 */
export const ID_GROWTH = 3;

/** What an admitted change of `bytes` is charged: its own size and the most its block ids can add. */
export function chargeFor(bytes: number): number {
  return bytes * (1 + ID_GROWTH);
}

export class SizeAccount {
  /** The last exact normalized measurement (or, from a load that couldn't measure exactly, an upper bound). */
  private base: number;
  /** The last admission `base` covers. */
  private baseCovers = 0;
  /** The last admission's sequence number. */
  private last = 0;
  /** The charge of every admission after `baseCovers` that hasn't been dropped. */
  private readonly charges = new Map<number, number>();
  private charged = 0;
  /** Admissions not yet applied to the live document (or dropped). */
  private readonly unsettled = new Set<number>();

  constructor(base: number) {
    this.base = base;
  }

  /** The upper bound on the normalized size. */
  get estimate(): number {
    return this.base + this.charged;
  }

  /** True when a change of `bytes` may pass without measuring: the bound with it stays below the fast threshold (90% of the cap). */
  fitsFast(bytes: number): boolean {
    return this.estimate + chargeFor(bytes) < fastAcceptBelowBytes();
  }

  /** Admits a change of `bytes`: charged until a measurement covers it. Returns its sequence number. */
  admit(bytes: number): number {
    this.last += 1;
    const charge = chargeFor(bytes);
    this.charges.set(this.last, charge);
    this.charged += charge;
    this.unsettled.add(this.last);
    return this.last;
  }

  /** Admission `seq` has been applied to the live document; or, with `applied: false`, never will be (its charge goes). */
  settle(seq: number, applied = true): void {
    this.unsettled.delete(seq);
    if (applied) return;
    const charge = this.charges.get(seq);
    if (charge === undefined) return;
    this.charges.delete(seq);
    this.charged -= charge;
  }

  /**
   * The admissions a measurement of the live document taken now covers:
   * every one before the first not yet settled. With `including`, a scratch
   * copy that also has that admission applied.
   */
  covers(including?: number): number {
    let first = Infinity;
    for (const seq of this.unsettled) if (seq !== including && seq < first) first = seq;
    return first === Infinity ? this.last : first - 1;
  }

  /**
   * An exact normalized measurement covering admissions up to `covers`
   * (covers() when it was taken): it replaces them; later admissions stay on
   * top. Ignored when the current base covers more.
   */
  rebase(bytes: number, covers: number): void {
    if (covers < this.baseCovers) return;
    this.base = bytes;
    this.baseCovers = covers;
    for (const [seq, charge] of this.charges) {
      if (seq > covers) continue;
      this.charges.delete(seq);
      this.charged -= charge;
    }
  }
}
