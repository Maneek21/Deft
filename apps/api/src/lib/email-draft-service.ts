import { EmailOperationActorSchema } from './email-agent-actor.js';
import { z } from 'zod';
import { parseTrustedRichtextHtml as parseBasicRichtextHtml } from '@deft/app-kit/experience/core';
import { signatureIdentityKey } from './email-signature-types.js';
import type { EmailOperationActor, EmailAuthority, EmailCapability, EmailScope } from './email-mailbox-service.js';
import { EmailDraftStore, type EmailDraftRow, type EmailDraftSummaryPage } from './email-draft-store.js';

const id = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope = z.strictObject({ org_id: id, owner_user_id: id, account_id: id });
const Actor = EmailOperationActorSchema;
const DraftId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const Header = z.string().max(16 * 1024).refine(value => Buffer.byteLength(value,'utf8')<=16384&&!/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value));
const Attachment = z.strictObject({ file_id: id, filename: z.string().min(1).max(255).refine(value => !/[\/\\\u0000-\u001f\u007f]/u.test(value)),
  media_type: z.string().regex(/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u), size_bytes: z.number().int().min(0).max(25 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const FromIdentity = z.strictObject({ address: z.string().email().max(320) });
const ManagedSignature = z.strictObject({
  schema_version: z.literal('deft.email_signature_region.v1'), identity_key: z.string().regex(/^[a-f0-9]{64}$/u),
  preference_revision: z.number().int().min(1).max(2147483647),
  plain: z.strictObject({ start: z.number().int().min(0).max(256 * 1024), text: z.string().min(1).max(16_384) }),
  rich: z.union([z.null(), z.strictObject({ start: z.number().int().min(0).max(256 * 1024), html: z.string().min(1).max(16_384) })]),
});
export const EmailDraftContentSchema = z.strictObject({
  mode: z.enum(['compose', 'reply', 'reply_all', 'forward']), to: Header, cc: Header, bcc: Header,
  subject: z.string().max(998).refine(value => !/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)),
  body: z.string().max(256 * 1024).refine(value => !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)),
  body_html: z.string().max(256 * 1024), reply_record_id: z.union([z.literal(''), z.string().regex(/^mail_[a-f0-9]{64}$/u)]),
  attachments: z.array(Attachment).max(32), from_identity: FromIdentity.optional(), managed_signature: ManagedSignature.optional(),
}).refine(value => value.attachments.reduce((sum, file) => sum + file.size_bytes, 0) <= 25 * 1024 * 1024)
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 480 * 1024);
export type EmailDraftContent = Readonly<z.infer<typeof EmailDraftContentSchema>>;
/** Select only an address supplied by the current registered sender identity. */
export function selectVerifiedDraftFromAddress(content: Pick<EmailDraftContent, 'from_identity'>,
  primaryAddress: string, verifiedAddresses?: readonly string[]): string | null {
  if (!content.from_identity && verifiedAddresses === undefined) return primaryAddress;
  if (!verifiedAddresses) return null;
  const desired = content.from_identity?.address ?? primaryAddress;
  const key = signatureIdentityKey(desired);
  return verifiedAddresses.find(address => signatureIdentityKey(address) === key) ?? null;
}
/** Ownership metadata never changes the body. Invalid/stale ranges are detached
 * on an explicit human save while preserving the user's exact text. */
export function detachInvalidManagedSignature(content: EmailDraftContent): EmailDraftContent {
  const region = content.managed_signature;
  if (!region) return content;
  let valid = Boolean(content.from_identity && signatureIdentityKey(content.from_identity.address) === region.identity_key
    && content.body.slice(region.plain.start) === region.plain.text);
  if (region.rich === null) valid &&= content.body_html.length === 0;
  else {
    try {
      const full = parseBasicRichtextHtml(content.body_html, { maxCharacters:256*1024,maxBytes:480*1024,inlineAttachments:content.attachments });
      const prefix = parseBasicRichtextHtml(content.body_html.slice(0, region.rich.start), { maxCharacters:256*1024,maxBytes:480*1024,inlineAttachments:content.attachments });
      // Entry signatures stay image-closed even when the surrounding body owns files.
      parseBasicRichtextHtml(region.rich.html,{maxCharacters:16_384,maxBytes:65_536});
      valid &&= content.body_html.slice(region.rich.start) === region.rich.html
        && full.plainText === content.body && region.plain.start === prefix.plainText.length;
    } catch { valid = false; }
  }
  if (valid) return content;
  const { managed_signature: _detached, ...preserved } = content;
  return Object.freeze(preserved);
}
export type EmailDraftResult = EmailDraftRow;

export class EmailDraftError extends Error {
  constructor(readonly code: 'EMAIL_DRAFT_ACCESS_DENIED' | 'EMAIL_DRAFT_INVALID' | 'EMAIL_DRAFT_CONFLICT'
    | 'EMAIL_DRAFT_NOT_FOUND' | 'EMAIL_DRAFT_UNAVAILABLE') { super(code); this.name = 'EmailDraftError'; }
}
const denied = () => new EmailDraftError('EMAIL_DRAFT_ACCESS_DENIED');
const sameScope = (a: EmailScope, b: EmailScope) => a.org_id === b.org_id && a.owner_user_id === b.owner_user_id && a.account_id === b.account_id;

/** Human-owned native drafts are durable across Experience lease expiry. This
 * service never submits content, accepts provenance/status from callers, or
 * treats attachment nominations/reply IDs as send authority. */
export class EmailDraftService {
  constructor(private readonly authority: EmailAuthority, private readonly store: EmailDraftStore, private readonly now = Date.now) {}

