import { createHash } from 'node:crypto';
import { APP_RUN_CONTRACT_VERSIONS, canonicalCapabilityJson } from '@deft/shared';

export const APP_RESOURCE_SYNC_CONTINUATION_DELAY_MS = 5_000;

/** Evidence is loaded under the checkpoint admission lock. An opaque cursor
 * alone is never a continuation signal: completed streams also retain one. */
export function resourceSyncDueAt(input: {
  created_at: Date; terminal_at: Date | null; interval_seconds: number;
  committed: boolean; page_digest: string | null; cursor: string | null;
  output: unknown;
}): Date {
  const normal = input.created_at.getTime() + input.interval_seconds * 1_000;
  const envelope = input.output as Record<string, unknown> | null;
  const page = envelope?.output as Record<string, unknown> | null;
  if (!input.committed || !input.terminal_at || !Number.isFinite(input.terminal_at.getTime())
    || envelope?.schema_version !== APP_RUN_CONTRACT_VERSIONS.provider_result
    || envelope.provider_succeeded !== true || !page || typeof page !== 'object'
    || page.has_more !== true || typeof input.cursor !== 'string' || page.next_cursor !== input.cursor
    || input.page_digest !== 'sha256:' + createHash('sha256').update(canonicalCapabilityJson(page)).digest('hex')) {
    return new Date(normal);
  }
  return new Date(Math.min(normal, input.terminal_at.getTime() + APP_RESOURCE_SYNC_CONTINUATION_DELAY_MS));
}
