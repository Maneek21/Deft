import { orgs } from '@deft/db/schema';
import { db } from '../../lib/db.js';
import { enqueueMissingChatObservations } from '../../lib/chat-observation.js';
import type { JobData } from '../types.js';

export async function handleChatObservationBackfill(_job: JobData): Promise<void> {
  const orgRows = await db
    .select({ id: orgs.id })
    .from(orgs)
    .limit(100);

  let total = 0;
  for (const org of orgRows) {
    total += await enqueueMissingChatObservations({ orgId: org.id, limit: 200 });
  }

  if (total > 0) {
    console.log(`[chat-observation-backfill] queued ${total} missing observation job(s)`);
  }
}
