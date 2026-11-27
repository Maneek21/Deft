// The daily pass over agent edit suggestions (M6, lib/document-suggestions.ts):
// suggestions pending for 14 days expire, with a version note; suggestions
// whose asker lost edit by a path no access-loss hook covers are cancelled;
// suggestions out of step with their actions are put back in step.
//
// Each day's run has its own job key, `document-suggestion-expiry:<yyyy-mm-dd>`
// (the UTC day it runs on), held as the queue's dedupe key, so a key is never
// reused (consult rule C1) and a day runs once however often the job is
// scheduled. The run schedules the next day's first, so a failing pass never
// ends the chain; the scheduler (lib/job-scheduler.ts) and the worker's
// recurring-job repair (workers/index.ts) schedule it too.
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import { cancelLostDocumentSuggestions, expireStaleSuggestions, repairSuggestions } from '../../lib/document-suggestions.js';
import type { JobData } from '../types.js';

export const DOCUMENT_SUGGESTION_EXPIRY_JOB = 'document-suggestion-expiry';
/** The UTC hour the pass runs at, each day. */
const RUN_HOUR_UTC = 3;

const twoDigits = (n: number) => String(n).padStart(2, '0');

/** The job key of the run on `day`'s UTC date: `document-suggestion-expiry:2026-11-27`. */
export function documentSuggestionExpiryKey(day: Date): string {
  return `${DOCUMENT_SUGGESTION_EXPIRY_JOB}:${day.getUTCFullYear()}-${twoDigits(day.getUTCMonth() + 1)}-${twoDigits(day.getUTCDate())}`;
}

/** The first run time strictly after `now`: RUN_HOUR_UTC on that day or the next. */
export function nextDocumentSuggestionExpiryRun(now: Date): Date {
  const run = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_HOUR_UTC));
  if (run.getTime() <= now.getTime()) run.setUTCDate(run.getUTCDate() + 1);
  return run;
}

/** Schedules the next day's run once (its day's key). */
export async function ensureDocumentSuggestionExpiry(now = new Date()): Promise<void> {
  const run = nextDocumentSuggestionExpiryRun(now);
  await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, DOCUMENT_SUGGESTION_EXPIRY_JOB, {}, {
    orgId: null, dedupeKey: documentSuggestionExpiryKey(run), delay: run.getTime() - now.getTime(),
  });
}

export async function handleDocumentSuggestionExpiry(_job: JobData): Promise<void> {
  const now = new Date();
  await ensureDocumentSuggestionExpiry(now);
  const expired = await expireStaleSuggestions(now);
  const cancelled = await cancelLostDocumentSuggestions();
  await repairSuggestions(now);
  if (expired > 0 || cancelled > 0) console.log('[document-suggestion-expiry] Closed <redacted> suggestion(s)');
}
