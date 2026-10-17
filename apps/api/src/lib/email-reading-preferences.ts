import { and, eq } from 'drizzle-orm';
import { emailReadingPreferences } from '@deft/db/schema';
import type { EmailAuthorityDatabase } from './email-mailbox-authority.js';
import type { db } from './db.js';
import type { ConnectedEmailMailboxAuthority } from './email-mailbox-connected-authority.js';
import { EmailMailboxError, type EmailActor, type EmailScope } from './email-mailbox-service.js';

export type EmailReadingPreference = Readonly<{ account_id: string; external_images: 'ask' | 'always'; revision: number }>;
export type EmailReadingPreferenceUpdate = Readonly<{ external_images: 'ask' | 'always'; expected_revision: number }>;
type Runtime = { authority: Pick<ConnectedEmailMailboxAuthority, 'inspect'> };
const denied = (): never => { throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
const conflict = (): never => { throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT'); };
const where = (scope: EmailScope) => and(eq(emailReadingPreferences.org_id, scope.org_id),
  eq(emailReadingPreferences.owner_user_id, scope.owner_user_id), eq(emailReadingPreferences.account_id, scope.account_id));
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);

/** Host preference cannot widen message or image access. It records the owner's
 * loading choice for an immutable, enrolled provider principal. */
export class PostgresEmailReadingPreferences {
  constructor(private readonly database: EmailAuthorityDatabase & Pick<typeof db, 'select'>,
    private readonly runtime: (actor: EmailActor) => Promise<Runtime> = async actor =>
      (await import('./email-mailbox-runtime.js')).getEmailMailboxRuntime(actor), private readonly now = Date.now) {}
  private scope(actor: EmailActor, orgId: string, accountId: string, signal?: AbortSignal): EmailScope {
    signal?.throwIfAborted();
    if (![actor?.user_id, actor?.web_session_id, orgId, accountId].every(validId)
      || !Number.isFinite(actor?.access_expires_at) || actor.access_expires_at <= this.now()) return denied();
    return Object.freeze({ org_id: orgId, owner_user_id: actor.user_id, account_id: accountId });
  }
  private view(scope: EmailScope, row?: typeof emailReadingPreferences.$inferSelect): EmailReadingPreference {
    if (row && (row.org_id !== scope.org_id || row.owner_user_id !== scope.owner_user_id || row.account_id !== scope.account_id
      || !['ask', 'always'].includes(row.external_images) || !Number.isSafeInteger(row.revision) || row.revision < 1)) return denied();
    return Object.freeze({ account_id: scope.account_id, external_images: row?.external_images as 'ask' | 'always' ?? 'ask', revision: row?.revision ?? 1 });
  }
  async get(actor: EmailActor, orgId: string, accountId: string, signal?: AbortSignal): Promise<EmailReadingPreference> {
    const scope = this.scope(actor, orgId, accountId, signal), { authority } = await this.runtime(actor);
    const before = await authority.inspect(actor, scope, 'human_read', undefined, signal);
    const [row] = await this.database.select().from(emailReadingPreferences).where(where(scope)).limit(1);
    const after = await authority.inspect(actor, scope, 'human_read', undefined, signal);
    this.scope(actor, orgId, accountId, signal);
    if (before.capability.authority_version !== after.capability.authority_version
      || before.account.principal_digest !== after.account.principal_digest || before.account.provider !== after.account.provider) return denied();
    return this.view(scope, row);
  }
  async update(actor: EmailActor, orgId: string, accountId: string, input: EmailReadingPreferenceUpdate,
    signal?: AbortSignal): Promise<EmailReadingPreference> {
    const scope = this.scope(actor, orgId, accountId, signal);
    if (!input || Object.keys(input).sort().join(',') !== 'expected_revision,external_images' || !['ask', 'always'].includes(input.external_images)
      || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 || input.expected_revision >= 2147483647) return conflict();
    input = Object.freeze({ ...input });
    const { authority } = await this.runtime(actor);
    return this.database.transaction(async tx => {
      // Legacy/native/SID locks are acquired by connected authority before the
      // preference row. A second inspect reacquires the same held graph.
      const before = await authority.inspect(actor, scope, 'human_read', tx, signal);
      const [row] = await tx.select().from(emailReadingPreferences).where(where(scope)).limit(1).for('update');
      this.scope(actor, orgId, accountId, signal);
      const previous = this.view(scope, row);
      if (previous.revision !== input.expected_revision) return conflict();
      const revision = previous.revision + 1, values = { external_images: input.external_images, revision, updated_at: new Date(this.now()) };
      const written = row ? await tx.update(emailReadingPreferences).set(values)
        .where(and(where(scope), eq(emailReadingPreferences.revision, input.expected_revision))).returning()
        : await tx.insert(emailReadingPreferences).values({ ...scope, ...values }).onConflictDoNothing().returning();
      if (written.length !== 1) return conflict();
      const after = await authority.inspect(actor, scope, 'human_read', tx, signal);
      this.scope(actor, orgId, accountId, signal);
      if (before.capability.authority_version !== after.capability.authority_version
        || before.account.principal_digest !== after.account.principal_digest || before.account.provider !== after.account.provider) return denied();
      return this.view(scope, written[0]);
    });
  }
}
