import { z } from 'zod';
import type { EmailMessageRecord, EmailScope } from './email-mailbox-service.js';

const Id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const EmailRuleIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu);
const Value = z.string().trim().min(1).max(256).refine(value => Buffer.byteLength(value, 'utf8') <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const MatchField = z.enum(['from', 'to', 'cc', 'subject', 'folder']);
export const EmailRuleConditionSchema = z.strictObject({ field: MatchField, operator: z.enum(['equals', 'contains', 'starts_with']), value: Value });
export const EmailRuleContentSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).refine(value => Buffer.byteLength(value, 'utf8') <= 160 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
  match: z.enum(['all', 'any']),
  conditions: z.array(EmailRuleConditionSchema).min(1).max(10),
  exceptions: z.array(EmailRuleConditionSchema).max(10),
  actions: z.array(z.enum(['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash'])).min(1).max(6)
    .refine(actions => new Set(actions).size === actions.length),
  stop_processing: z.boolean(),
  execution_location: z.literal('deft_service'),
}).refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32 * 1024);
export const EmailRuleStateSchema = z.enum(['active', 'paused', 'archived']);
export const EmailRuleCreateSchema = z.strictObject({ rule_id: EmailRuleIdSchema, content: EmailRuleContentSchema, state: z.enum(['active','paused']).default('active') });
export const EmailRuleUpdateSchema = z.strictObject({ expected_revision: z.number().int().min(1).max(2147483646),
  content: EmailRuleContentSchema, state: z.enum(['active', 'paused']) });
export const EmailRuleArchiveSchema = z.strictObject({ expected_revision: z.number().int().min(1).max(2147483646) });
export const EmailRuleOrderSchema = z.strictObject({ rules: z.array(z.strictObject({ rule_id: EmailRuleIdSchema,
  expected_revision: z.number().int().min(1).max(2147483646) })).min(1).max(100)
  .refine(rules => new Set(rules.map(rule => rule.rule_id)).size === rules.length) });
export const EmailRuleListQuerySchema = z.strictObject({ cursor: z.string().min(1).max(8192).nullable(), limit: z.number().int().min(1).max(50) });
export const EmailRulePreviewRequestSchema = z.strictObject({ folder: z.string().min(1).max(128).refine(value => value.trim() === value),
  cursor: z.string().min(1).max(8192).nullable(), limit: z.number().int().min(1).max(50), include_labels: z.boolean().default(false) });
export const EmailRuleScopeSchema = z.strictObject({ org_id: Id, owner_user_id: Id, account_id: Id });
export const EmailRuleActorSchema = z.strictObject({ user_id: Id, web_session_id: Id, access_expires_at: z.number().finite() });

export type EmailRuleContent = Readonly<z.infer<typeof EmailRuleContentSchema>>;
export type EmailRuleAction = EmailRuleContent['actions'][number];
export type EmailRuleCondition = Readonly<z.infer<typeof EmailRuleConditionSchema>>;
export type EmailRuleState = z.infer<typeof EmailRuleStateSchema>;
export type EmailRule = Readonly<{ rule_id: string; account_id: string; revision: number; state: EmailRuleState;
  order_index: number; content: EmailRuleContent; created_at: string; updated_at: string }>;
export type EmailRulePage = Readonly<{ items: readonly EmailRule[]; next_cursor: string | null; has_more: boolean }>;
export type EmailRulePreviewPage = Readonly<{ folder: string; items: readonly Readonly<{ logical_message_id: string; subject?: string; sender?: string;
  matches: readonly Readonly<{ rule_id: string; revision: number; actions: readonly (EmailRuleContent['actions'][number])[] }>[] }>[];
  next_cursor: string | null; has_more: boolean; mailbox_coverage: 'partial' | 'complete'; sync_state: string;
  scope: 'current_cached_page'; execution_location: 'deft_service' }>;
export type EmailRuleScope = EmailScope;
export type EmailRuleMessage = EmailMessageRecord;

export class EmailRuleError extends Error {
  constructor(readonly code: 'EMAIL_RULE_ACCESS_DENIED' | 'EMAIL_RULE_INVALID' | 'EMAIL_RULE_CONFLICT'
    | 'EMAIL_RULE_NOT_FOUND' | 'EMAIL_RULE_UNAVAILABLE') { super(code); this.name = 'EmailRuleError'; }
}
