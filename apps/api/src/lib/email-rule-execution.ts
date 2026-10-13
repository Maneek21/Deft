import { createHash, randomUUID } from 'node:crypto';
import { canonicalCapabilityJson } from '@deft/shared';
import { z } from 'zod';
import { AppRunSecretEnvelopeSchema } from './app-run-secrets.js';
import type { EmailActor, EmailAuthority, EmailScope } from './email-mailbox-service.js';
import { emailRuleEffectiveMatches, type EmailRuleMailboxPage, type EmailRuleService as EmailRuleServiceType } from './email-rule-service.js';
import type { EmailRuleService } from './email-rule-service.js';
import type { EmailRuleReceipt, EmailRuleReceiptCipher, EmailRuleReceiptGuard, EmailRuleReceiptKey, EmailRuleReceiptStore } from './email-rule-receipt-store.js';
import type { EmailNativeTriageService } from './email-native-triage.js';
import { EmailRuleContentSchema, EmailRuleIdSchema, EmailRulePreviewRequestSchema, type EmailRuleAction, type EmailRuleContent,
  type EmailRuleScope, EmailRuleError } from './email-rule-types.js';

const Id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const LogicalId = z.string().regex(/^mail_[a-f0-9]{64}$/u);
export const EmailRuleReviewRequestSchema = z.strictObject({ expected_revision: z.number().int().min(1).max(2147483646),
  folder: z.string().min(1).max(128).refine(value => value.trim() === value), cursor: z.string().min(1).max(8192).nullable(),
  limit: z.number().int().min(1).max(50), logical_message_ids: z.array(LogicalId).min(1).max(25)
    .refine(ids => new Set(ids).size === ids.length) });
const ReceiptValueSchema = z.strictObject({ logical_message_id: LogicalId, source_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  action: z.enum(['mark_read','mark_unread','star','unstar','archive','trash']) });
const Target = z.strictObject({ logical_message_id: LogicalId, source_digest: z.string().regex(/^[a-f0-9]{64}$/u), actions: z.array(z.enum(['mark_read','mark_unread','star','unstar','archive','trash'])).min(1).max(6) });
const ReviewPayload = z.strictObject({ schema_version: z.literal('deft.email_rule_review.v1'), review_id: z.string().uuid(),
  org_id: Id, owner_user_id: Id, account_id: Id, rule_id: EmailRuleIdSchema, rule_revision: z.number().int().positive(),
  rule_set_digest: z.string().regex(/^[a-f0-9]{64}$/u), request: EmailRulePreviewRequestSchema, targets: z.array(Target).min(1).max(25),
  expires_at: z.number().finite() });
const TokenOuter = z.strictObject({ review_id: z.string().uuid(), rule_revision: z.number().int().positive(), envelope: AppRunSecretEnvelopeSchema });
const sameScope = (a: EmailScope, b: EmailScope) => a.org_id === b.org_id && a.owner_user_id === b.owner_user_id && a.account_id === b.account_id;
const denied = () => new EmailRuleError('EMAIL_RULE_ACCESS_DENIED');
const unavailable = () => new EmailRuleError('EMAIL_RULE_UNAVAILABLE');
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
const sourceFingerprint = (record: { account_id: string; logical_message_id: string; revision: string; provider_source?: unknown }) => fingerprint([
  record.account_id, record.logical_message_id, record.revision, record.provider_source,
]);
const receiptKey = (ruleId: string, revision: number, logicalId: string, actionIndex: number): EmailRuleReceiptKey => ({
  rule_id: ruleId, rule_revision: revision, logical_message_id: logicalId, action_index: actionIndex,
});
const receiptState = (state: string): 'succeeded' | 'failed' | 'unknown' | 'prepared' =>
  state === 'succeeded' ? 'succeeded' : state === 'failed' ? 'failed' : state === 'prepared' ? 'prepared' : 'unknown';

