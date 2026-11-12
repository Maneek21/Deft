import { and, eq } from 'drizzle-orm';
import { wikiPages } from '@deft/db/schema';
import type { db } from './db.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every writer of a page's outgoing links takes this lock on the source page
 * row first and replaces the links in the same transaction. Writes to one
 * page's links therefore never interleave, and a write that checked the
 * links before changing them sees no other change in between. Lock order is
 * always the page row, then its links. The lock is FOR NO KEY UPDATE: these
 * writers never change a page key (id, org, slug), and it leaves the key
 * share locks that link foreign keys take on other pages free, so two pages
 * linking to each other at once do not deadlock. Returns false when the page
 * is gone.
 */
export async function lockWikiPageForLinkWrite(tx: Transaction, orgId: string, pageId: string): Promise<boolean> {
  const [page] = await tx
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(and(eq(wikiPages.id, pageId), eq(wikiPages.org_id, orgId)))
    .limit(1)
    .for('no key update');
  return Boolean(page);
}
