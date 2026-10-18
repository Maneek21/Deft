import { EmailOperationActorSchema } from './email-agent-actor.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EmailOperationActor, EmailAuthority, EmailCapability, EmailScope } from './email-mailbox-service.js';
import { EmailDraftStore, type EmailDraftRow } from './email-draft-store.js';
import { EmailSendStore, type EmailSendOperation, type EmailSendState } from './email-send-store.js';

const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\r\n\0]/u.test(value));
const Scope = z.strictObject({ org_id: Identifier, owner_user_id: Identifier, account_id: Identifier });
const Envelope = z.strictObject({ from: z.string().email().max(320), to: z.array(z.string().email().max(320)).min(1).max(200)
  .refine(rows => new Set(rows.map(row => row.toLowerCase())).size === rows.length) });
const Actor = EmailOperationActorSchema;
const DraftId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const SendIdentity = z.strictObject({ operation_id: DraftId, snapshot_id: z.string().min(1).max(256), snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  mime_digest: z.string().regex(/^[a-f0-9]{64}$/u), scope: z.strictObject({ org_id: Identifier, owner_id: Identifier, installation_id: Identifier }),
  account_id: Identifier, authority_epoch: z.number().int().positive(), draft_id: DraftId, draft_revision: z.number().int().positive() });
const PreparedTransport = z.strictObject({ operation_id: DraftId, snapshot_id: z.string().min(1).max(256), snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  mime_digest: z.string().regex(/^[a-f0-9]{64}$/u), scope: z.strictObject({ org_id: Identifier, owner_id: Identifier, installation_id: Identifier }),
  account_id: Identifier, authority_epoch: z.number().int().positive(), draft_id: DraftId, draft_revision: z.number().int().positive(),
  from_address: z.string().email().max(320), transport_kind: z.enum(['gmail_raw','graph_raw','smtp_raw']), thread_id: Identifier.optional(), envelope: Envelope.optional() });
const ProviderResult = z.strictObject({ schema_version: z.literal('deft.email_send_result.v1'), account_id: Identifier,
  provider: z.enum(['gmail','microsoft','imap_smtp']), operation_id: DraftId, provider_message_id: z.string().max(1024).nullable(),
  transport_outcome: z.literal('provider_accepted'), sent_copy_outcome: z.literal('pending'), delivery_status: z.literal('unknown') });
const denied = () => new EmailNativeSendError('EMAIL_SEND_ACCESS_DENIED');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const sameScope = (a: EmailScope, b: EmailScope) => a.org_id === b.org_id && a.owner_user_id === b.owner_user_id && a.account_id === b.account_id;

export type EmailSendSnapshotIdentity = Readonly<z.infer<typeof SendIdentity>>;
/** Adapter around createOutgoingSnapshotService.prepare/bind. Its reserve callback
 * must invoke the durable host store before any provider call and must not accept
 * browser-provided draft content, attachment bytes, sender or reply headers. */
