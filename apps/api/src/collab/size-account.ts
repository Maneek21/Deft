// The size cap's accounting (plan Task F7, review rounds 4 and 5, the
// consult): one upper bound on a live document's normalized size, the
// encoded size its Yjs state has once the server has normalized it (the next
// derive writes the `id` attribute, and nothing else, onto every block whose
// id is missing, invalid or a later duplicate: collab/block-ids.ts).
//
// The invariant: the estimate is the last exact normalized measurement plus
// the charge of every change admitted since that measurement. A change's
// charge is its own size plus the most normalization can add for it:
// ID_WRITEBACK_BYTES for every struct it carries, and for every live struct
// its deletions remove (an attribute removed is written back).
//
// - A change is charged when it is admitted (a socket frame on the fast or
//   the measured path, a writer's reservation), never when Yjs integrates it:
//   Yjs holds back an update whose structs wait for a missing clock and fires
//   no event for it, then integrates it all at once when the missing struct
//   arrives. Held-back structs are charged like any other change.
// - The account keeps one cumulative total of the charges, and the charges
//   of admissions not yet settled (applied to the live document, or dropped:
//   a dropped one never applies, and its charge goes). Only in-flight
//   admissions are kept, so the account holds the same few numbers however
//   many changes pass (review round 5).
// - A measurement records the cumulative charge it covers: everything
//   applied when it was taken (the total minus what was still in flight); a
//   scratch copy with an admitted change applied also covers that change.
// - A measurement re-bases with an upper bound on the normalized size of
//   the state it measured: an exact one (the copy derived, so no content
//   outside the schema, and Yjs held nothing back) with its encoded size; any
//   other with boundFor, its encoded size plus ID_WRITEBACK_BYTES for every
//   block still needing an id and every struct held back, so a document that
//   can never be measured exactly is still re-based (the consult, finding 2).
//   Any measurement M covering C bounds the size from then on by
//   M + (total − C), the changes since it on top; the estimate takes the
//   smaller of that and what it is, so an older or looser measurement never
//   loosens it.
//
// Every path that changes the estimate goes through this file:
// collab/server.ts charges socket frames and writer reservations, settles
// them, and re-bases from loads, stores, measured frames (after they are
// applied) and writes (after they are applied).
import * as Y from 'yjs';
import { blocksNeedingIds, heldBackStructs } from './block-ids.js';
import { fastAcceptBelowBytes } from './limits.js';

/**
 * The most the server's normalization adds for one struct of a change, or
 * for one live struct a change deletes. Normalization writes one `id`
 * attribute onto a block that needs one (collab/block-ids.ts), and a struct
 * can leave at most one block needing an id: a new block, an id attribute
 * set to an invalid or taken value, an id attribute deleted.
 *
 * Measured 26 Nov 2026 (yjs 13.6.33, @deft/doc-schema), as (normalized
 * growth − update bytes) / (structs in the update + live structs it
 * deletes), for updates of 300 instances: one id written back is 49.6–50.6
 * bytes per block for every block type, 55.8 from the worst ids a client can
 * pick (client id 2^53 − 1, clocks past 2^21); clocks pushed to 8-byte
 * varints add about 16. Kept at 128 from the round-5 measurement, when the
 * derive still re-applied the canonical JSON and wrote every non-null
 * attribute default too (callout 82.7 at worst); the id alone stays well
 * under it, and the per-type unit test pins it for every node type and mark.
 */
export const ID_WRITEBACK_BYTES = 128;

/**
 * An upper bound on the normalized size of `doc`, whose encoded size was
 * measured as `bytes` (after whatever normalization could run on it): every
 * block still needing an id and every struct Yjs holds back can add at most
 * ID_WRITEBACK_BYTES once it is normalized. Exact when both counts are zero.
 * Walks the Y tree, so it counts a state holding content outside the schema
 * too (that content has to be removed, by a change that is charged, before
 * anything is written back).
 */
