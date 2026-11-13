// Scheduled GitHub sync. A 60-second scan picks at most
// GITHUB_SYNC_SCAN_BATCH due GitHub connections and, in one transaction,
// reserves each one's next turn and queues one `github-sync-connection` job
// carrying only its workspace and connection id. The job re-checks the
// connection inside that workspace and runs the same sync as the manual
// "Sync" button; that sync's per-connection lease keeps the two from
// overlapping and records the outcome (next turn, failures, cooldown).
//
// Schedule state lives under `connected_accounts.metadata.github_sync`.

import { sql } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import { githubSyncIntervalMs, jitteredFromNow, syncGitHubForUser } from '../github-sync.js';
import { jobOrgId } from '../job-org.js';
import type { JobData } from '../types.js';

export { githubSyncIntervalMs };
export const GITHUB_SYNC_SCAN_JOB = 'github-sync-scan';
export const GITHUB_SYNC_CONNECTION_JOB = 'github-sync-connection';
/** Scan cadence: how often due connections are looked for. */
export const GITHUB_SYNC_SCAN_MS = 60_000;
/** Connections queued per scan, so one tick's work stays small. */
export const GITHUB_SYNC_SCAN_BATCH = 10;

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Lease free and any rate-limit cooldown over, for alias `c`. */
const FREE_AND_COOLED = sql`
  (c.metadata->'github_sync'->'lease'->>'until' IS NULL
    OR (c.metadata->'github_sync'->'lease'->>'until')::timestamptz <= now())
  AND (c.metadata->'github_sync'->>'cooldown_until' IS NULL
    OR (c.metadata->'github_sync'->>'cooldown_until')::timestamptz <= now())`;

export async function handleGitHubSyncScan(_job: JobData): Promise<void> {
  const intervalMs = githubSyncIntervalMs();
  if (intervalMs === 0) return;

  // Due: its reserved turn has come, or, never scheduled, its last sync is
  // older than one interval. Reserve and queue in one transaction so a crash
  // between the two cannot skip a turn.
  const queued = await db.transaction(async (tx) => {
    const picked = rows<{ id: string; org_id: string }>(await tx.execute(sql`
      UPDATE connected_accounts ca
      SET metadata = coalesce(ca.metadata, '{}'::jsonb) || jsonb_build_object('github_sync',
        coalesce(ca.metadata->'github_sync', '{}'::jsonb) || jsonb_build_object('next_at', ${jitteredFromNow(intervalMs)}))
      WHERE ca.id IN (
        SELECT c.id FROM connected_accounts c
        JOIN org_members m ON m.org_id = c.org_id AND m.user_id = c.user_id AND m.is_active = true
        WHERE c.provider = 'github'
          AND CASE WHEN c.metadata->'github_sync'->>'next_at' IS NOT NULL
            THEN (c.metadata->'github_sync'->>'next_at')::timestamptz <= now()
            ELSE c.last_sync_at IS NULL OR c.last_sync_at < now() - (${intervalMs} * interval '1 millisecond') END
          AND ${FREE_AND_COOLED}
        ORDER BY coalesce((c.metadata->'github_sync'->>'next_at')::timestamptz, c.last_sync_at) ASC NULLS FIRST
        LIMIT ${GITHUB_SYNC_SCAN_BATCH}
        FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING ca.id, ca.org_id`));
    for (const row of picked) {
      await enqueue(
        QUEUE_NAMES.SCHEDULED_JOBS,
        GITHUB_SYNC_CONNECTION_JOB,
        { org_id: row.org_id, connection_id: row.id },
        { orgId: row.org_id, maxAttempts: 1, executor: tx },
      );
    }
    return picked.length;
  });
  if (queued > 0) console.log(`[github-sync] queued ${queued} scheduled sync(s)`);
}

export async function handleGitHubSyncConnection(job: JobData): Promise<void> {
  if (githubSyncIntervalMs() === 0) return;
  const orgId = jobOrgId(job);
  const connectionId = typeof job.data?.connection_id === 'string' ? job.data.connection_id : null;
  if (!orgId || !connectionId) {
    console.warn('[github-sync] scheduled sync without one workspace and connection; skipped');
    return;
  }

  // A GitHub connection of this workspace whose owner is still an active
  // member of it, not cooling down after a rate limit seen since it was queued.
  const [eligible] = rows<{ id: string }>(await db.execute(sql`
    SELECT c.id FROM connected_accounts c
    JOIN org_members m ON m.org_id = c.org_id AND m.user_id = c.user_id AND m.is_active = true
    WHERE c.id = ${connectionId} AND c.org_id = ${orgId} AND c.provider = 'github'
      AND (c.metadata->'github_sync'->>'cooldown_until' IS NULL
        OR (c.metadata->'github_sync'->>'cooldown_until')::timestamptz <= now())
    LIMIT 1`));
  if (!eligible) {
    console.warn(`[github-sync] connection ${connectionId} is not eligible for a scheduled sync now; skipped`);
    return;
  }

  // The sync records its own outcome. "Already running" means another sync
  // of this connection holds it and will record the outcome instead.
  await syncGitHubForUser(connectionId, { orgId, signal: job.signal });
}