export interface EmailSendSnapshotBuilder {
  prepareAndBind(input: Readonly<{ actor: EmailOperationActor; scope: EmailScope; capability: EmailCapability; recheck: () => Promise<void>;
    draft: EmailDraftRow; operation_id: string; signal?: AbortSignal;
    /** Server-derived invitation response only; never accepted in draft/HTTP input. */
    calendar_reply?: Readonly<{ics_text:string;method:'REPLY'}>;
    reserve(identity: EmailSendSnapshotIdentity): Promise<'reserved'|'replay'|'unknown'> }>): Promise<Readonly<{
      state: 'reserved'|'replay'; transport?: unknown; mime_bytes?: Uint8Array; mime_digest?: string }>>;
}
export interface EmailNativeSendProvider {
  send(input: Readonly<{ operation_id: string; mime_bytes: Uint8Array; mime_digest: string; from_address: string;
    transport_kind: 'gmail_raw'|'graph_raw'|'smtp_raw'; thread_id?: string; envelope?: Readonly<{from:string;to:readonly string[]}> }>, context: Readonly<{
      scope: EmailScope; capability: EmailCapability; recheck: () => Promise<void>; signal?: AbortSignal;
      send_before_reserve: (input: Readonly<{ operation_id: string; account_id: string; authority_epoch: number; mime_digest: string }>) => Promise<boolean>;
    }>): Promise<unknown>;
}
export class EmailNativeSendError extends Error {
  constructor(readonly code: 'EMAIL_SEND_ACCESS_DENIED'|'EMAIL_SEND_INVALID'|'EMAIL_SEND_CONFLICT'|'EMAIL_SEND_NOT_FOUND'
    |'EMAIL_SEND_UNAVAILABLE'|'EMAIL_SEND_UNKNOWN'|'EMAIL_SEND_ATTACHMENT_UNAVAILABLE'|'EMAIL_SEND_REPLY_UNAVAILABLE'
    |'EMAIL_SEND_LIMIT_EXCEEDED'|'EMAIL_SEND_SENDER_UNAVAILABLE') {
    super(code); this.name = 'EmailNativeSendError';
  }
}
export type EmailNativeSendPublicResult = Readonly<{ operation_id: string; draft_id: string; draft_revision: number; state: EmailSendState }>;

/** One human send attempt for one immutable draft revision. A reserved operation
 * is durable before provider I/O; every post-reservation failure is non-replayable. */
export class EmailNativeSendService {
  constructor(private readonly authority: EmailAuthority, private readonly drafts: EmailDraftStore,
    private readonly store: EmailSendStore, private readonly snapshots: EmailSendSnapshotBuilder,
    private readonly provider: EmailNativeSendProvider, private readonly now = Date.now) {
    if (!authority || !drafts || !store || typeof snapshots?.prepareAndBind !== 'function' || typeof provider?.send !== 'function')
      throw new EmailNativeSendError('EMAIL_SEND_UNAVAILABLE');
  }

