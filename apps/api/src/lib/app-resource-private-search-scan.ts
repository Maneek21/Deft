import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { appResourceProjections } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';

/** Internal bounded scan only. The caller must already hold the exact live
 * owner/binding/checkpoint authority locks and perform its final delivery guard.
 * This helper neither grants authority nor opens another transaction. */
export async function scanPrivateResourceCheckpoint<T>(tx: AppRunTransaction,
  scope: { org_id: string; binding_id: string; checkpoint_id: string; generation: number },
  options: { after?: string; max_items: number; check: () => void;
    decodeMatch: (row: typeof appResourceProjections.$inferSelect) => T | undefined;
    unavailable: () => Error }) {
  const where = [eq(appResourceProjections.org_id, scope.org_id),
    eq(appResourceProjections.resource_binding_id, scope.binding_id),
    eq(appResourceProjections.checkpoint_id, scope.checkpoint_id),
    eq(appResourceProjections.generation, scope.generation), eq(appResourceProjections.state, 'live')];
  options.check();
  const locators = await tx.select({ id: appResourceProjections.id, bytes: appResourceProjections.body_bytes })
    .from(appResourceProjections).where(and(...where, options.after ? gt(appResourceProjections.id, options.after) : undefined))
    .orderBy(asc(appResourceProjections.id)).limit(101);
  options.check();
  let bytes = 0;
  const selected: string[] = [];
  for (const locator of locators.slice(0, 100)) {
    if (locator.bytes > 1_048_576) throw options.unavailable();
    if (bytes + locator.bytes > 1_048_576) break;
    bytes += locator.bytes; selected.push(locator.id);
  }
  const rows = selected.length ? await tx.select().from(appResourceProjections)
    .where(and(...where, inArray(appResourceProjections.id, selected)))
    .orderBy(asc(appResourceProjections.id)) : [];
  if (rows.length !== selected.length) throw options.unavailable();
  const items: T[] = [];
  let scanned = 0, after: string | null = null;
  for (const row of rows) {
    options.check();
    const hit = options.decodeMatch(row);
    if (hit && items.length >= options.max_items) break;
    if (hit) items.push(hit);
    scanned++; after = row.id;
    if (items.length === options.max_items) break;
  }
  return { items, scanned, after, complete: scanned === locators.length };
}
