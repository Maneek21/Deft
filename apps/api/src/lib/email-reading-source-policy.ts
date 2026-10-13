import { and, eq } from 'drizzle-orm';
import { emailAccounts, appResourceBindings } from '@deft/db/schema';
import type { db } from './db.js';
import type { AppConnectionEntry } from './app-connection-registry.js';
import type { ExperienceCaller } from './app-experience-service.js';
import type { EmailActor } from './email-mailbox-service.js';
import type { EmailReadingPreference } from './email-reading-preferences.js';

export type EmailSourceReadingPolicy = (input: { caller: ExperienceCaller; entry: AppConnectionEntry;
  record: Record<string, unknown>; signal: AbortSignal }) => Promise<'ask' | 'always'>;

export function createEmailSourceReadingPolicy(database: Pick<typeof db, 'select'>,
  read: (actor: EmailActor, orgId: string, accountId: string, signal: AbortSignal) => Promise<EmailReadingPreference>): EmailSourceReadingPolicy {
  return async ({ caller, entry, record, signal }) => {
    signal.throwIfAborted();
    if (!entry.adapter.nativeEmailAccount || !Number.isFinite(caller.access_expires_at)) return 'ask';
    const source = record.provider_source as Record<string, unknown> | undefined;
    const data = record.data as Record<string, unknown> | undefined;
    if (!source || source.schema_version !== 'deft.email_provider_source.v1' || typeof source.account_id !== 'string'
      || !['gmail', 'microsoft', 'imap_smtp'].includes(String(source.provider)) || source.account_id !== data?.account_id
      || source.provider !== data?.provider || source.logical_message_id !== data?.logical_message_id) return 'ask';
    const p = entry.pins;
    const rows = await database.select({ account: emailAccounts, binding: appResourceBindings }).from(emailAccounts)
      .innerJoin(appResourceBindings, and(eq(appResourceBindings.org_id, emailAccounts.org_id), eq(appResourceBindings.id, emailAccounts.resource_binding_id)))
      .where(and(eq(emailAccounts.org_id, caller.org_id), eq(emailAccounts.owner_user_id, caller.user_id),
        eq(emailAccounts.resource_binding_id, p.resource_binding_id), eq(appResourceBindings.owner_user_id, caller.user_id),
        eq(appResourceBindings.app_installation_id, p.installation_id), eq(appResourceBindings.app_version_id, p.app_version_id),
        eq(appResourceBindings.grant_snapshot_id, p.grant_snapshot_id), eq(appResourceBindings.target_key, p.target_key), eq(appResourceBindings.resource_key, p.resource_key))).limit(2);
    signal.throwIfAborted();
    if (rows.length !== 1) return 'ask';
    const { account, binding } = rows[0]!;
    if (account.account_id !== source.account_id || account.provider !== source.provider || account.org_id !== caller.org_id
      || account.owner_user_id !== caller.user_id || account.resource_binding_id !== p.resource_binding_id || account.state !== 'active'
      || !account.principal_digest || !/^[a-f0-9]{64}$/.test(account.principal_digest)
      || binding.id !== p.resource_binding_id || binding.org_id !== caller.org_id || binding.owner_user_id !== caller.user_id
      || binding.app_installation_id !== p.installation_id || binding.app_version_id !== p.app_version_id
      || binding.grant_snapshot_id !== p.grant_snapshot_id || binding.target_key !== p.target_key || binding.resource_key !== p.resource_key) return 'ask';
    const pref = await read({ user_id: caller.user_id, web_session_id: caller.sid, access_expires_at: caller.access_expires_at! },
      caller.org_id, account.account_id, signal);
    signal.throwIfAborted();
    return pref.account_id === account.account_id && pref.external_images === 'always' ? 'always' : 'ask';
  };
}

/** Optional policy unavailable => keep the explicit per-message loading choice. */
export const sourceEmailReadingPolicy: EmailSourceReadingPolicy = async input => {
  if (process.env.DEFT_NATIVE_EMAIL_ENABLED !== 'true') return 'ask';
  try {
    const [{ db }, { PostgresEmailReadingPreferences }] = await Promise.all([import('./db.js'), import('./email-reading-preferences.js')]);
    return await createEmailSourceReadingPolicy(db, (actor, org, account, signal) => new PostgresEmailReadingPreferences(db).get(actor, org, account, signal))(input);
  } catch { input.signal.throwIfAborted(); return 'ask'; }
};
