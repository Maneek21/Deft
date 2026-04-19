/**
 * Handler: clawhub-allowlist-refresh — daily cron that pulls the VoltAgent
 * awesome-openclaw-skills list and upserts into the clawhub_allowlist table.
 * Falls back to a bundled static list on network failure.
 *
 * Block 0 Task 0.11 of OpenClaw Unlock plan.
 */
import type { JobData } from '../types.js';
import { refreshClawhubAllowlist } from '../../lib/clawhub-allowlist.js';

export async function handleClawhubAllowlistRefresh(_job: JobData): Promise<void> {
  await refreshClawhubAllowlist();
}
