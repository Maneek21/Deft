import { nativeParticipantsAreHuman } from './app-native-authority.js';
import { isAppNativeCalendarEnabled } from './env.js';
import type { AppRunTransaction } from './app-run-repository.js';

/** Only pass the complete participant set already locked and revalidated by
 * native authority. No new membership/user lock is acquired at this fence. */
export async function nativeFinalAuthorityIsCurrent(tx: AppRunTransaction, participants: readonly string[], options: {
  guard?: (tx: AppRunTransaction) => Promise<void>; clock?: () => Date;
  expires_at?: readonly Date[]; signal?: AbortSignal;
} = {}) {
  await options.guard?.(tx);
  const humans = await nativeParticipantsAreHuman(tx, participants);
  const now = (options.clock ?? (() => new Date()))();
  return humans && isAppNativeCalendarEnabled() && !options.signal?.aborted
    && (options.expires_at ?? []).every(expires => expires > now);
}