  private async authorize(actorRaw: EmailOperationActor, scopeRaw: EmailScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let actor: EmailOperationActor, scope: EmailScope;
    try { actor = Object.freeze(Actor.parse(actorRaw)); scope = Object.freeze(Scope.parse(scopeRaw)); } catch { throw denied(); }
    if (actor.user_id !== scope.owner_user_id || actor.access_expires_at <= this.now()) throw denied();
    let capability: EmailCapability;
    try { capability = structuredClone(await this.authority.current(actor, scope, 'human_send', undefined, signal)); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    const guard = async (transaction: unknown) => { await this.current(actor, scope, capability, transaction, signal); };
    await this.current(actor, scope, capability, undefined, signal);
    return { actor, scope, capability, guard };
  }

  private async current(actor: EmailOperationActor, scope: EmailScope, expected: EmailCapability, transaction?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let value: EmailCapability;
    try { value = await this.authority.current(actor, scope, 'human_send', transaction, signal); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    if (!Number.isFinite(this.now()) || actor.access_expires_at <= this.now() || !Number.isFinite(value.expires_at)
      || value.expires_at <= this.now() || !sameScope(scope, value.scope)
      || !Identifier.safeParse(value.resource_binding_id).success || !Identifier.safeParse(value.authority_version).success
      || value.resource_binding_id !== expected.resource_binding_id || value.authority_version !== expected.authority_version) throw denied();
    signal?.throwIfAborted(); return value;
  }

  async send(actorRaw: EmailOperationActor, scopeRaw: EmailScope, draftIdRaw: string, expectedRevision: number,
    signal?: AbortSignal): Promise<EmailNativeSendPublicResult> {
    const { actor, scope, capability, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    let draftId: string;
    try { draftId = DraftId.parse(draftIdRaw); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error(); }
    catch { throw new EmailNativeSendError('EMAIL_SEND_INVALID'); }
    let draft: EmailDraftRow | null = null;
    try { draft = await this.drafts.read(scope, draftId, guard, signal); }
    catch (error) { if (signal?.aborted) throw error; throw new EmailNativeSendError('EMAIL_SEND_UNAVAILABLE'); }
    if (!draft) throw new EmailNativeSendError('EMAIL_SEND_NOT_FOUND');
    if (draft.status !== 'draft' || draft.revision !== expectedRevision) {
      try {
        const previous = await this.store.status(scope, draftId, expectedRevision, guard, signal);
        if (previous) return Object.freeze({ operation_id: previous.operation.operation_id, draft_id: draftId,
          draft_revision: expectedRevision, state: previous.operation.state });
      } catch (error) { if (signal?.aborted) throw error; throw new EmailNativeSendError('EMAIL_SEND_UNAVAILABLE'); }
      throw new EmailNativeSendError('EMAIL_SEND_CONFLICT');
    }
    const operationId = randomUUID();
    const reservation: { value: { operation: EmailSendOperation; replay: boolean } | null } = { value: null };
    let reservedDigest: string | undefined;
    let mime: Buffer | undefined;
    let prepared: Awaited<ReturnType<EmailSendSnapshotBuilder['prepareAndBind']>> | undefined;
    try {
      prepared = await this.snapshots.prepareAndBind({ actor, scope, capability, recheck: async () => { await this.current(actor, scope, capability, undefined, signal); },
        draft, operation_id: operationId, signal,
        reserve: async identityRaw => {
          const identity = SendIdentity.parse(identityRaw);
          if (identity.operation_id !== operationId || identity.draft_id !== draftId || identity.draft_revision !== expectedRevision
            || identity.account_id !== scope.account_id || identity.scope.org_id !== scope.org_id || identity.scope.owner_id !== scope.owner_user_id
            || !Number.isSafeInteger(identity.authority_epoch) || identity.authority_epoch < 1) throw new Error('EMAIL_SEND_ACCESS_DENIED');
          const result = await this.store.reserve(scope, draftId, expectedRevision, actor.user_id, operationId, identity.mime_digest, guard, signal);
          reservedDigest = identity.mime_digest;
          reservation.value = { operation: result.operation, replay: result.replay };
          return result.replay ? 'replay' : 'reserved';
        } });
      if (prepared.state === 'replay') {
        if (!reservation.value) throw new EmailNativeSendError('EMAIL_SEND_CONFLICT');
        return Object.freeze({ operation_id: reservation.value.operation.operation_id, draft_id: draftId,
          draft_revision: expectedRevision, state: reservation.value.operation.state });
      }
      if (!reservation.value || reservation.value.replay || !prepared.transport || !(prepared.mime_bytes instanceof Uint8Array)
        || typeof prepared.mime_digest !== 'string' || prepared.mime_digest !== reservedDigest) throw new Error('EMAIL_SEND_UNAVAILABLE');
      mime = Buffer.from(prepared.mime_bytes);
      if (mime.byteLength < 1 || mime.byteLength > 36 * 1024 * 1024 || digest(mime) !== prepared.mime_digest) throw new Error('EMAIL_SEND_UNAVAILABLE');
      const transport = PreparedTransport.parse(prepared.transport);
      if (transport.operation_id !== operationId || transport.account_id !== scope.account_id || transport.draft_id !== draftId
        || transport.draft_revision !== expectedRevision || transport.mime_digest !== prepared.mime_digest
        || transport.scope.org_id !== scope.org_id || transport.scope.owner_id !== scope.owner_user_id
        || !Number.isSafeInteger(transport.authority_epoch) || transport.authority_epoch < 1) throw new Error('EMAIL_SEND_UNAVAILABLE');
      if (transport.transport_kind === 'smtp_raw'
        ? !transport.envelope || transport.envelope.from !== transport.from_address || transport.thread_id !== undefined
        : transport.envelope !== undefined) throw new Error('EMAIL_SEND_UNAVAILABLE');
      await this.current(actor, scope, capability, undefined, signal);
      const raw = await this.provider.send({ operation_id: operationId, mime_bytes: mime, mime_digest: prepared.mime_digest,
        from_address: transport.from_address, transport_kind: transport.transport_kind,
        ...(transport.thread_id ? { thread_id: transport.thread_id } : {}),
        ...(transport.transport_kind === 'smtp_raw' && transport.envelope ? { envelope: transport.envelope } : {}) }, { scope, capability,
          recheck: async () => { await this.current(actor, scope, capability, undefined, signal); }, signal,
          send_before_reserve: async input => input.operation_id === operationId && input.account_id === scope.account_id
            && input.authority_epoch === transport.authority_epoch && input.mime_digest === prepared!.mime_digest
            && await this.store.verifyReservation(scope, operationId, prepared!.mime_digest, guard, signal) });
      const result = ProviderResult.parse(raw);
      const expectedProvider = ({ gmail_raw:'gmail', graph_raw:'microsoft', smtp_raw:'imap_smtp' } as const)[transport.transport_kind];
      if (result.operation_id !== operationId || result.account_id !== scope.account_id || result.provider !== expectedProvider) throw new Error('EMAIL_SEND_UNKNOWN');
      const done = await this.store.finish(scope, operationId, 'accepted', result.provider_message_id, guard, signal);
      return Object.freeze({ operation_id: done.operation_id, draft_id: draftId, draft_revision: expectedRevision, state: done.state });
    } catch (error) {
      if (signal?.aborted) {
        if (reservation.value && !reservation.value.replay) await this.store.finish(scope, operationId, 'unknown', null, guard).catch(() => {});
        throw error;
      }
      if (reservation.value && !reservation.value.replay) await this.store.finish(scope, operationId, 'unknown', null, guard).catch(() => {});
      if (reservation.value && !reservation.value.replay) throw new EmailNativeSendError('EMAIL_SEND_UNKNOWN');
      if (error instanceof EmailNativeSendError) throw error;
      if (error && typeof error === 'object' && 'message' in error) {
        const safeCode = String(error.message);
        if (['EMAIL_SEND_ATTACHMENT_UNAVAILABLE','EMAIL_SEND_REPLY_UNAVAILABLE','EMAIL_SEND_LIMIT_EXCEEDED','EMAIL_SEND_SENDER_UNAVAILABLE'].includes(safeCode))
          throw new EmailNativeSendError(safeCode as 'EMAIL_SEND_ATTACHMENT_UNAVAILABLE'|'EMAIL_SEND_REPLY_UNAVAILABLE'|'EMAIL_SEND_LIMIT_EXCEEDED'|'EMAIL_SEND_SENDER_UNAVAILABLE');
      }
      if (error && typeof error === 'object' && 'message' in error && ['EMAIL_DRAFT_NOT_FOUND','EMAIL_DRAFT_CONFLICT'].includes(String(error.message)))
        throw new EmailNativeSendError(String(error.message) === 'EMAIL_DRAFT_NOT_FOUND' ? 'EMAIL_SEND_NOT_FOUND' : 'EMAIL_SEND_CONFLICT');
      throw new EmailNativeSendError(reservation.value ? 'EMAIL_SEND_UNKNOWN' : 'EMAIL_SEND_UNAVAILABLE');
    } finally {
      mime?.fill(0);
      if (prepared?.mime_bytes instanceof Uint8Array) prepared.mime_bytes.fill(0);
    }
  }

  async status(actorRaw: EmailOperationActor, scopeRaw: EmailScope, draftIdRaw: string, draftRevision: number,
    signal?: AbortSignal): Promise<EmailNativeSendPublicResult | null> {
    const { scope, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    let draftId: string;
    try { draftId = DraftId.parse(draftIdRaw); if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) throw new Error(); }
    catch { throw new EmailNativeSendError('EMAIL_SEND_INVALID'); }
    try {
      const result = await this.store.status(scope, draftId, draftRevision, guard, signal);
      return result ? Object.freeze({ operation_id: result.operation.operation_id, draft_id: draftId,
        draft_revision: draftRevision, state: result.operation.state }) : null;
    } catch (error) { if (signal?.aborted) throw error; throw new EmailNativeSendError('EMAIL_SEND_UNAVAILABLE'); }
  }
}