export type EmailRuleExecutionMailbox = Readonly<{
  list(actor: EmailActor, scope: EmailScope, request: Readonly<{ folder: string; cursor: string | null; limit: number }>, signal?: AbortSignal): Promise<EmailRuleMailboxPage>;
  readMessage(scope: EmailScope, logicalId: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>> | null>;
}>;
export type EmailRuleExecutionResult = Readonly<{ rule_id: string; rule_revision: number; items: readonly Readonly<{
  logical_message_id: string; action: EmailRuleAction; state: 'applied' | 'failed' | 'unknown' | 'reserved' | 'conflict'; code?: string;
}>[] }>;

/** Explicit human review/apply only. Automatic event dispatch is a separate,
 * leased authority lane and is intentionally not present here. */
export class EmailRuleExecutionService {
  constructor(private readonly authority: EmailAuthority, private readonly rules: Pick<EmailRuleService, 'list' | 'preview'>,
    private readonly mailbox: EmailRuleExecutionMailbox, private readonly receipts: Pick<EmailRuleReceiptStore, 'prepare' | 'transition'>,
    private readonly receiptCipher: EmailRuleReceiptCipher, private readonly triage: Pick<EmailNativeTriageService, 'apply'>,
    private readonly now = Date.now) {}

  private async authorized(actorRaw: EmailActor, scopeRaw: EmailRuleScope, signal?: AbortSignal) {
    let actor: EmailActor, scope: EmailScope;
    try { actor = Object.freeze({ ...actorRaw }); scope = Object.freeze({ org_id: Id.parse(scopeRaw.org_id), owner_user_id: Id.parse(scopeRaw.owner_user_id), account_id: Id.parse(scopeRaw.account_id) }); }
    catch { throw denied(); }
    if (actor.user_id !== scope.owner_user_id || !Number.isFinite(actor.access_expires_at) || actor.access_expires_at <= this.now()) throw denied();
    const capability = await this.current(actor, scope, undefined, undefined, signal);
    const guard: EmailRuleReceiptGuard = async tx => { await this.current(actor, scope, capability, tx, signal); };
    return { actor, scope, capability, guard };
  }
  private async current(actor: EmailActor, scope: EmailScope, expected?: { resource_binding_id: string; authority_version: string },
    transaction?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted(); let cap;
    try { cap = await this.authority.current(actor, scope, 'human_modify', transaction, signal); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    if (!sameScope(scope, cap.scope) || !Number.isFinite(cap.expires_at) || cap.expires_at <= this.now() || !cap.resource_binding_id
      || !cap.authority_version || expected && (cap.resource_binding_id !== expected.resource_binding_id || cap.authority_version !== expected.authority_version)) throw denied();
    return cap;
  }
  private async listRules(actor: EmailActor, scope: EmailScope, signal?: AbortSignal) {
    const first = await this.rules.list(actor, scope, null, 50, signal);
    if (!first.has_more) return first.items;
    if (!first.next_cursor) throw unavailable();
    const second = await this.rules.list(actor, scope, first.next_cursor, 50, signal);
    if (second.has_more || second.items.length + first.items.length > 100) throw unavailable();
    return [...first.items, ...second.items];
  }

  async review(actorRaw: EmailActor, scopeRaw: EmailRuleScope, ruleIdRaw: string, rawRequest: unknown, signal?: AbortSignal) {
    const request = EmailRuleReviewRequestSchema.parse(rawRequest), ruleId = EmailRuleIdSchema.parse(ruleIdRaw);
    const auth = await this.authorized(actorRaw, scopeRaw, signal);
    const listedRules = await this.listRules(auth.actor, auth.scope, signal);
    const selected = listedRules.find(rule => rule.rule_id === ruleId);
    if (!selected || selected.state !== 'active' || selected.revision !== request.expected_revision) throw new EmailRuleError('EMAIL_RULE_CONFLICT');
    const currentRules = listedRules.filter(rule => rule.state === 'active');
    const pageRequest = { folder: request.folder, cursor: request.cursor, limit: request.limit };
    const page = await this.mailbox.list(auth.actor, auth.scope, pageRequest, signal);
    await this.current(auth.actor, auth.scope, auth.capability, undefined, signal);
    if (page.account_id !== auth.scope.account_id || page.items.length > request.limit) throw unavailable();
    const pageById = new Map(page.items.map(item => [item.logical_message_id, item]));
    const targets: z.infer<typeof Target>[] = [];
    for (const id of request.logical_message_ids) {
      const record = pageById.get(id);
      if (!record) throw new EmailRuleError('EMAIL_RULE_INVALID');
      const sequence = emailRuleEffectiveMatches(record, currentRules);
      const selectedMatch = sequence.find(match => match.rule_id === selected.rule_id && match.revision === selected.revision);
      if (!selectedMatch) throw new EmailRuleError('EMAIL_RULE_CONFLICT');
      const source = await this.mailbox.readMessage(auth.scope, id, signal) as { account_id?: string; logical_message_id?: string; revision?: string; provider_source?: unknown } | null;
      await this.current(auth.actor, auth.scope, auth.capability, undefined, signal);
      if (!source || source.account_id !== auth.scope.account_id || source.logical_message_id !== id || !source.provider_source) throw unavailable();
      targets.push({ logical_message_id: id, source_digest: sourceFingerprint(source as never), actions: [...selectedMatch.actions] });
    }
    const orderDigest = fingerprint(listedRules.map(({ rule_id, revision, state, order_index }) => [rule_id, revision, state, order_index]));
    const reviewId = randomUUID(), expiresAt = this.now() + 5 * 60_000;
    const payload = ReviewPayload.parse({ schema_version: 'deft.email_rule_review.v1', review_id: reviewId, ...auth.scope,
      rule_id: selected.rule_id, rule_revision: selected.revision, rule_set_digest: orderDigest, request: pageRequest, targets, expires_at: expiresAt });
    const context = { ...auth.scope, kind: 'rule' as const, record_id: `rule-review:${reviewId}`, revision: selected.revision };
    const envelope = AppRunSecretEnvelopeSchema.parse(this.receiptCipher.seal(payload, context));
    const token = Buffer.from(JSON.stringify({ review_id: reviewId, rule_revision: selected.revision, envelope })).toString('base64url');
    await this.current(auth.actor, auth.scope, auth.capability, undefined, signal);
    return Object.freeze({ rule_id: selected.rule_id, rule_revision: selected.revision, targets: Object.freeze(targets.map(({ logical_message_id, actions }) => ({ logical_message_id, actions }))),
      review_token: token, expires_at: new Date(expiresAt).toISOString(), scope: 'selected_current_cached_page' as const });
  }

  private openToken(scope: EmailScope, encoded: string) {
    try {
      if (encoded.length > 80_000 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error();
      const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) throw new Error();
      const outer = TokenOuter.parse(JSON.parse(bytes.toString('utf8')));
      const context = { ...scope, kind: 'rule' as const, record_id: `rule-review:${outer.review_id}`, revision: outer.rule_revision };
      const payload = ReviewPayload.parse(this.receiptCipher.open(outer.envelope, context));
      if (payload.review_id !== outer.review_id || payload.rule_revision !== outer.rule_revision || !sameScope(scope, payload)
        || payload.expires_at <= this.now() || payload.expires_at > this.now() + 5 * 60_000) throw new Error();
      return payload;
    } catch { throw new EmailRuleError('EMAIL_RULE_INVALID'); }
  }

  async execute(actorRaw: EmailActor, scopeRaw: EmailRuleScope, tokenRaw: unknown, signal?: AbortSignal): Promise<EmailRuleExecutionResult> {
    const token = z.string().min(1).max(80_000).parse(tokenRaw), auth = await this.authorized(actorRaw, scopeRaw, signal), payload = this.openToken(auth.scope, token);
    const listedRules = await this.listRules(auth.actor, auth.scope, signal), selected = listedRules.find(rule => rule.rule_id === payload.rule_id);
    const digest = fingerprint(listedRules.map(({ rule_id, revision, state, order_index }) => [rule_id, revision, state, order_index]));
    if (!selected || selected.state !== 'active' || selected.revision !== payload.rule_revision || digest !== payload.rule_set_digest) throw new EmailRuleError('EMAIL_RULE_CONFLICT');
    EmailRuleContentSchema.parse(selected.content);
    const page = await this.mailbox.list(auth.actor, auth.scope, payload.request, signal);
    if (page.account_id !== auth.scope.account_id || page.items.length > payload.request.limit) throw unavailable();
    const pageById = new Map(page.items.map(item => [item.logical_message_id, item]));
    const output: { logical_message_id: string; action: EmailRuleAction; state: 'applied' | 'failed' | 'unknown' | 'reserved' | 'conflict'; code?: string }[] = [];
    for (const target of payload.targets) {
      const cached = pageById.get(target.logical_message_id);
      if (!cached || !emailRuleEffectiveMatches(cached, listedRules.filter(rule => rule.state === 'active'))
        .some(match => match.rule_id === selected.rule_id && match.revision === selected.revision)) throw new EmailRuleError('EMAIL_RULE_CONFLICT');
      const source = await this.mailbox.readMessage(auth.scope, target.logical_message_id, signal) as { account_id?: string; logical_message_id?: string; provider_source?: unknown } | null;
      if (!source || source.account_id !== auth.scope.account_id || source.logical_message_id !== target.logical_message_id
        || sourceFingerprint(source as never) !== target.source_digest) throw new EmailRuleError('EMAIL_RULE_CONFLICT');
      for (let actionIndex = 0; actionIndex < target.actions.length; actionIndex++) {
        const action = target.actions[actionIndex]!;
        await this.current(auth.actor, auth.scope, auth.capability, undefined, signal);
        const key = receiptKey(payload.rule_id, payload.rule_revision, target.logical_message_id, actionIndex);
        let receipt = await this.receipts.prepare(auth.scope, key, target.source_digest, action, auth.guard, signal);
        if (receipt.state === 'applied' || receipt.state === 'failed' || receipt.state === 'conflict') {
          output.push({ logical_message_id: target.logical_message_id, action, state: receipt.state }); continue;
        }
        if (receipt.state === 'planned') receipt = await this.receipts.transition(auth.scope, receipt, 'reserved', undefined, auth.guard, signal);
        try {
          const result = await this.triage.apply(auth.actor, auth.scope, { operation_id: receipt.operation_id, kind: action,
            logical_message_ids: [target.logical_message_id], expected_source_digests: { [target.logical_message_id]: target.source_digest } }, signal);
          await this.current(auth.actor, auth.scope, auth.capability, undefined, signal);
          const item = result.items.find(value => value.logical_message_id === target.logical_message_id);
          if (!item) throw unavailable();
          const state = item.state === 'succeeded' ? 'applied' : item.state === 'failed' ? 'failed' : 'unknown';
          await this.receipts.transition(auth.scope, receipt, state, { state: receiptState(item.state), ...(item.code ? { code: item.code } : {}) }, auth.guard, signal);
          output.push({ logical_message_id: target.logical_message_id, action, state, ...(item.code ? { code: item.code } : {}) });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code === 'EMAIL_TRIAGE_BUSY') { output.push({ logical_message_id: target.logical_message_id, action, state: 'reserved' }); continue; }
          if (receipt.state === 'reserved') await this.receipts.transition(auth.scope, receipt, 'unknown', { state: 'unknown' }, auth.guard).catch(() => {});
          output.push({ logical_message_id: target.logical_message_id, action, state: 'unknown' });
        }
      }
    }
    await this.current(auth.actor, auth.scope, auth.capability, undefined, signal);
    return Object.freeze({ rule_id: payload.rule_id, rule_revision: payload.rule_revision, items: Object.freeze(output.map(item => Object.freeze(item))) });
  }
}
