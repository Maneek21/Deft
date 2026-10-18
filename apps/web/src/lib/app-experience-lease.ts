import { normalizeExperienceExposureStatus } from './app-experience-session';
import { isExperienceAuthorityUnavailable } from './app-experience-connection';
export type ExperienceLease = Readonly<{
  session_expires_at: string;
  exposure: Readonly<{ exposure_id: string; exposure_epoch: number; review_digest: string; expires_at: string }>;
}>;

/** Technical renewal cannot change the permission or the running app identity. */
export function createExperienceLease(input: {
  initial: ExperienceLease;
  current: () => boolean;
  refresh: () => Promise<ExperienceLease>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let lease = input.initial;
  let pending: Promise<boolean> | null = null;
  let disposed = false;
  const current = () => !disposed && input.current();
  const deadline = () => Math.min(Date.parse(lease.session_expires_at), Date.parse(lease.exposure.expires_at));
  const valid = () => current() && Number.isFinite(deadline()) && deadline() > now();
  return {
    get value() { return lease; },
    valid,
    async ensure(force = false): Promise<boolean> {
      if (!current()) return false;
      if (!force && valid() && deadline() - now() > 90_000) return true;
      if (pending) return pending;
      pending = (async () => {
        try {
          const next = await input.refresh();
          if (!current() || next.exposure.exposure_id !== lease.exposure.exposure_id
            || next.exposure.exposure_epoch !== lease.exposure.exposure_epoch
            || next.exposure.review_digest !== lease.exposure.review_digest
            || !Number.isFinite(Date.parse(next.session_expires_at))
            || !Number.isFinite(Date.parse(next.exposure.expires_at))
            || Math.min(Date.parse(next.session_expires_at), Date.parse(next.exposure.expires_at)) <= now()) return false;
          lease = next;
          return true;
        } catch (error) {
          if (isExperienceAuthorityUnavailable(error)) throw error;
          // A denied refresh is not permission to continue on a cached grant.
          return false;
        } finally { pending = null; }
      })();
      return pending;
    },
    dispose() { disposed = true; },
  };
}

/** Both bootstrap recovery and the running Worker consume the same refresh DTO. */
export function normalizeExperienceLeaseRefresh(input: unknown): ExperienceLease {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid app session.');
  const value = input as Record<string, unknown>;
  if (typeof value.session_expires_at !== 'string' || !Number.isFinite(Date.parse(value.session_expires_at))) throw new Error('Invalid app session.');
  return { session_expires_at: value.session_expires_at, exposure: normalizeExperienceExposureStatus(value.exposure) };
}
