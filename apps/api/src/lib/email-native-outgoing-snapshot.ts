import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EmailAttachmentMetadataSchema, type EmailAttachmentMetadata } from './email-attachment-store.js';
import type { EmailAttachmentService } from './email-attachment-service.js';
import type {NativeEmailSendIdentity, NativeEmailSnapshotFactory} from './email-native-adapter-contract.js';
import {NativeEmailSendIdentitySchema} from './email-native-adapter-contract.js';
import { EmailDraftContentSchema, selectVerifiedDraftFromAddress } from './email-draft-service.js';
import type { EmailNativeSendError, EmailSendSnapshotBuilder } from './email-native-send-service.js';
import { EmailNativeSendError as SendError } from './email-native-send-service.js';
import { canonicalCapabilityJson } from '@deft/shared';
import { parseNativeMailboxList } from '../../../../packages/app-kit/src/mailbox-list.js';
import {parseNativeSafeComposeHtml} from '@deft/app-kit/experience';
import {assertNativeReplyModeAvailable} from './email-native-reply-policy.js';
import type { EmailOperationActor, EmailScope, EmailCapability } from './email-mailbox-service.js';
import type { EmailDraftRow } from './email-draft-store.js';
import {parseEmailCalendarInvitations} from './email-calendar-invitation.js';

const GMAIL_MIME_LIMIT = 35 * 1024 * 1024;
const GRAPH_MIME_LIMIT = 3 * 1024 * 1024;
const GRAPH_PREPARED_MIME_LIMIT = 35 * 1024 * 1024;
const SMTP_MIME_LIMIT = 35 * 1024 * 1024;
const TOTAL_FILE_LIMIT = 25 * 1024 * 1024;
function fail(code: ConstructorParameters<typeof SendError>[0]): never { throw new SendError(code); }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mailboxes = (value: string, allowEmpty = false) => parseNativeMailboxList(value, { allowEmpty })
  .map(item => ({ address: item.address, display_name: item.displayName }));
const sameIdentity = (a: NativeEmailSendIdentity, b: NativeEmailSendIdentity) => canonicalCapabilityJson([
  a.account_id, a.provider, a.resource_binding_id, a.authority_epoch, a.connection_revision, a.principal_digest,
  a.action_binding_id, a.primary_address, a.verified_sender_identities, a.installation_id, a.connection_target,a.implementation_digest??null,
]) === canonicalCapabilityJson([
  b.account_id, b.provider, b.resource_binding_id, b.authority_epoch, b.connection_revision, b.principal_digest,
  b.action_binding_id, b.primary_address, b.verified_sender_identities, b.installation_id, b.connection_target,b.implementation_digest??null,
]);

export type EmailNativeReplyContext = Readonly<{ account_id: string; provider: 'gmail' | 'microsoft' | 'imap_smtp'; logical_message_id: string;
  message_id: string; references: readonly string[]; from: string; to: string; cc: string; reply_to: string; thread_id?: string;
  reply_seed_unavailable?:readonly ('reply_from'|'reply_to'|'reply_to_list'|'reply_cc')[] }>;
export interface EmailNativeReplyResolver {
  (actor: EmailOperationActor, scope: EmailScope, logicalId: string, recheck: () => Promise<void>, signal?: AbortSignal): Promise<EmailNativeReplyContext>;
}
export interface EmailNativeSendIdentityReader {
  getSendIdentity(scope: EmailScope, capability: EmailCapability, recheck: () => Promise<void>, signal?: AbortSignal): Promise<NativeEmailSendIdentity>;
}
export interface EmailNativeAttachmentReader {
  readForSend(actor: EmailOperationActor, scope: EmailScope, draftId: string, fileId: string, expected: EmailAttachmentMetadata, signal?: AbortSignal): Promise<EmailAttachmentMetadata & { bytes: Uint8Array }>;
}

function safeError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code)
    : error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (code.includes('LIMIT') || code.includes('TOO_LARGE')) fail('EMAIL_SEND_LIMIT_EXCEEDED');
  if (code.includes('UNCERTAIN') || code.includes('UNKNOWN')) fail('EMAIL_SEND_UNKNOWN');
  if (code.includes('REPLY')) fail('EMAIL_SEND_REPLY_UNAVAILABLE');
  if (code.includes('FROM')) fail('EMAIL_SEND_SENDER_UNAVAILABLE');
  throw new SendError('EMAIL_SEND_INVALID');
}

/** Trusted composition adapter: all content, attachment bytes, sender identity,
 * and reply headers are re-resolved server-side before the durable reservation. */
