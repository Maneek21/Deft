import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
const text=z.string().min(1).max(2048).refine(value=>!/[\r\n\0]/u.test(value));
export const EmailImapLocatorSchema=z.strictObject({kind:z.literal('imap_smtp'),mailbox:text,uidvalidity:z.string().regex(/^[1-9]\d{0,29}$/u),uid:z.number().int().min(1).max(4294967295)});
export type EmailImapLocator=z.infer<typeof EmailImapLocatorSchema>;
export const EmailImapAliasProofSchema=z.strictObject({schema_version:z.literal('deft.email_imap_alias.v1'),
 provider_scope:z.strictObject({org_id:text,owner_id:text,installation_id:text}),account_id:text,
 logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),conversation_id:z.string().regex(/^conversation_[a-f0-9]{64}$/u),
 base_locator:EmailImapLocatorSchema,current_locator:EmailImapLocatorSchema,operation_id:z.uuid(),
});
export type EmailImapAliasProof=z.infer<typeof EmailImapAliasProofSchema>;
export type EmailImapMoveNomination=Readonly<{operation_id:string;before_locator:EmailImapLocator;destination_mailbox:string;destination_folders:readonly string[]}>;
/** Host-owned callbacks only. A provider result is not an alias grant. */
export interface EmailImapAliasPort {
 lookup(locator:EmailImapLocator):Promise<EmailImapAliasProof|null>;
 reserve(input:EmailImapMoveNomination):Promise<void>;
 reconcile(operation_id:string):Promise<void>;
}
export const emailImapSourceDigest=(value:unknown)=>createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
export const emailImapLocatorKey=(accountId:string,locator:EmailImapLocator)=>emailImapSourceDigest([accountId,EmailImapLocatorSchema.parse(locator)]);
