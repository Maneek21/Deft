import { sql } from 'drizzle-orm';
import { db } from './db.js';

/**
 * Heartbeat ticks store their prompt in `agent_actions.params.heartbeat_prompt`.
 * Before this format, the prompt copied up to six chat messages verbatim from
 * rooms the employee was configured for, with no access check, and nothing
 * moves a tick out of `pending`. Those rows are returned to the employee's
 * runtime (fetch_unread, poll_pending_work) and to owners/admins (agent
 * activity). New ticks carry this marker and list messages by id only.
 */
export const HEARTBEAT_PROMPT_FORMAT = 'message_refs_v1';

/**
 * Replaces an older prompt. It stays a string so a runtime, or a rolled-back
 * release, that reads `heartbeat_prompt` still gets a usable prompt.
 */
export const SCRUBBED_HEARTBEAT_PROMPT = 'HEARTBEAT CHECK — scheduled wake-up. '
  + 'This older tick no longer lists messages; read current messages with fetch_unread. '
  + 'If nothing needs attention right now, respond with exactly HEARTBEAT_OK.';

/**
 * Rewrites every heartbeat tick without the current format marker, whatever
 * its status and whether or not the employee's heartbeat is still on. This is
 * runtime code, not an upgrade file: upgrade files are add-only and may not
 * rewrite rows, and a tick written by a rolled-back release must be cleaned
 * the next time a current release starts. Idempotent: a scrubbed row carries
 * the marker. Bounded: short batches, each its own statement, skipping rows
 * another transaction holds.
 */
export async function scrubLegacyHeartbeatTicks(options: { batchSize?: number; maxBatches?: number } = {}): Promise<number> {
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? 200;
  let scrubbed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db.execute(sql`
      UPDATE agent_actions
      SET params = COALESCE(params, '{}'::jsonb) || jsonb_build_object(
        'heartbeat_prompt', ${SCRUBBED_HEARTBEAT_PROMPT}::text,
        'heartbeat_prompt_format', 'scrubbed')
      WHERE id IN (
        SELECT id FROM agent_actions
        WHERE action = 'heartbeat_tick'
          AND NOT COALESCE(params ? 'heartbeat_prompt_format', false)
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);
    const count = ((result as { rows?: unknown[] }).rows ?? []).length;
    scrubbed += count;
    if (count < batchSize) break;
  }
  return scrubbed;
}