export function createEmailNativeOutgoingSnapshotBuilder(input: Readonly<{
  accounts: EmailNativeSendIdentityReader;
  attachments: Pick<EmailAttachmentService, 'readForSend'> | EmailNativeAttachmentReader;
  replies: EmailNativeReplyResolver;
  createOutgoingSnapshotService: NativeEmailSnapshotFactory;
  /** Host-selected Outbox capability. HTTP input cannot enable this path. */
  graphPreparation?: boolean;
  now?: () => Date;
}>): EmailSendSnapshotBuilder {
  if (!input?.accounts || !input.attachments || typeof input.replies !== 'function' || typeof input.createOutgoingSnapshotService !== 'function')
    throw new SendError('EMAIL_SEND_UNAVAILABLE');
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async prepareAndBind(args: Parameters<EmailSendSnapshotBuilder['prepareAndBind']>[0]) {
      args.signal?.throwIfAborted();
      const failAttachment = () => fail('EMAIL_SEND_ATTACHMENT_UNAVAILABLE');
      let content!: ReturnType<typeof EmailDraftContentSchema.parse>;
      try { content = EmailDraftContentSchema.parse(args.draft.content); }
      catch { fail('EMAIL_SEND_INVALID'); }
      if(content.body_html){try{if(parseNativeSafeComposeHtml(content.body_html,{inlineAttachments:content.attachments}).plainText!==content.body)fail('EMAIL_SEND_INVALID');}catch{fail('EMAIL_SEND_INVALID');}}
      if (args.draft.status !== 'draft' || args.draft.content_revision !== args.draft.revision
        || args.draft.revision < 1) fail('EMAIL_SEND_CONFLICT');
      let identity!: NativeEmailSendIdentity;
      try { identity = NativeEmailSendIdentitySchema.parse(await input.accounts.getSendIdentity(args.scope, args.capability, args.recheck, args.signal)); }
      catch { if (args.signal?.aborted) throw args.signal.reason; fail('EMAIL_SEND_SENDER_UNAVAILABLE'); }
      if (identity.account_id !== args.scope.account_id || identity.org_id !== args.scope.org_id || identity.owner_user_id !== args.scope.owner_user_id
        || !identity.capabilities.includes('send') || !identity.verified_sender_identities.includes(identity.primary_address)) fail('EMAIL_SEND_SENDER_UNAVAILABLE');
      const fromAddress = selectVerifiedDraftFromAddress(content, identity.primary_address, identity.verified_sender_identities);
      if (!fromAddress) fail('EMAIL_SEND_SENDER_UNAVAILABLE');
      let recipients!: {to:ReturnType<typeof mailboxes>;cc:ReturnType<typeof mailboxes>;bcc:ReturnType<typeof mailboxes>};
      try{recipients={to:mailboxes(content.to,true),cc:mailboxes(content.cc,true),bcc:mailboxes(content.bcc,true)};}
      catch{fail('EMAIL_SEND_INVALID');}
      if(recipients.to.length+recipients.cc.length+recipients.bcc.length>200)fail('EMAIL_SEND_LIMIT_EXCEEDED');
      let reply: EmailNativeReplyContext | null = null;
      const readCurrentReply=async()=>{
        if(!content.reply_record_id)return null;
        const current=await input.replies(args.actor,args.scope,content.reply_record_id,args.recheck,args.signal);
        if(current.account_id!==args.scope.account_id||current.logical_message_id!==content.reply_record_id||current.provider!==identity.provider
          ||identity.provider==='gmail'&&!current.thread_id||identity.provider!=='gmail'&&current.thread_id)fail('EMAIL_SEND_REPLY_UNAVAILABLE');
        assertNativeReplyModeAvailable(current,content.mode,identity.verified_sender_identities);return current;
      };
      try{reply=await readCurrentReply();if(['reply','reply_all'].includes(content.mode)&&!reply)fail('EMAIL_SEND_REPLY_UNAVAILABLE');}
      catch{if(args.signal?.aborted)throw args.signal.reason;fail('EMAIL_SEND_REPLY_UNAVAILABLE');}
      let calendarReply:Readonly<{ics_text:string;method:'REPLY'}>|undefined;
      if(args.calendar_reply){
        const raw=args.calendar_reply;
        if(Object.keys(raw).sort().join(',')!=='ics_text,method'||raw.method!=='REPLY'||typeof raw.ics_text!=='string'||Buffer.byteLength(raw.ics_text)>262144)fail('EMAIL_SEND_INVALID');
        const parsed=parseEmailCalendarInvitations({ics_text:raw.ics_text,source_digest:digest(Buffer.from(raw.ics_text)),media_type_method:'REPLY'});
        const to=mailboxes(content.to);
        if(parsed.status!=='parsed'||parsed.items.length!==1)fail('EMAIL_SEND_INVALID');
        const item=parsed.items[0]!;
        if(item.method!=='REPLY'||item.limitations.length||item.attendees.length!==1||item.attendees[0]!.address.toLowerCase()!==fromAddress.toLowerCase()
          ||to.length!==1||to[0]!.address.toLowerCase()!==item.organizer.address.toLowerCase()||content.cc||content.bcc||content.attachments.length||content.mode!=='compose'||content.reply_record_id)fail('EMAIL_SEND_INVALID');
        calendarReply=Object.freeze({ics_text:raw.ics_text,method:'REPLY'});
      }

      const attachments: Array<EmailAttachmentMetadata & { bytes: Uint8Array }> = [];
      try {
        if (content.attachments.length > 32 || content.attachments.reduce((sum, item) => sum + item.size_bytes, 0) > TOTAL_FILE_LIMIT) fail('EMAIL_SEND_LIMIT_EXCEEDED');
        for (const expectedRaw of content.attachments) {
          args.signal?.throwIfAborted();
          const expected = EmailAttachmentMetadataSchema.parse(expectedRaw);
          const found = await input.attachments.readForSend(args.actor, args.scope, args.draft.draft_id, expected.file_id, expected, args.signal);
          const foundMeta = EmailAttachmentMetadataSchema.parse({ file_id: found.file_id, filename: found.filename, media_type: found.media_type,
            size_bytes: found.size_bytes, sha256: found.sha256 });
          if (!(found.bytes instanceof Uint8Array) || canonicalCapabilityJson(foundMeta) !== canonicalCapabilityJson(expected)
            || found.bytes.byteLength !== expected.size_bytes || digest(found.bytes) !== expected.sha256) {
            if (found.bytes instanceof Uint8Array) found.bytes.fill(0);
            failAttachment();
          }
          attachments.push({ ...foundMeta, bytes: found.bytes });
        }
      } catch (error) {
        for (const file of attachments) file.bytes.fill(0);
        if (args.signal?.aborted) throw args.signal.reason;
        if (error instanceof SendError) throw error;
        failAttachment();
      }

      const graphLimit=input.graphPreparation===true&&identity.capabilities.includes('modify')?GRAPH_PREPARED_MIME_LIMIT:GRAPH_MIME_LIMIT;
      const nativeMimeLimit = identity.provider === 'gmail' ? GMAIL_MIME_LIMIT : identity.provider === 'microsoft' ? graphLimit : SMTP_MIME_LIMIT;
      let draft!: Record<string, any>;
      let policy!: { max_recipients: number; max_body_bytes: number; max_files: number; max_file_bytes: number; max_total_file_bytes: number;
        max_mime_bytes: number; allowed_media_types: string[] };
      try {
        const mediaTypes = [...new Set(attachments.map(file => file.media_type))];
        if (!mediaTypes.length) mediaTypes.push('application/octet-stream');
        policy = { max_recipients: 200, max_body_bytes: 1024 * 1024, max_files: 32, max_file_bytes: TOTAL_FILE_LIMIT,
          max_total_file_bytes: TOTAL_FILE_LIMIT, max_mime_bytes: nativeMimeLimit, allowed_media_types: mediaTypes };
      const replyParent = reply ? { account_id: reply.account_id, org_id: args.scope.org_id, owner_id: args.scope.owner_user_id,
        logical_message_id: reply.logical_message_id, message_id: reply.message_id, references: [...reply.references],
        ...(identity.provider === 'gmail' && reply.thread_id ? { thread_id: reply.thread_id } : {}) } : null;
      draft = { account_id: args.scope.account_id, draft_id: args.draft.draft_id, revision: args.draft.content_revision, mode: content.mode,
        from: { address: fromAddress, display_name: '' }, ...recipients, subject: content.subject, body_format: content.body_html ? 'safe_html' : 'plain',
        body_bytes: Buffer.from(content.body, 'utf8'), ...(content.body_html ? { body_html_bytes: Buffer.from(content.body_html, 'utf8') } : {}),
        ...(replyParent ? { reply_parent: replyParent } : { reply_parent: null }), files: attachments.map(file => ({
          file_id: file.file_id, account_id: args.scope.account_id, org_id: args.scope.org_id, owner_id: args.scope.owner_user_id,
          parent: { kind: 'draft', id: args.draft.draft_id }, availability: 'ready', filename: file.filename, media_type: file.media_type,
          byte_count: file.size_bytes, digest: file.sha256, expires_at: '9999-12-31T23:59:59.999Z', bytes: file.bytes,
        })) };
      } catch {
        for (const file of attachments) file.bytes.fill(0);
        fail('EMAIL_SEND_INVALID');
      }
      const snapshotKey = randomBytes(32);
      let retained: { id: string; seal: string; payload: unknown; payloadDigest: string; mimeDigest: string; identity: NativeEmailSendIdentity } | undefined;
      let outgoingSnapshot: any;
      try {
        const service = input.createOutgoingSnapshotService({
          resolve: async (reference: { account_id: string; draft_id: string; expected_revision: number }) => {
            if (reference.account_id !== args.scope.account_id || reference.draft_id !== args.draft.draft_id || reference.expected_revision !== args.draft.content_revision)
              fail('EMAIL_SEND_CONFLICT');
            const capturedAt = now().toISOString();
            return { scope: { org_id: args.scope.org_id, owner_id: args.scope.owner_user_id, installation_id: identity.installation_id },
              account_id: identity.account_id, authority_epoch: identity.authority_epoch, provider: identity.provider,
              verified_from: [{ address: fromAddress, display_name: '' }], message_id: `<${randomUUID()}@deft.invalid>`, captured_at: capturedAt,
              draft, limits: policy,...(calendarReply?{calendar_reply:calendarReply}:{}) };
          },
          seal: async (snapshot: { payload: unknown; payload_digest: string; mime_bytes: Uint8Array }) => {
            try {
              const id = randomUUID(), seal = createHmac('sha256', snapshotKey).update(canonicalCapabilityJson([id, snapshot.payload_digest])).digest('hex');
              retained = { id, seal, payload: structuredClone(snapshot.payload), payloadDigest: snapshot.payload_digest,
                mimeDigest: digest(snapshot.mime_bytes), identity };
              return { snapshot_id: id, sealed_contract: seal };
            } finally {
              snapshot.mime_bytes.fill(0);
              (snapshot as any).body_bytes?.fill?.(0);
              (snapshot as any).body_html_bytes?.fill?.(0);
              (snapshot as any).file_bytes?.forEach?.((bytes: Uint8Array) => bytes.fill(0));
            }
          },
          verify: async (candidate: { snapshot_id: string; sealed_contract: string; payload: unknown; payload_digest: string; mime_digest: string }) => {
            if (!retained || candidate.snapshot_id !== retained.id || candidate.sealed_contract !== retained.seal
              || candidate.payload_digest !== retained.payloadDigest || candidate.mime_digest !== retained.mimeDigest
              || canonicalCapabilityJson(candidate.payload) !== canonicalCapabilityJson(retained.payload)) return false;
            await args.recheck();
            const fresh = NativeEmailSendIdentitySchema.parse(await input.accounts.getSendIdentity(args.scope, args.capability, args.recheck, args.signal));
            if(reply&&canonicalCapabilityJson(await readCurrentReply())!==canonicalCapabilityJson(reply))fail('EMAIL_SEND_REPLY_UNAVAILABLE');
            return sameIdentity(fresh, retained.identity);
          },
          reserve: args.reserve,
        });
        outgoingSnapshot = await service.prepare({ account_id: args.scope.account_id, draft_id: args.draft.draft_id, expected_revision: args.draft.content_revision });
        const bound = await service.bind(outgoingSnapshot, { operation_id: args.operation_id, expected_digest: outgoingSnapshot.payload_digest });
        if (bound.replay) return { state: 'replay' as const, transport: reduceTransport(bound) };
        const mimeBytes = bound.mime_bytes as Uint8Array;
        if (!(mimeBytes instanceof Uint8Array) || typeof bound.mime_digest !== 'string' || mimeBytes.byteLength > nativeMimeLimit) {
          mimeBytes?.fill(0); fail('EMAIL_SEND_LIMIT_EXCEEDED');
        }
        const mimeDigest = bound.mime_digest as string;
        const transport = reduceTransport(bound);
        return { state: 'reserved' as const, transport, mime_bytes: mimeBytes, mime_digest: mimeDigest };
      } catch (error) {
        if (args.signal?.aborted) throw args.signal.reason;
        if (error instanceof SendError) throw error;
        safeError(error);
      } finally {
        outgoingSnapshot?.dispose?.();
        snapshotKey.fill(0);
        for (const file of attachments) file.bytes.fill(0);
        (draft.body_bytes as Buffer).fill(0);
        if (draft.body_html_bytes instanceof Buffer) draft.body_html_bytes.fill(0);
      }
    },
  });
}

function reduceTransport(bound: any) {
  const { envelope, mime_bytes: _mime, ...transport } = bound;
  if (bound.transport_kind === 'smtp_raw') transport.envelope = envelope;
  return transport;
}
