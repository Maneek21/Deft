import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { emailMessages, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { emailContextTransfers } from '../../../../packages/db/src/email-context-transfer-schema.js';
import type { db } from './db.js';
import type { EmailActor, EmailAuthority, EmailCapability, EmailScope, EmailMessageRecord } from './email-mailbox-service.js';
import { EmailMailboxError } from './email-mailbox-service.js';
import type {NativeEmailPresentation} from './email-native-adapter-contract.js';
import { createNativeKnowledge, createNativeNote, type ContextWriteDatabase } from './native-context-create.js';
import { assertNativeChatForwardDestination, createNativeChatForward, NativeChatForwardError } from './native-chat-forward.js';

const Id = z.string().min(1).max(256).refine(v => v.trim() === v && !/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const LogicalId = z.string().regex(/^mail_[a-f0-9]{64}$/u);
const Types = z.enum(['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact']);
export const EmailTransferDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('note'), visibility: z.enum(['private', 'org', 'space']).default('private'), space_id: Id.optional() })
    .refine(v => v.visibility === 'space' ? !!v.space_id : v.space_id === undefined),
  z.strictObject({ kind: z.literal('knowledge'), space_id: Id, type: Types.default('fact') }),
  z.strictObject({ kind: z.literal('chat'), space_id: Id }),
]);
export const EmailTransferReviewSchema = z.strictObject({ destination: EmailTransferDestinationSchema,
  title: z.string().trim().min(1).max(512), mode: z.enum(['source_link', 'excerpt']).default('source_link'),
  excerpt: z.string().min(1).max(20000).refine(v => !v.includes('\0')).optional(),
}).refine(v => v.mode === 'excerpt' ? !!v.excerpt : v.excerpt === undefined);
export const EmailTransferCommitSchema = EmailTransferReviewSchema.safeExtend({ source_digest: Digest, review_digest: Digest });
export type EmailTransferInput = z.infer<typeof EmailTransferReviewSchema>;
export type EmailTransferCommit = z.infer<typeof EmailTransferCommitSchema>;
export type EmailTransferAudience = { visibility: 'private' | 'org' | 'space'; label: string; member_count: number };
export type EmailTransferResult = { destination_kind: 'note' | 'knowledge' | 'chat'; destination_id: string; destination_url: string; replayed: boolean };
export class EmailContextTransferError extends Error {
  constructor(readonly code: 'EMAIL_TRANSFER_INVALID' | 'EMAIL_TRANSFER_FORBIDDEN' | 'EMAIL_TRANSFER_STALE' | 'EMAIL_TRANSFER_CONFLICT') {
    super(code); this.name = 'EmailContextTransferError';
  }
}
const canonical = (value: unknown): unknown => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const forbidden = () => new EmailContextTransferError('EMAIL_TRANSFER_FORBIDDEN');
const stale = () => new EmailContextTransferError('EMAIL_TRANSFER_STALE');
const sourceWhere = (scope: EmailScope, logicalId: string) => and(eq(emailMessages.org_id, scope.org_id),
  eq(emailMessages.owner_user_id, scope.owner_user_id), eq(emailMessages.account_id, scope.account_id),
  eq(emailMessages.logical_message_id, logicalId), isNull(emailMessages.deleted_at));
const sourceFingerprint = (row: Pick<EmailMessageRecord, 'account_id' | 'logical_message_id' | 'revision'>,
  providerSource: EmailMessageRecord['provider_source']) => digest([row.account_id, row.logical_message_id, row.revision, providerSource]);
export type EmailTransferSource = {
  source_digest: string; fingerprint: string; authority_version: string; resource_binding_id: string; plain_text: string;
};
export type EmailTransferSourceReader = {
  read(actor: EmailActor, scope: EmailScope, logicalId: string, signal?: AbortSignal, mode?: 'source_link' | 'excerpt'): Promise<EmailTransferSource>;
  guard(actor: EmailActor, scope: EmailScope, logicalId: string, expected: EmailTransferSource | null,
    tx: ContextWriteDatabase, signal?: AbortSignal): Promise<void>;
};