export function boundFor(doc: Y.Doc, bytes: number): number {
  return bytes + (blocksNeedingIds(doc) + heldBackStructs(doc)) * ID_WRITEBACK_BYTES;
}

/**
 * The structs a change carries plus the live structs its deletions remove:
 * each can lead normalization to write at most ID_WRITEBACK_BYTES back.
 * Decodes the update without applying it; throws when it is malformed.
 */
function rewritable(update: Uint8Array, live: Y.Doc | null): number {
  const { structs, ds } = Y.decodeUpdate(update);
  let count = 0;
  for (const struct of structs) if (struct instanceof Y.Item) count += 1;
  if (!live) return count;
  for (const [client, ranges] of ds.clients) {
    const known = live.store.clients.get(client);
    const tail = known?.[known.length - 1];
    if (!known || !tail) continue;
    const knownEnd = tail.id.clock + tail.length;
    for (const { clock, len } of ranges) {
      // Deletions of structs the live document doesn't hold yet are charged when those arrive.
      if (clock >= knownEnd) continue;
      for (let i = Y.findIndexSS(known, clock); i < known.length && known[i]!.id.clock < clock + len; i += 1) {
        const struct = known[i]!;
        if (struct instanceof Y.Item && !struct.deleted) count += 1;
      }
    }
  }
  return count;
}

/**
 * What a change is charged: its size, plus ID_WRITEBACK_BYTES for every
 * struct it carries and every live struct of `live` its deletions remove.
 * With `live` null (a whole state, or a document not loaded), only its own
 * structs. Throws when the update is malformed.
 */
export function chargeFor(update: Uint8Array, live: Y.Doc | null): number {
  return update.byteLength + rewritable(update, live) * ID_WRITEBACK_BYTES;
}

export class SizeAccount {
  /** The last exact normalized measurement (or, from a load that couldn't measure exactly, an upper bound). */
  private base: number;
  /** The cumulative charge `base` covers. */
  private baseCovered = 0;
  /** The cumulative charge of every admission, less those dropped. */
  private charged = 0;
  private last = 0;
  /** The charge of each admission not yet settled (in flight: a frame being handled, a write being stored). */
  private readonly unsettled = new Map<number, number>();

  constructor(base: number) {
    this.base = base;
  }

  /** The upper bound on the normalized size. */
  get estimate(): number {
    return this.base + (this.charged - this.baseCovered);
  }

  /** How many entries the account keeps (its admissions in flight): constant however many changes pass. */
  get retained(): number {
    return this.unsettled.size;
  }

  /** True when a change charged `charge` may pass without measuring: the bound with it stays below the fast threshold (90% of the cap). */
  fitsFast(charge: number): boolean {
    return this.estimate + charge < fastAcceptBelowBytes();
  }

  /** Admits a change charged `charge` (chargeFor). Returns its sequence number, for settle. */
  admit(charge: number): number {
    this.last += 1;
    this.unsettled.set(this.last, charge);
    this.charged += charge;
    return this.last;
  }

  /** Admission `seq` has been applied to the live document; or, with `applied: false`, never will be (its charge goes). */
  settle(seq: number, applied = true): void {
    const charge = this.unsettled.get(seq);
    if (charge === undefined) return;
    this.unsettled.delete(seq);
    if (!applied) this.charged -= charge;
  }

  /**
   * The cumulative charge a measurement of the live document taken now
   * covers: every admission already applied. With `including`, a scratch
   * copy that also has that admission applied.
   */
  covered(including?: number): number {
    let inFlight = 0;
    for (const [seq, charge] of this.unsettled) if (seq !== including) inFlight += charge;
    return this.charged - inFlight;
  }

  /**
   * An exact normalized measurement that covers `covered` (covered() when it
   * was taken): it bounds the size by `bytes` plus every charge since. The
   * estimate becomes that bound when it is the smaller.
   */
  rebase(bytes: number, covered: number): void {
    if (bytes + (this.charged - covered) > this.estimate) return;
    this.base = bytes;
    this.baseCovered = covered;
  }
}
