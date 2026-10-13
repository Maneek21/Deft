import { z } from 'zod';
import type { EmailActor, EmailAuthority, EmailCapability, EmailScope } from './email-mailbox-service.js';
import type { EmailRuleGuard, EmailRuleStore } from './email-rule-store.js';
import { EmailRuleContentSchema, EmailRulePreviewRequestSchema, type EmailRuleCondition, type EmailRuleContent, type EmailRulePreviewPage,
  type EmailRuleScope, EmailRuleError } from './email-rule-types.js';

const Id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope = z.strictObject({ org_id: Id, owner_user_id: Id, account_id: Id });
const Actor = z.strictObject({ user_id: Id, web_session_id: Id, access_expires_at: z.number().finite() });
export type EmailRulePreviewRecord = Readonly<{ account_id: string; logical_message_id: string; revision: string; folders: readonly string[];
  data: Readonly<Record<string, string | number | boolean | null>> }>;
export type EmailRuleMailboxPage = Readonly<{ account_id: string; items: readonly EmailRulePreviewRecord[]; next_cursor: string | null;
  coverage: 'partial' | 'complete'; sync_state: 'idle' | 'queued' | 'syncing' | 'failed' | 'paused'; checkpoint_revision: number }>;
export type EmailRulePreviewMailbox = Readonly<{ list(actor: EmailActor, scope: EmailScope,
  request: Readonly<{ folder: string; cursor: string | null; limit: number }>, signal?: AbortSignal): Promise<EmailRuleMailboxPage> }>;
const denied = () => new EmailRuleError('EMAIL_RULE_ACCESS_DENIED');
const sameScope = (left: EmailScope, right: EmailScope) => left.org_id === right.org_id && left.owner_user_id === right.owner_user_id && left.account_id === right.account_id;
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

function conditionMatches(record: Pick<EmailRulePreviewRecord, 'folders' | 'data'>, condition: EmailRuleCondition): boolean {
  const candidates = condition.field === 'folder' ? record.folders : [String(record.data[
    condition.field === 'from' ? 'sender' : condition.field === 'to' ? 'recipients' : condition.field === 'cc' ? 'cc' : 'subject'] ?? '')];
  const value = normalize(condition.value);
  return candidates.some(candidate => {
    const actual = normalize(candidate);
    return condition.operator === 'equals' ? actual === value : condition.operator === 'contains' ? actual.includes(value) : actual.startsWith(value);
  });
}
export function emailRuleMatchesRecord(record: Pick<EmailRulePreviewRecord, 'folders' | 'data'>, rule: EmailRuleContent): boolean {
  const matched = rule.match === 'all' ? rule.conditions.every(condition => conditionMatches(record, condition))
    : rule.conditions.some(condition => conditionMatches(record, condition));
  return matched && !rule.exceptions.some(condition => conditionMatches(record, condition));
}
export function emailRuleEffectiveMatches(record: Pick<EmailRulePreviewRecord, 'folders' | 'data'>,
  rules: readonly Readonly<{ rule_id: string; revision: number; content: EmailRuleContent }>[]) {
  const matched: { rule_id: string; revision: number; actions: EmailRuleContent['actions'] }[] = [];
  for (const rule of rules) {
    if (!emailRuleMatchesRecord(record, rule.content)) continue;
    matched.push({ rule_id: rule.rule_id, revision: rule.revision, actions: rule.content.actions });
    if (rule.content.stop_processing) break;
  }
  return matched;
}

/** Owner-local rules and bounded preview. Preview reads only an ordinary cached
 * mailbox page, makes no provider writes, and never claims mailbox completion. */
export class EmailRuleService {
  constructor(private readonly authority: EmailAuthority, private readonly store: EmailRuleStore,
    private readonly mailbox: EmailRulePreviewMailbox, private readonly now = Date.now) {}

