import { createHash } from 'node:crypto';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { canonicalCapabilityJson } from '@deft/shared';
import { emailRules } from '@deft/db/schema';
import { AppRunSecretEnvelopeSchema } from './app-run-secrets.js';
import type { EmailScope } from './email-mailbox-service.js';
import { EmailRuleContentSchema, EmailRuleIdSchema, type EmailRule, type EmailRuleContent,
  type EmailRulePage, type EmailRuleState } from './email-rule-types.js';

const schema = { emailRules };
type Database = Pick<NodePgDatabase<any>, 'transaction'>;
export type EmailRuleCryptoContext = Readonly<{ org_id: string; owner_user_id: string; account_id: string;
  kind: 'rule'; record_id: string; revision: number }>;
export type EmailRuleCipher = Readonly<{ seal(value: unknown, context: EmailRuleCryptoContext): unknown;
  open(envelope: unknown, context: EmailRuleCryptoContext): unknown }>;
export type EmailRuleGuard = (transaction: unknown) => Promise<void>;
const scoped = (scope: EmailScope, id?: string) => and(eq(emailRules.org_id, scope.org_id), eq(emailRules.owner_user_id, scope.owner_user_id),
  eq(emailRules.account_id, scope.account_id), id === undefined ? undefined : eq(emailRules.rule_id, id));
const context = (scope: EmailScope, id: string, revision: number): EmailRuleCryptoContext => ({ ...scope, kind: 'rule', record_id: `rule:${id}`, revision });
const cursorContext = (scope: EmailScope): EmailRuleCryptoContext => ({ ...scope, kind: 'rule', record_id: 'rule-list-cursor', revision: 0 });
const Cursor = z.strictObject({ schema_version: z.literal('deft.email_rule_cursor.v1'), org_id: z.string().min(1).max(256),
  owner_user_id: z.string().min(1).max(256), account_id: z.string().min(1).max(256), order_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  order_index: z.number().int().nonnegative(), rule_id: EmailRuleIdSchema, expires_at: z.number().finite() });
const MAX_RULES = 100, CURSOR_TTL_MS = 15 * 60_000;

function orderDigest(rows: readonly typeof emailRules.$inferSelect[]): string {
  return createHash('sha256').update(canonicalCapabilityJson(rows.map(row => [row.rule_id, row.revision, row.state, row.order_index]))).digest('hex');
}
function materialize(cipher: EmailRuleCipher, scope: EmailScope, row: typeof emailRules.$inferSelect): EmailRule {
  const content = EmailRuleContentSchema.parse(cipher.open(row.content_envelope, context(scope, row.rule_id, row.revision)));
  return Object.freeze({ rule_id: row.rule_id, account_id: row.account_id, revision: row.revision, state: row.state,
    order_index: row.order_index, content, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() });
}
function seal(cipher: EmailRuleCipher, scope: EmailScope, id: string, revision: number, value: EmailRuleContent) {
  return AppRunSecretEnvelopeSchema.parse(cipher.seal(EmailRuleContentSchema.parse(value), context(scope, id, revision)));
}
function cursorOpen(cipher: EmailRuleCipher, scope: EmailScope, encoded: string | null, digest: string, now: number) {
  if (encoded === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 8192) throw new Error();
    const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) throw new Error();
    const cursor = Cursor.parse(cipher.open(AppRunSecretEnvelopeSchema.parse(JSON.parse(bytes.toString('utf8'))), cursorContext(scope)));
    if (cursor.org_id !== scope.org_id || cursor.owner_user_id !== scope.owner_user_id || cursor.account_id !== scope.account_id
      || cursor.order_digest !== digest || cursor.expires_at <= now) throw new Error();
    return cursor;
  } catch { throw new Error('EMAIL_RULE_INVALID'); }
}
function cursorSeal(cipher: EmailRuleCipher, scope: EmailScope, digest: string, row: typeof emailRules.$inferSelect, now: number) {
  const value = { schema_version: 'deft.email_rule_cursor.v1', ...scope, order_digest: digest, order_index: row.order_index,
    rule_id: row.rule_id, expires_at: now + CURSOR_TTL_MS };
  return Buffer.from(JSON.stringify(cipher.seal(value, cursorContext(scope)))).toString('base64url');
}