/** Production source seam: provider content is fetched before transaction locks.
 * The SQL-only human authority and exact encrypted source identity are then
 * rechecked while holding revocation + source locks through destination commit. */
export function createPostgresEmailTransferSource(database: ContextWriteDatabase, authority: EmailAuthority,
  readPresentation: (actor: EmailActor, scope: EmailScope, logicalId: string, signal?: AbortSignal) => Promise<NativeEmailPresentation>,
  readMessage: (scope: EmailScope, logicalId: string, signal?: AbortSignal) => Promise<EmailMessageRecord | null>,
  decodeSource: (scope: EmailScope, row: typeof emailMessages.$inferSelect) => EmailMessageRecord['provider_source'],
  now = Date.now): EmailTransferSourceReader {
  const current = async (actor: EmailActor, scope: EmailScope, tx?: unknown, signal?: AbortSignal): Promise<EmailCapability> => {
    signal?.throwIfAborted();
    if (actor.user_id !== scope.owner_user_id || actor.access_expires_at <= now()) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const capability = await authority.current(actor, scope, 'human_read', tx, signal);
    signal?.throwIfAborted();
    if (actor.access_expires_at <= now() || !Number.isFinite(capability.expires_at) || capability.expires_at <= now()
      || capability.scope.org_id !== scope.org_id || capability.scope.owner_user_id !== scope.owner_user_id
      || capability.scope.account_id !== scope.account_id) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    return capability;
  };
  const fingerprint = (scope: EmailScope, row: typeof emailMessages.$inferSelect) => {
    const source = z.record(z.string(), z.json()).parse(decodeSource(scope, row));
    if (source.schema_version !== 'deft.email_provider_source.v1' || source.account_id !== scope.account_id
      || source.logical_message_id !== row.logical_message_id || !['gmail', 'microsoft', 'imap_smtp'].includes(String(source.provider))) throw stale();
    // Re-indexing changes storage revision and randomized envelopes without
    // changing source identity. Only decrypted provider identity/revision fence
    // the review; ordinary flags, checkpoint and encryption refreshes do not.
    return sourceFingerprint(row, source);
  };
  return {
    async read(actor, scope, logicalId, signal, mode = 'source_link') {
      const first = await current(actor, scope, undefined, signal);
      const [before] = await database.select().from(emailMessages).where(sourceWhere(scope, logicalId)).limit(1);
      if (!before) throw stale();
      const beforeFingerprint = fingerprint(scope, before);
      // Source-link creates expose no body. Reuse the existing guarded encrypted
      // local record path; provider MIME/presentation is read only for excerpts.
      const presentation = mode === 'excerpt' ? await readPresentation(actor, scope, logicalId, signal) : null;
      const cached = presentation ? null : await readMessage(scope, logicalId, signal);
      if (!presentation && (!cached || cached.account_id !== scope.account_id || cached.logical_message_id !== logicalId)) throw stale();
      const last = await current(actor, scope, undefined, signal);
      const [after] = await database.select().from(emailMessages).where(sourceWhere(scope, logicalId)).limit(1);
      if (!after || beforeFingerprint !== fingerprint(scope, after)
        || first.authority_version !== last.authority_version || first.resource_binding_id !== last.resource_binding_id) throw stale();
      if (presentation && (presentation.account_id !== scope.account_id || presentation.logical_message_id !== logicalId
        || !Digest.safeParse(presentation.source_digest).success)) throw stale();
      return { source_digest: presentation?.source_digest ?? fingerprint(scope, after), fingerprint: fingerprint(scope, after),
        authority_version: last.authority_version, resource_binding_id: last.resource_binding_id,
        plain_text: presentation?.presentation.plain_text ?? '' };
    },
    async guard(actor, scope, logicalId, expected, tx, signal) {
      const cap = await current(actor, scope, tx, signal);
      const [row] = await tx.select().from(emailMessages).where(sourceWhere(scope, logicalId)).limit(1).for('share');
      if (!row || expected && (fingerprint(scope, row) !== expected.fingerprint || cap.authority_version !== expected.authority_version
        || cap.resource_binding_id !== expected.resource_binding_id)) throw stale();
    },
  };
}

