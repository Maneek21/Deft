import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailImapCredentials, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import type { EmailImapCredentialRecord, EmailImapCredentialStore, EmailImapScope } from './email-imap-custody.js';

const schema = { emailAccounts, emailCheckpoints, emailImapCredentials, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts };
export type EmailImapCredentialDatabase = Pick<NodePgDatabase<typeof schema>, 'transaction'>;
export type EmailImapCredentialGuard<Tx> = (scope: EmailImapScope, tx: Tx) => Promise<void>;

const whereScope = <T extends { org_id: any; owner_user_id: any; account_id: any }>(table: T, scope: EmailImapScope) => and(
  eq(table.org_id, scope.org_id), eq(table.owner_user_id, scope.owner_user_id), eq(table.account_id, scope.account_id),
);
const toRecord = (row: typeof emailImapCredentials.$inferSelect): EmailImapCredentialRecord => ({
  schema_version: 'deft.email.imap.credentials.v1', org_id: row.org_id, owner_user_id: row.owner_user_id,
  account_id: row.account_id, principal_digest: row.principal_digest, connection_revision: row.connection_revision,
  envelope: row.envelope as EmailImapCredentialRecord['envelope'],
});

/** Durable encrypted IMAP credential persistence. The injected guard must
 * validate current actor/setup authority in the same transaction. */
export class PostgresEmailImapCredentialStore implements EmailImapCredentialStore {
  constructor(private readonly database: EmailImapCredentialDatabase,
    private readonly guard: EmailImapCredentialGuard<any>) {
    if (typeof guard !== 'function') throw new TypeError('IMAP custody requires an authority guard');
  }

  async read(scope: EmailImapScope): Promise<EmailImapCredentialRecord | null> {
    return this.database.transaction(async tx => {
      await this.guard(scope, tx);
      const [account] = await tx.select({ provider: emailAccounts.provider, principal_digest: emailAccounts.principal_digest }).from(emailAccounts)
        // Reads never mutate account authority. FOR SHARE lets concurrent
        // verified-profile reads coexist while still serializing with CAS's
        // FOR UPDATE before it changes principal/revision metadata.
        .where(whereScope(emailAccounts, scope)).for('share').limit(1);
      if (!account || account.provider !== 'imap_smtp') return null;
      const [row] = await tx.select().from(emailImapCredentials).where(whereScope(emailImapCredentials, scope)).limit(1);
      await this.guard(scope, tx);
      return row && account.principal_digest === row.principal_digest ? toRecord(row) : null;
    });
  }

  async compareAndSwap(input: { scope: EmailImapScope; expected_revision: number; record: EmailImapCredentialRecord }): Promise<boolean> {
    const { scope, expected_revision: expected, record } = input;
    if (record.org_id !== scope.org_id || record.owner_user_id !== scope.owner_user_id || record.account_id !== scope.account_id
      || record.schema_version !== 'deft.email.imap.credentials.v1' || record.connection_revision !== expected + 1
      || !Number.isSafeInteger(expected) || expected < 0) return false;
    return this.database.transaction(async tx => {
      await this.guard(scope, tx);
      const [account] = await tx.select().from(emailAccounts).where(whereScope(emailAccounts, scope)).for('update').limit(1);
      if (!account || account.provider !== 'imap_smtp') return false;
      const [current] = await tx.select().from(emailImapCredentials).where(whereScope(emailImapCredentials, scope)).for('update').limit(1);
      const currentRevision = current?.connection_revision ?? 0;
      if (currentRevision !== expected) return false;
      if (current && current.principal_digest !== record.principal_digest) return false;
      if (account.principal_digest !== null && account.principal_digest !== record.principal_digest) return false;
      if (account.principal_digest === null) {
        const [checkpoint] = await tx.select({ account_id: emailCheckpoints.account_id }).from(emailCheckpoints)
          .where(whereScope(emailCheckpoints, scope)).limit(1);
        const [message] = await tx.select({ account_id: emailMessages.account_id }).from(emailMessages)
          .where(whereScope(emailMessages, scope)).limit(1);
        const [membership] = await tx.select({ account_id: emailMemberships.account_id }).from(emailMemberships)
          .where(whereScope(emailMemberships, scope)).limit(1);
        const [state] = await tx.select({ account_id: emailProviderStates.account_id }).from(emailProviderStates)
          .where(whereScope(emailProviderStates, scope)).limit(1);
        const [receipt] = await tx.select({ account_id: emailSyncReceipts.account_id }).from(emailSyncReceipts)
          .where(whereScope(emailSyncReceipts, scope)).limit(1);
        if (checkpoint || message || membership || state || receipt) return false;
      }
      if (current) {
        await tx.update(emailImapCredentials).set({ principal_digest: record.principal_digest,
          connection_revision: record.connection_revision, envelope: record.envelope, updated_at: new Date() })
          .where(whereScope(emailImapCredentials, scope));
      } else {
        await tx.insert(emailImapCredentials).values({ ...scope, principal_digest: record.principal_digest,
          connection_revision: record.connection_revision, envelope: record.envelope });
      }
      const changed = await tx.update(emailAccounts).set({ principal_digest: record.principal_digest,
        authority_revision: sql`${emailAccounts.authority_revision} + 1`, updated_at: new Date() })
        .where(and(whereScope(emailAccounts, scope), eq(emailAccounts.authority_revision, account.authority_revision)));
      if (changed.rowCount !== 1) return false;
      await this.guard(scope, tx);
      return true;
    });
  }
}