  private async current(actor: EmailOperationActor, scope: EmailScope, expected?: EmailCapability, tx?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted(); const before = this.now();
    if (!Number.isFinite(before) || actor.access_expires_at <= before) throw denied();
    let capability: EmailCapability;
    try { capability = structuredClone(await this.authority.current(actor, scope, 'human_draft', tx, signal)); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    signal?.throwIfAborted(); const after = this.now();
    if (!Number.isFinite(after) || !Number.isFinite(capability.expires_at) || capability.expires_at <= after
      || !sameScope(scope, capability.scope) || actor.user_id !== scope.owner_user_id
      || !id.safeParse(capability.resource_binding_id).success || !id.safeParse(capability.authority_version).success
      || expected && (capability.resource_binding_id !== expected.resource_binding_id || capability.authority_version !== expected.authority_version)) throw denied();
    return capability;
  }

  private async authorize(actorRaw: EmailOperationActor, scopeRaw: EmailScope, signal?: AbortSignal) {
    let actor: EmailOperationActor, scope: EmailScope;
    try { actor = Object.freeze(Actor.parse(actorRaw)); scope = Object.freeze(Scope.parse(scopeRaw)); }
    catch { throw denied(); }
    if (actor.user_id !== scope.owner_user_id) throw denied();
    const capability = await this.current(actor, scope, undefined, undefined, signal);
    const guard = async (transaction: unknown) => { await this.current(actor, scope, capability, transaction, signal); };
    return { actor, scope, capability, guard };
  }

  async create(actorRaw: EmailOperationActor, scopeRaw: EmailScope, draftId: string, rawContent: unknown, signal?: AbortSignal): Promise<EmailDraftResult> {
    const { actor, scope, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    let draft_id: string, content: EmailDraftContent;
    try { draft_id = DraftId.parse(draftId); content = detachInvalidManagedSignature(EmailDraftContentSchema.parse(rawContent)); }
    catch { throw new EmailDraftError('EMAIL_DRAFT_INVALID'); }
    try { return await this.store.create(scope, draft_id, content, { kind: 'agent_grant_id' in actor ? 'agent' : 'human', created_by_user_id: actor.user_id, originating_run_id: null }, guard, signal); }
    catch (error) { throw this.map(error, signal); }
  }

  async read(actorRaw: EmailOperationActor, scopeRaw: EmailScope, draftId: string, signal?: AbortSignal): Promise<EmailDraftResult> {
    const { actor, scope, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    let draft_id: string; try { draft_id = DraftId.parse(draftId); } catch { throw new EmailDraftError('EMAIL_DRAFT_INVALID'); }
    try { const found = await this.store.read(scope, draft_id, guard, signal); if (!found) throw new EmailDraftError('EMAIL_DRAFT_NOT_FOUND'); return found; }
    catch (error) { throw this.map(error, signal); }
  }

  async list(actorRaw: EmailOperationActor, scopeRaw: EmailScope, signal?: AbortSignal): Promise<readonly EmailDraftResult[]> {
    const { scope, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    try { return Object.freeze(await this.store.list(scope, guard, signal)); } catch (error) { throw this.map(error, signal); }
  }

  async listSummaries(actorRaw:EmailOperationActor,scopeRaw:EmailScope,cursor:string|null,limit:number,signal?:AbortSignal):Promise<EmailDraftSummaryPage>{
    const {scope,guard}=await this.authorize(actorRaw,scopeRaw,signal);
    try{return await this.store.listSummaries(scope,cursor,limit,guard,signal);}
    catch(error){throw this.map(error,signal);}
  }

  async update(actorRaw: EmailOperationActor, scopeRaw: EmailScope, draftId: string, expectedRevision: number, rawContent: unknown,
    signal?: AbortSignal): Promise<EmailDraftResult> {
    const { actor, scope, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    let draft_id: string, content: EmailDraftContent;
    try {
      draft_id = DraftId.parse(draftId); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error();
      content = detachInvalidManagedSignature(EmailDraftContentSchema.parse(rawContent));
    } catch { throw new EmailDraftError('EMAIL_DRAFT_INVALID'); }
    try { return await this.store.update(scope, draft_id, expectedRevision, content, actor.user_id, guard, signal); }
    catch (error) { throw this.map(error, signal); }
  }

  async archive(actorRaw: EmailOperationActor, scopeRaw: EmailScope, draftId: string, expectedRevision: number, signal?: AbortSignal): Promise<EmailDraftResult> {
    const { scope, guard } = await this.authorize(actorRaw, scopeRaw, signal);
    let draft_id: string; try { draft_id = DraftId.parse(draftId); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error(); }
    catch { throw new EmailDraftError('EMAIL_DRAFT_INVALID'); }
    try { return await this.store.archive(scope, draft_id, expectedRevision, guard, signal); } catch (error) { throw this.map(error, signal); }
  }

  private map(error: unknown, signal?: AbortSignal): EmailDraftError {
    if (signal?.aborted) throw error;
    if (error instanceof EmailDraftError) return error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = String(error.message);
      if ('code' in error && error.code === '23505') return new EmailDraftError('EMAIL_DRAFT_CONFLICT');
      if (message === 'EMAIL_DRAFT_NOT_FOUND') return new EmailDraftError('EMAIL_DRAFT_NOT_FOUND');
      if (message === 'EMAIL_DRAFT_INVALID') return new EmailDraftError('EMAIL_DRAFT_INVALID');
      if (message === 'EMAIL_DRAFT_CONFLICT' || message.includes('unique constraint')) return new EmailDraftError('EMAIL_DRAFT_CONFLICT');
    }
    return new EmailDraftError('EMAIL_DRAFT_UNAVAILABLE');
  }
}
