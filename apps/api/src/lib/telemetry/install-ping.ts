/**
 * The anonymous install ping (telemetry contract, section 3). Self-hosted only.
 *
 *   POST https://get.deft.ing/v1/installs/ping
 *   { "install_id", "event": "installed" | "person_added", "version", "sent_at" }
 *
 * Sent when the first owner finishes setup (`installed`, once: only the first
 * signup creates the workspace) and each time a person accepts an invite and
 * becomes an active member (`person_added`, guests included; agents never
 * accept invites). Nothing else: no names, email addresses, workspace names,
 * counts, addresses or content. No authentication.
 *
 * `install_id` is a UUID v4 made once per install and kept with it: an
 * HMAC-SHA256, keyed with the install's own secret ENCRYPTION_KEY (which never
 * leaves the server and cannot be changed without losing stored credentials),
 * of the first workspace's random ID. So it needs no table of its own,
 * survives restarts and upgrades, and moves with a backup; and nobody without
 * the server's key, the Deft project included, can compute it from a
 * workspace ID or turn it back into one.
 *
 * Never sent in hosted mode, on a paused start, or with DEFT_TELEMETRY=off.
 * Fire-and-forget: a short timeout, no retry; a failure is dropped and counted.
 */
import { createHmac } from 'node:crypto';
import { isPausedStart } from '../paused-start.js';
import { releaseLabel } from './scrub.js';
import { isInstallPingEnabled } from './settings.js';

export const INSTALL_PING_URL = 'https://get.deft.ing/v1/installs/ping';
const SEND_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1024;

export type InstallEvent = 'installed' | 'person_added';

/** UUID v4 layout (version and variant bits set) from an HMAC of the workspace's ID under the install's secret. */
export function installIdFromWorkspaceId(workspaceId: string, installSecret: string): string {
  const bytes = createHmac('sha256', installSecret).update(`deft-install-id-v1\n${workspaceId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function defaultFirstWorkspaceId(): Promise<string | null> {
  const [{ db }, { orgs }, { asc }] = await Promise.all([
    import('../db.js'),
    import('@deft/db/schema'),
    import('drizzle-orm'),
  ]);
  const [row] = await db.select({ id: orgs.id }).from(orgs).orderBy(asc(orgs.created_at), asc(orgs.id)).limit(1);
  return row?.id ?? null;
}

async function defaultVersion(): Promise<string> {
  const { DEFT_RELEASE_VERSION } = await import('../agent-channel.js');
  return DEFT_RELEASE_VERSION;
}

/** Test seams. */
export const installPingDeps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  now: (): number => Date.now(),
  env: process.env as NodeJS.ProcessEnv,
  firstWorkspaceId: defaultFirstWorkspaceId,
  version: defaultVersion,
  /** The install's own secret key (env.ts validates it in production). */
  installSecret: async (): Promise<string> => (await import('../env.js')).env.ENCRYPTION_KEY,
  isPaused: (): boolean => isPausedStart(),
};

const counters = { sent: 0, failed: 0 };

export function installPingCounters(): { sent: number; failed: number } {
  return { ...counters };
}

export function resetInstallPingForTest(): void {
  counters.sent = 0;
  counters.failed = 0;
}

export function isInstallPingOn(): boolean {
  return !installPingDeps.isPaused() && isInstallPingEnabled(installPingDeps.env);
}

/**
 * Send one ping. Callers do not await it: `void sendInstallPing(...)`.
 * `workspaceId` is the workspace just created (signup); otherwise the
 * install's first workspace is looked up.
 */
export async function sendInstallPing(event: InstallEvent, workspaceId?: string): Promise<void> {
  try {
    if (!isInstallPingOn()) return;
    const id = workspaceId ?? await installPingDeps.firstWorkspaceId();
    if (!id) return;
    const secret = await installPingDeps.installSecret();
    if (!secret) return;
    const body = JSON.stringify({
      install_id: installIdFromWorkspaceId(id, secret),
      event,
      version: releaseLabel(await installPingDeps.version()),
      sent_at: new Date(installPingDeps.now()).toISOString(),
    });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return;
    const res = await installPingDeps.fetch(INSTALL_PING_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) counters.sent += 1;
    else counters.failed += 1;
  } catch {
    counters.failed += 1;
  }
}