/** Encrypted per-account rules with CAS edits and order-snapshot cursors. */
export class EmailRuleStore {
  constructor(private readonly database: Database, private readonly cipher: EmailRuleCipher, private readonly now = () => new Date()) {}

  async create(scope: EmailScope, ruleId: string, rawContent: unknown, guard: EmailRuleGuard, signal?: AbortSignal, state: 'active'|'paused' = 'active'): Promise<EmailRule> {
    if (state !== 'active' && state !== 'paused') throw new Error('EMAIL_RULE_INVALID');
    const id = EmailRuleIdSchema.parse(ruleId), content = EmailRuleContentSchema.parse(rawContent); signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['email-rules', scope.org_id, scope.owner_user_id, scope.account_id])},0))`);
      const [existing] = await tx.select().from(emailRules).where(scoped(scope, id)).limit(1).for('update');
      if (existing) {
        const replay = materialize(this.cipher, scope, existing);
        if (existing.state !== state || existing.revision !== 1 || canonicalCapabilityJson(replay.content) !== canonicalCapabilityJson(content)) throw new Error('EMAIL_RULE_CONFLICT');
        await guard(tx); return replay;
      }
      const rows = await tx.select({ order_index: emailRules.order_index }).from(emailRules).where(and(scoped(scope), sql`${emailRules.state}<>'archived'`));
      if (rows.length >= MAX_RULES) throw new Error('EMAIL_RULE_INVALID');
      const orderIndex = rows.reduce((max, row) => Math.max(max, row.order_index), -1) + 1, now = this.now();
      const [created] = await tx.insert(emailRules).values({ ...scope, rule_id: id, revision: 1, state, order_index: orderIndex,
        content_envelope: seal(this.cipher, scope, id, 1, content), created_at: now, updated_at: now }).onConflictDoNothing().returning();
      if (!created) throw new Error('EMAIL_RULE_CONFLICT');
      await guard(tx); signal?.throwIfAborted(); return materialize(this.cipher, scope, created);
    });
  }

  async read(scope: EmailScope, ruleId: string, guard: EmailRuleGuard, signal?: AbortSignal): Promise<EmailRule | null> {
    const id = EmailRuleIdSchema.parse(ruleId); signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted(); const [row] = await tx.select().from(emailRules).where(scoped(scope, id)).limit(1);
      await guard(tx); signal?.throwIfAborted(); return row ? materialize(this.cipher, scope, row) : null;
    });
  }

  async list(scope: EmailScope, cursor: string | null, limit: number, guard: EmailRuleGuard, signal?: AbortSignal): Promise<EmailRulePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || cursor !== null && (typeof cursor !== 'string' || cursor.length > 8192)) throw new Error('EMAIL_RULE_INVALID');
    signal?.throwIfAborted(); return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const rows = await tx.select().from(emailRules).where(and(scoped(scope), sql`${emailRules.state}<>'archived'`))
        .orderBy(asc(emailRules.order_index), asc(emailRules.rule_id)).limit(MAX_RULES + 1);
      if (rows.length > MAX_RULES) throw new Error('EMAIL_RULE_UNAVAILABLE');
      const digest = orderDigest(rows), after = cursorOpen(this.cipher, scope, cursor, digest, this.now().getTime());
      const remaining = after ? rows.filter(row => row.order_index > after.order_index || row.order_index === after.order_index && row.rule_id > after.rule_id) : rows;
      const selected = remaining.slice(0, limit), hasMore = remaining.length > limit, last = selected.at(-1);
      await guard(tx); signal?.throwIfAborted();
      return Object.freeze({ items: Object.freeze(selected.map(row => materialize(this.cipher, scope, row))),
        has_more: hasMore, next_cursor: hasMore && last ? cursorSeal(this.cipher, scope, digest, last, this.now().getTime()) : null });
    });
  }

  async active(scope: EmailScope, guard: EmailRuleGuard, signal?: AbortSignal): Promise<readonly EmailRule[]> {
    signal?.throwIfAborted(); return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted(); const rows = await tx.select().from(emailRules).where(and(scoped(scope), eq(emailRules.state, 'active')))
        .orderBy(asc(emailRules.order_index), asc(emailRules.rule_id)).limit(MAX_RULES + 1);
      if (rows.length > MAX_RULES) throw new Error('EMAIL_RULE_UNAVAILABLE');
      await guard(tx); signal?.throwIfAborted(); return Object.freeze(rows.map(row => materialize(this.cipher, scope, row)));
    });
  }

  async update(scope: EmailScope, ruleId: string, expectedRevision: number, rawContent: unknown, state: 'active' | 'paused',
    guard: EmailRuleGuard, signal?: AbortSignal): Promise<EmailRule> {
    const id = EmailRuleIdSchema.parse(ruleId), content = EmailRuleContentSchema.parse(rawContent);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 2147483646) throw new Error('EMAIL_RULE_INVALID');
    signal?.throwIfAborted(); return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted(); const [row] = await tx.select().from(emailRules).where(scoped(scope, id)).limit(1).for('update');
      if (!row || row.state === 'archived' || row.revision !== expectedRevision) throw new Error('EMAIL_RULE_CONFLICT');
      const revision = row.revision + 1, now = this.now();
      const [updated] = await tx.update(emailRules).set({ revision, state, content_envelope: seal(this.cipher, scope, id, revision, content), updated_at: now })
        .where(and(scoped(scope, id), eq(emailRules.revision, expectedRevision), sql`${emailRules.state}<>'archived'`)).returning();
      if (!updated) throw new Error('EMAIL_RULE_CONFLICT'); await guard(tx); signal?.throwIfAborted(); return materialize(this.cipher, scope, updated);
    });
  }

  async archive(scope: EmailScope, ruleId: string, expectedRevision: number, guard: EmailRuleGuard, signal?: AbortSignal): Promise<EmailRule> {
    const id = EmailRuleIdSchema.parse(ruleId); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 2147483646) throw new Error('EMAIL_RULE_INVALID');
    signal?.throwIfAborted(); return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted(); const [row] = await tx.select().from(emailRules).where(scoped(scope, id)).limit(1).for('update');
      if (!row || row.state === 'archived' || row.revision !== expectedRevision) throw new Error('EMAIL_RULE_CONFLICT');
      const revision = row.revision + 1, content = materialize(this.cipher, scope, row).content, now = this.now();
      const [updated] = await tx.update(emailRules).set({ revision, state: 'archived', content_envelope: seal(this.cipher, scope, id, revision, content), updated_at: now })
        .where(and(scoped(scope, id), eq(emailRules.revision, expectedRevision), sql`${emailRules.state}<>'archived'`)).returning();
      if (!updated) throw new Error('EMAIL_RULE_CONFLICT'); await guard(tx); signal?.throwIfAborted(); return materialize(this.cipher, scope, updated);
    });
  }

  async reorder(scope: EmailScope, order: readonly Readonly<{ rule_id: string; expected_revision: number }>[], guard: EmailRuleGuard,
    signal?: AbortSignal): Promise<readonly EmailRule[]> {
    signal?.throwIfAborted(); return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['email-rules', scope.org_id, scope.owner_user_id, scope.account_id])},0))`);
      const rows = await tx.select().from(emailRules).where(and(scoped(scope), sql`${emailRules.state}<>'archived'`))
        .orderBy(asc(emailRules.order_index), asc(emailRules.rule_id)).limit(MAX_RULES + 1).for('update');
      if (rows.length > MAX_RULES || rows.length !== order.length || new Set(order.map(item => item.rule_id)).size !== rows.length) throw new Error('EMAIL_RULE_CONFLICT');
      const byId = new Map(rows.map(row => [row.rule_id, row]));
      for (const item of order) { const row = byId.get(item.rule_id); if (!row || row.revision !== item.expected_revision || row.revision >= 2147483647) throw new Error('EMAIL_RULE_CONFLICT'); }
      const updated: typeof emailRules.$inferSelect[] = [];
      for (let index = 0; index < order.length; index++) {
        const item = order[index]!, row = byId.get(item.rule_id)!, revision = row.revision + 1, content = materialize(this.cipher, scope, row).content;
        const [value] = await tx.update(emailRules).set({ order_index: index, revision, content_envelope: seal(this.cipher, scope, row.rule_id, revision, content), updated_at: this.now() })
          .where(and(scoped(scope, row.rule_id), eq(emailRules.revision, item.expected_revision))).returning();
        if (!value) throw new Error('EMAIL_RULE_CONFLICT'); updated.push(value);
      }
      await guard(tx); signal?.throwIfAborted(); return Object.freeze(updated.map(row => materialize(this.cipher, scope, row)));
    });
  }
}
