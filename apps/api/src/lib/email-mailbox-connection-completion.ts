import type { AppConnectionEntry } from './app-connection-registry.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { EmailActor } from './email-mailbox-service.js';
import type { EmailAccountNomination, EmailEnrollmentResult } from './email-mailbox-enrollment.js';

export type EmailConnectionCompletion = (input: Readonly<{
  caller: ExperienceCaller; entry: AppConnectionEntry; operation: 'begin' | 'callback' | 'manage';
  purpose: 'connect' | 'status' | 'disconnect'; result: unknown; signal: AbortSignal;
}>) => Promise<unknown>;
type ScheduleScope = Readonly<{ org_id: string; owner_user_id: string; account_id: string; authority_revision: number }>;

/** Adapter status nominates identity only. Adoption independently verifies the
 * DB-owned reviewed binding and provider principal inside its transaction. */
export function createEmailConnectionCompletion(dependencies: {
  enabled: () => boolean;
  adopt: (actor: EmailActor, orgId: string, nomination: EmailAccountNomination, signal: AbortSignal) => Promise<EmailEnrollmentResult>;
  schedule: (scope: ScheduleScope) => Promise<unknown>;
}): EmailConnectionCompletion {
  return async ({ caller, entry, operation, purpose, result, signal }) => {
    if (!dependencies.enabled() || !entry.adapter.nativeEmailAccount || operation === 'begin' || purpose === 'disconnect'
      || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    const status = result as Record<string, unknown>;
    const account = status.account as Record<string, unknown> | undefined;
    if (status.state !== 'connected' || !account || account.health !== 'connected'
      || typeof account.account_id !== 'string' || !account.account_id.length || account.account_id.length > 256
      || account.account_id.trim() !== account.account_id || /[\x00-\x1f\x7f]/u.test(account.account_id)) return result;
    const nomination = Object.freeze({ account_id: account.account_id, resource_binding_id: entry.pins.resource_binding_id });
    let state: 'available' | 'active' | 'unavailable' = 'available';
    if (operation === 'callback') {
      try {
        signal.throwIfAborted();
        if (!Number.isFinite(caller.access_expires_at)) throw Error('Missing current human session expiry');
        const enrolled = await dependencies.adopt({ user_id: caller.user_id, web_session_id: caller.sid,
          access_expires_at: caller.access_expires_at! }, caller.org_id, nomination, signal);
        signal.throwIfAborted();
        if (enrolled.state !== 'active' || enrolled.account_id !== nomination.account_id
          || !Number.isSafeInteger(enrolled.authority_revision) || enrolled.authority_revision < 1) throw Error('Adoption not confirmed');
        await dependencies.schedule({ org_id: caller.org_id, owner_user_id: caller.user_id,
          account_id: enrolled.account_id, authority_revision: enrolled.authority_revision });
        signal.throwIfAborted();
        state = 'active';
      } catch {
        signal.throwIfAborted();
        // OAuth has already completed. Never encourage another code exchange
        // because optional cache enrollment or scheduling needs a retry.
        state = 'unavailable';
      }
    }
    return { ...status, native_email: { ...nomination, state } };
  };
}

export const completeNativeEmailConnection = createEmailConnectionCompletion({
  enabled: () => process.env.DEFT_NATIVE_EMAIL_ENABLED === 'true',
  adopt: async (actor, org, nomination, signal) => {
    const [{ db }, { PostgresEmailMailboxEnrollment }] = await Promise.all([
      import('./db.js'), import('./email-mailbox-enrollment.js'),
    ]);
    return new PostgresEmailMailboxEnrollment(db).adopt(actor, org, nomination, signal);
  },
  schedule: async scope => (await import('./email-mailbox-scheduler-runtime.js')).scheduleNativeEmailAccount(scope),
});