async function audience(database: ContextWriteDatabase, scope: EmailScope, destination: EmailTransferInput['destination']) {
  // Lock current membership rows through writes so removal/deactivation cannot
  // race destination authorization. Review hashes identities, not just counts.
  const members = await database.select({ id: orgMembers.id, user_id: orgMembers.user_id,
    version: orgMembers.app_run_authorization_version }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, scope.org_id), eq(orgMembers.is_active, true))).for('share');
  members.sort((a, b) => a.id.localeCompare(b.id));
  if (!members.some(member => member.user_id === scope.owner_user_id)) throw forbidden();
  if (destination.kind === 'note' && destination.visibility === 'private') {
    return { public: { visibility: 'private', label: 'Only you', member_count: 1 } as EmailTransferAudience,
      identity: members.filter(member => member.user_id === scope.owner_user_id) };
  }
  if (destination.kind === 'note' && destination.visibility === 'org') {
    return { public: { visibility: 'org', label: 'Organization members', member_count: members.length } as EmailTransferAudience, identity: members };
  }
  const spaceId = destination.space_id!;
  if (destination.kind === 'chat') {
    try { await assertNativeChatForwardDestination(database, { id: scope.owner_user_id, org_id: scope.org_id }, spaceId); }
    catch (error) { if (error instanceof NativeChatForwardError) throw forbidden(); throw error; }
  }
  const [space] = await database.select({ id: spaces.id, name: spaces.name, archived: spaces.is_archived }).from(spaces)
    .where(and(eq(spaces.org_id, scope.org_id), eq(spaces.id, spaceId))).limit(1).for('share');
  if (!space || space.archived) throw forbidden();
  const rows = await database.select({ id: spaceMembers.id, user_id: spaceMembers.user_id, joined_at: spaceMembers.joined_at })
    .from(spaceMembers).where(eq(spaceMembers.space_id, spaceId)).for('share');
  const active = rows.filter(member => members.some(orgMember => orgMember.user_id === member.user_id)).sort((a, b) => a.id.localeCompare(b.id));
  if (!active.some(member => member.user_id === scope.owner_user_id)) throw forbidden();
  return { public: { visibility: 'space', label: `${space.name} members`, member_count: active.length } as EmailTransferAudience,
    identity: { space_id: space.id, name: space.name, members: active.map(member => ({ ...member,
      version: members.find(orgMember => orgMember.user_id === member.user_id)!.version })) } };
}
function reviewDigest(scope: EmailScope, logicalId: string, input: EmailTransferInput, source: EmailTransferSource, identity: unknown) {
  return digest(['deft.email.context-transfer.v1', scope, logicalId, input, source.source_digest, source.fingerprint,
    source.authority_version, source.resource_binding_id, identity]);
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
// Chat's compatibility renderer recognizes [[file:...]] markers. Preserve
// bracket characters visually without allowing quoted mail to create a marker.
const escapeChatLiteral = (value: string) => escapeHtml(value).replace(/[\[\]]/g, char => char === '[' ? '&#91;' : '&#93;');
const sourceUrl = (scope: EmailScope, logicalId: string) => '/email?' + new URLSearchParams({ account: scope.account_id, message: logicalId });
function validateExcerpt(input: EmailTransferInput, source: EmailTransferSource) {
  if (input.mode === 'excerpt' && (!input.excerpt || !source.plain_text.includes(input.excerpt))) throw new EmailContextTransferError('EMAIL_TRANSFER_INVALID');
}

export class EmailContextTransferService {
  constructor(private readonly database: Pick<typeof db, 'transaction'>, private readonly source: EmailTransferSourceReader,
    private readonly afterCreate?: (result: EmailTransferResult, entry: typeof notesType | typeof knowledgeType | typeof chatType) => Promise<void>) {}

  private inputs(actor: EmailActor, rawScope: EmailScope, rawLogicalId: string) {
    const scope = z.strictObject({ org_id: Id, owner_user_id: Id, account_id: Id }).parse(rawScope);
    const logicalId = LogicalId.parse(rawLogicalId);
    if (actor.user_id !== scope.owner_user_id) throw forbidden();
    return { scope, logicalId };
  }
  async review(actor: EmailActor, rawScope: EmailScope, rawLogicalId: string, rawInput: unknown, signal?: AbortSignal) {
    const { scope, logicalId } = this.inputs(actor, rawScope, rawLogicalId), input = EmailTransferReviewSchema.parse(rawInput);
    const source = await this.source.read(actor, scope, logicalId, signal, input.mode); validateExcerpt(input, source);
    return this.database.transaction(async tx => {
      await this.source.guard(actor, scope, logicalId, source, tx, signal);
      const target = await audience(tx, scope, input.destination);
      await this.source.guard(actor, scope, logicalId, source, tx, signal);
      signal?.throwIfAborted();
      return { source_digest: source.source_digest, review_digest: reviewDigest(scope, logicalId, input, source, target.identity),
        audience: target.public, source_url: sourceUrl(scope, logicalId) };
    });
  }
  async transfer(actor: EmailActor, rawScope: EmailScope, rawLogicalId: string, rawInput: unknown, rawRequestId: string, signal?: AbortSignal): Promise<EmailTransferResult> {
    const { scope, logicalId } = this.inputs(actor, rawScope, rawLogicalId), input = EmailTransferCommitSchema.parse(rawInput),
      requestId = z.uuid().parse(rawRequestId);
    const requestDigest = digest([scope, actor.user_id, logicalId, input]);
    const receiptWhere = and(eq(emailContextTransfers.org_id, scope.org_id), eq(emailContextTransfers.owner_user_id, actor.user_id),
      eq(emailContextTransfers.request_id, requestId));
    const replay = async () => this.database.transaction(async tx => {
      await this.source.guard(actor, scope, logicalId, null, tx, signal);
      await audience(tx, scope, input.destination);
      const [receipt] = await tx.select().from(emailContextTransfers).where(receiptWhere).limit(1);
      if (!receipt) return null;
      if (receipt.request_digest !== requestDigest) throw new EmailContextTransferError('EMAIL_TRANSFER_CONFLICT');
      await this.source.guard(actor, scope, logicalId, null, tx, signal);
      return { destination_kind: receipt.destination_kind as EmailTransferResult['destination_kind'], destination_id: receipt.destination_id,
        destination_url: receipt.destination_url, replayed: true };
    });
    const old = await replay(); if (old) return old;
    const source = await this.source.read(actor, scope, logicalId, signal, input.mode); validateExcerpt(input, source);
    const { source_digest: _sourceDigest, review_digest: _reviewDigest, ...reviewInput } = input;
    const outcome = await this.database.transaction(async tx => {
      await this.source.guard(actor, scope, logicalId, source, tx, signal);
      const target = await audience(tx, scope, input.destination);
      if (input.source_digest !== source.source_digest || input.review_digest !== reviewDigest(scope, logicalId, reviewInput, source, target.identity)) throw stale();
      // Unique reservation serializes competing retries without a provider read
      // inside a held database lock. A rolled-back creation leaves no receipt.
      const [reserved] = await tx.insert(emailContextTransfers).values({ org_id: scope.org_id, owner_user_id: actor.user_id,
        account_id: scope.account_id, logical_message_id: logicalId, source_digest: input.source_digest,
        mode: input.mode, review_digest: input.review_digest,
        request_id: requestId, request_digest: requestDigest, destination_kind: input.destination.kind,
        destination_id: '', destination_url: '' }).onConflictDoNothing().returning();
      if (!reserved) {
        const [receipt] = await tx.select().from(emailContextTransfers).where(receiptWhere).limit(1);
        if (!receipt || receipt.request_digest !== requestDigest) throw new EmailContextTransferError('EMAIL_TRANSFER_CONFLICT');
        await this.source.guard(actor, scope, logicalId, null, tx, signal);
        return { result: { destination_kind: receipt.destination_kind as EmailTransferResult['destination_kind'], destination_id: receipt.destination_id,
          destination_url: receipt.destination_url, replayed: true }, entry: null };
      }
      const url = sourceUrl(scope, logicalId), user = { id: actor.user_id, org_id: scope.org_id };
      // Only the reviewed plain excerpt is copied. No headers, HTML, Bcc,
      // conversation, files, URLs from the body, or remote images are inferred.
      const link = `<p><a href="${escapeHtml(url)}">Open source email (requires email access)</a></p>`;
      const noteContent = link + (input.mode === 'excerpt' ? `<blockquote>${escapeHtml(input.excerpt!).replace(/\r?\n/g, '<br>')}</blockquote>` : '');
      const knowledgeContent = `[Open source email (requires email access)](${url})` + (input.mode === 'excerpt'
        ? '\n\n' + input.excerpt!.replace(/[\\`*_{}\[\]()#+.!<>~|:\-]/g, '\\$&').split(/\r?\n/).map(line => `> ${line}`).join('\n') : '');
      const chatContent = `<p>${escapeChatLiteral(input.title)}</p>` + link + (input.mode === 'excerpt'
        ? `<blockquote>${escapeChatLiteral(input.excerpt!).replace(/\r?\n/g, '<br>')}</blockquote>` : '');
      const entry = input.destination.kind === 'chat'
        ? await createNativeChatForward(tx, user, { space_id: input.destination.space_id, content: chatContent,
          metadata: { email_context_transfer: { mode: input.mode } } }).catch(error => {
            if (error instanceof NativeChatForwardError) throw forbidden(); throw error;
          })
        : input.destination.kind === 'note'
        ? await createNativeNote(tx, user, { title: input.title, content: noteContent, visibility: input.destination.visibility,
          visibility_space_id: input.destination.space_id })
        : await createNativeKnowledge(tx, user, { title: input.title, content: knowledgeContent, space_id: input.destination.space_id,
          type: input.destination.type, metadata: null, created_via: 'email_context_transfer' });
      const destinationUrl = input.destination.kind === 'chat'
        ? '/chat?' + new URLSearchParams({ space: input.destination.space_id, message: entry.id })
        : input.destination.kind === 'note' ? `/notes?id=${encodeURIComponent(entry.id)}` : `/knowledge?slug=${encodeURIComponent((entry as typeof knowledgeType).slug)}`;
      await tx.update(emailContextTransfers).set({ destination_id: entry.id, destination_url: destinationUrl })
        .where(receiptWhere);
      // Resample authority/expiry after every possible unique-index wait and
      // destination insert. Existing removal locks remain held through commit;
      // a new audience observed before this final point requires renewed review.
      await this.source.guard(actor, scope, logicalId, source, tx, signal);
      const finalTarget = await audience(tx, scope, input.destination);
      if (input.review_digest !== reviewDigest(scope, logicalId, reviewInput, source, finalTarget.identity)) throw stale();
      await this.source.guard(actor, scope, logicalId, source, tx, signal);
      signal?.throwIfAborted();
      return { result: { destination_kind: input.destination.kind, destination_id: entry.id, destination_url: destinationUrl, replayed: false }, entry };
    });
    if (outcome.entry && this.afterCreate) await this.afterCreate(outcome.result, outcome.entry).catch(() => undefined);
    return outcome.result;
  }
}
// Type-only destination shapes avoid coupling the service to a route module.
declare const notesType: Awaited<ReturnType<typeof createNativeNote>>;
declare const knowledgeType: Awaited<ReturnType<typeof createNativeKnowledge>>;
declare const chatType: Awaited<ReturnType<typeof createNativeChatForward>>;
