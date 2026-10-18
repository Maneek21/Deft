import { z } from 'zod';

/** Omission preserves the historical finite contract. Null is never a grant
 * unless this exact lifetime was explicitly reviewed and included in its digest. */
export const AppConsentLifetimeSchema = z.literal('until_revoked');
export const AppConsentExpirySchema = z.iso.datetime().nullable();
export type AppConsentLifetime = z.infer<typeof AppConsentLifetimeSchema>;
export function appConsentDeadline(expiresAt: string | Date | null, lifetime?: unknown): number {
  if (lifetime === 'until_revoked' && expiresAt === null) return Infinity;
  if (lifetime !== undefined || expiresAt === null) throw new TypeError('Invalid consent lifetime');
  const deadline = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(z.iso.datetime({offset:true}).parse(expiresAt));
  if (!Number.isFinite(deadline)) throw new TypeError('Invalid consent deadline');
  return deadline;
}
export function appConsentExpiryValid(expiresAt: string | Date | null, lifetime?: unknown): boolean {
  try { appConsentDeadline(expiresAt, lifetime); return true; } catch { return false; }
}
export const appConsentIsCurrent = (expiresAt: string | Date | null, lifetime?: unknown, now = Date.now()) =>
  appConsentDeadline(expiresAt, lifetime) > now;
export const appConsentWithin = (expiresAt: string | Date | null, ceiling: string | Date | null,
  lifetime?: unknown, ceilingLifetime?: AppConsentLifetime) =>
  appConsentDeadline(expiresAt, lifetime) <= appConsentDeadline(ceiling, ceilingLifetime);
