import { z } from 'zod';
import type { EmailActor, EmailCapability, EmailAuthority, EmailScope } from './email-mailbox-service.js';
import type { PostgresEmailMailboxStore } from './email-mailbox-store.js';

const Scope = z.strictObject({ org_id: z.string().min(1).max(256), owner_user_id: z.string().min(1).max(256), account_id: z.string().min(1).max(256) });
const Actor = z.strictObject({ user_id: z.string().min(1).max(256), web_session_id: z.string().min(1).max(256), access_expires_at: z.number().finite() });
const Folder = z.string().min(1).max(128).refine(value => !/[\r\n\0]/u.test(value));
const canonicalFolder = (value: string) => value.toLowerCase() === 'inbox' ? 'inbox' : value;

export type EmailUnreadSnapshot = Readonly<{
  account_id: string;
  folder: string;
  unread_count: number | null;
  cached_unread_count: number | null;
  coverage: 'partial' | 'complete';
  sync_state: 'idle' | 'queued' | 'syncing' | 'failed' | 'paused';
  checkpoint_revision: number;
  observed_at: string | null;
  fresh_until: string | null;
}>;
export type EmailUnreadSnoozeFilter = (scope: EmailScope, signal?: AbortSignal) => Promise<ReadonlySet<string>>;
export type EmailUnifiedUnreadSnapshot = Readonly<{ unread_count: number | null; cached_unread_count: number | null;
  coverage: 'partial' | 'complete'; folder: string; accounts: readonly Omit<EmailUnreadSnapshot, 'folder'|'unread_count'|'cached_unread_count'>[] }>;

/** Read-only unread convergence over the native cache. Exact counts are shown
 * only after complete provider coverage and a database aggregate.
 * Snooze is a local Inbox visibility rule and never mutates provider state. */
export class EmailUnreadService {
  constructor(private readonly authority: EmailAuthority, private readonly store: Pick<PostgresEmailMailboxStore, 'readUnreadCount'>,
    private readonly hiddenSnoozes: EmailUnreadSnoozeFilter, private readonly now = Date.now) {}

  async read(actorRaw: EmailActor, scopeRaw: EmailScope, folderRaw: string, signal?: AbortSignal): Promise<EmailUnreadSnapshot> {
    const actor = Actor.parse(actorRaw), scope = Scope.parse(scopeRaw), folder = canonicalFolder(Folder.parse(folderRaw));
    if (actor.user_id !== scope.owner_user_id || actor.access_expires_at <= this.now()) throw new Error('EMAIL_ACCESS_DENIED');
    signal?.throwIfAborted();
    const initial = await this.authority.current(actor, scope, 'human_read', undefined, signal);
    const valid = (capability: EmailCapability) => capability.scope.org_id === scope.org_id && capability.scope.owner_user_id === scope.owner_user_id
      && capability.scope.account_id === scope.account_id && Number.isFinite(capability.expires_at) && capability.expires_at > this.now()
      && capability.authority_version === initial.authority_version && capability.resource_binding_id === initial.resource_binding_id;
    if (!valid(initial)) throw new Error('EMAIL_ACCESS_DENIED');
    const hidden = folder === 'inbox' ? [...await this.hiddenSnoozes(scope, signal)] : [];
    const data = await this.store.readUnreadCount(scope, folder, hidden, signal);
    const cached = data.cached_unread_count;
    signal?.throwIfAborted();
    const final = await this.authority.current(actor, scope, 'human_read', undefined, signal);
    if (!valid(final)) throw new Error('EMAIL_ACCESS_DENIED');
    return Object.freeze({ account_id: scope.account_id, folder, unread_count: data.coverage === 'complete' ? cached : null,
      cached_unread_count: cached, coverage: data.coverage, sync_state: data.sync_state, checkpoint_revision: data.checkpoint_revision,
      observed_at: data.observed_at, fresh_until: data.fresh_until });
  }

  /** Logical IDs are unique within each native account. Summing distinct account
   * partitions preserves the previous [account_id, logical_id] identity rule. */
  async readUnified(actorRaw: EmailActor, scopesRaw: readonly EmailScope[], folderRaw: string, signal?: AbortSignal): Promise<EmailUnifiedUnreadSnapshot> {
    const actor = Actor.parse(actorRaw), scopes = z.array(Scope).min(1).max(50).parse(scopesRaw), folder = canonicalFolder(Folder.parse(folderRaw));
    if (scopes.some(scope => scope.owner_user_id !== actor.user_id) || actor.access_expires_at <= this.now()) throw new Error('EMAIL_ACCESS_DENIED');
    const counted = new Set<string>(), accountResults: Array<Omit<EmailUnreadSnapshot, 'folder'|'unread_count'|'cached_unread_count'>> = [];
    let complete = true, cached = 0;
    for (const scope of scopes) {
      signal?.throwIfAborted();
      const initial = await this.authority.current(actor, scope, 'human_read', undefined, signal);
      if (initial.scope.org_id !== scope.org_id || initial.scope.owner_user_id !== scope.owner_user_id || initial.scope.account_id !== scope.account_id
        || !Number.isFinite(initial.expires_at) || initial.expires_at <= this.now()) throw new Error('EMAIL_ACCESS_DENIED');
      const hidden = folder === 'inbox' ? [...await this.hiddenSnoozes(scope, signal)] : [];
      const data = await this.store.readUnreadCount(scope, folder, hidden, signal);
      if (!counted.has(scope.account_id)) { cached += data.cached_unread_count; counted.add(scope.account_id); }
      if (!Number.isSafeInteger(cached)) throw new Error('EMAIL_UNAVAILABLE');
      const final = await this.authority.current(actor, scope, 'human_read', undefined, signal);
      if (final.scope.org_id !== scope.org_id || final.scope.owner_user_id !== scope.owner_user_id || final.scope.account_id !== scope.account_id
        || final.authority_version !== initial.authority_version || final.resource_binding_id !== initial.resource_binding_id
        || !Number.isFinite(final.expires_at) || final.expires_at <= this.now()) throw new Error('EMAIL_ACCESS_DENIED');
      if (data.coverage !== 'complete') complete = false;
      accountResults.push({ account_id: scope.account_id, coverage: data.coverage, sync_state: data.sync_state,
        checkpoint_revision: data.checkpoint_revision, observed_at: data.observed_at, fresh_until: data.fresh_until });
    }
    return Object.freeze({ unread_count: complete ? cached : null, cached_unread_count: cached,
      coverage: complete ? 'complete' : 'partial', folder, accounts: Object.freeze(accountResults) });
  }
}