  private async authorize(actorRaw: EmailActor, scopeRaw: EmailScope, operation: 'human_read' | 'human_draft', signal?: AbortSignal) {
    let actor: EmailActor, scope: EmailScope;
    try { actor = Object.freeze(Actor.parse(actorRaw)); scope = Object.freeze(Scope.parse(scopeRaw)); } catch { throw denied(); }
    if (actor.user_id !== scope.owner_user_id || actor.access_expires_at <= this.now()) throw denied();
    let capability: EmailCapability;
    try { capability = structuredClone(await this.authority.current(actor, scope, operation, undefined, signal)); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    const check = (value: EmailCapability) => {
      if (!sameScope(scope, value.scope) || !Number.isFinite(value.expires_at) || value.expires_at <= this.now()
        || !value.resource_binding_id || !value.authority_version || value.resource_binding_id !== capability.resource_binding_id
        || value.authority_version !== capability.authority_version) throw denied();
    };
    check(capability);
    const current = async (transaction?: unknown) => {
      signal?.throwIfAborted();
      try { check(await this.authority.current(actor, scope, operation, transaction, signal)); }
      catch (error) { if (signal?.aborted) throw error; throw denied(); }
    };
    const guard: EmailRuleGuard = transaction => current(transaction);
    const recheck = () => current();
    return { actor, scope, guard, recheck };
  }

  async create(actor: EmailActor, scope: EmailRuleScope, id: string, content: unknown, signal?: AbortSignal, state: 'active'|'paused' = 'active') {
    const auth = await this.authorize(actor, scope, 'human_draft', signal);
    try { const rule = await this.store.create(auth.scope, id, content, auth.guard, signal, state); await auth.recheck(); return rule; }
    catch (error) { throw this.map(error, signal); }
  }
  async read(actor: EmailActor, scope: EmailRuleScope, id: string, signal?: AbortSignal) {
    const auth = await this.authorize(actor, scope, 'human_read', signal);
    try { const value = await this.store.read(auth.scope, id, auth.guard, signal); await auth.recheck();
      if (!value) throw new EmailRuleError('EMAIL_RULE_NOT_FOUND'); return value; } catch (error) { throw this.map(error, signal); }
  }
  async list(actor: EmailActor, scope: EmailRuleScope, cursor: string | null, limit: number, signal?: AbortSignal) {
    const auth = await this.authorize(actor, scope, 'human_read', signal);
    try { const result = await this.store.list(auth.scope, cursor, limit, auth.guard, signal); await auth.recheck(); return result; }
    catch (error) { throw this.map(error, signal); }
  }
  async update(actor: EmailActor, scope: EmailRuleScope, id: string, expectedRevision: number, content: unknown,
    state: 'active' | 'paused', signal?: AbortSignal) {
    const auth = await this.authorize(actor, scope, 'human_draft', signal);
    try { const value = await this.store.update(auth.scope, id, expectedRevision, content, state, auth.guard, signal); await auth.recheck(); return value; }
    catch (error) { throw this.map(error, signal); }
  }
  async archive(actor: EmailActor, scope: EmailRuleScope, id: string, expectedRevision: number, signal?: AbortSignal) {
    const auth = await this.authorize(actor, scope, 'human_draft', signal);
    try { const value = await this.store.archive(auth.scope, id, expectedRevision, auth.guard, signal); await auth.recheck(); return value; }
    catch (error) { throw this.map(error, signal); }
  }
  async reorder(actor: EmailActor, scope: EmailRuleScope, order: readonly Readonly<{ rule_id: string; expected_revision: number }>[], signal?: AbortSignal) {
    const auth = await this.authorize(actor, scope, 'human_draft', signal);
    try { const result = await this.store.reorder(auth.scope, order, auth.guard, signal); await auth.recheck(); return result; }
    catch (error) { throw this.map(error, signal); }
  }

  async preview(actorRaw: EmailActor, scopeRaw: EmailRuleScope, rawRequest: unknown, signal?: AbortSignal): Promise<EmailRulePreviewPage> {
    const request = EmailRulePreviewRequestSchema.parse(rawRequest);
    const auth = await this.authorize(actorRaw, scopeRaw, 'human_read', signal);
    try {
      const page = await this.mailbox.list(auth.actor, auth.scope, {folder:request.folder,cursor:request.cursor,limit:request.limit}, signal); await auth.recheck();
      if (page.account_id !== auth.scope.account_id || page.items.length > request.limit
        || page.items.some(record => record.account_id !== auth.scope.account_id)) throw new Error('EMAIL_RULE_UNAVAILABLE');
      const rules = await this.store.active(auth.scope, auth.guard, signal); await auth.recheck();
      const items = page.items.map(record => {
        const matches: { rule_id: string; revision: number; actions: readonly EmailRuleContent['actions'][number][] }[] = [];
        for (const rule of rules) {
          if (!emailRuleMatchesRecord(record, EmailRuleContentSchema.parse(rule.content))) continue;
          matches.push({ rule_id: rule.rule_id, revision: rule.revision, actions: rule.content.actions });
          if (rule.content.stop_processing) break;
        }
        const label=(value:unknown)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ').slice(0,512):'';
        return Object.freeze({ logical_message_id: record.logical_message_id, ...(request.include_labels?{subject: label(record.data.subject), sender: label(record.data.sender)}:{}), matches: Object.freeze(matches) });
      });
      return Object.freeze({ folder: request.folder, items: Object.freeze(items), next_cursor: page.next_cursor, has_more: page.next_cursor !== null,
        mailbox_coverage: page.coverage, sync_state: page.sync_state, scope: 'current_cached_page', execution_location: 'deft_service' });
    } catch (error) { throw this.map(error, signal); }
  }

  private map(error: unknown, signal?: AbortSignal): EmailRuleError {
    if (signal?.aborted) throw error;
    if (error instanceof EmailRuleError) return error;
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
    if (message === 'EMAIL_RULE_CONFLICT' || message.includes('unique constraint')) return new EmailRuleError('EMAIL_RULE_CONFLICT');
    if (message === 'EMAIL_RULE_NOT_FOUND') return new EmailRuleError('EMAIL_RULE_NOT_FOUND');
    if (message === 'EMAIL_RULE_INVALID' || error instanceof z.ZodError) return new EmailRuleError('EMAIL_RULE_INVALID');
    return new EmailRuleError('EMAIL_RULE_UNAVAILABLE');
  }
}
