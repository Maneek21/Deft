import {z} from 'zod';
const Digest=z.string().regex(/^[a-f0-9]{64}$/u),Id=z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
export const EmailInvitationApplySchema=z.strictObject({request_id:z.uuid(),preview_token:z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u),destination_id:z.literal('deft_personal'),
 recreate_deleted:z.boolean().default(false),action:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('rsvp'),response:z.enum(['accepted','tentative','declined']),send_response:z.boolean()}),
  z.strictObject({kind:z.literal('apply_cancellation')}),
 ])});
export type EmailInvitationApply=z.infer<typeof EmailInvitationApplySchema>;
export const EmailInvitationReceiptSchema=z.strictObject({schema_version:z.literal('deft.email_invitation_receipt.v1'),account_id:Id,request_id:z.uuid(),invitation_id:Digest,revision:z.number().int().positive(),
 calendar:z.strictObject({state:z.enum(['applied','cancelled','declined']),event_id:Id.nullable()}),
 response:z.strictObject({state:z.enum(['not_requested','queued','paused','submitting','accepted','uncertain','cancelled']),outbox_id:Id.nullable(),delivery_status:z.literal('unknown')})});
export type EmailInvitationReceipt=z.infer<typeof EmailInvitationReceiptSchema>;
export const EmailInvitationPreviewTokenSchema=z.strictObject({schema_version:z.literal('deft.email_invitation_preview_token.v1'),org_id:Id,owner_user_id:Id,account_id:Id,web_session_id:Id,
 logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),source_digest:Digest,part_ref:Digest,invitation_id:Digest,content_digest:Digest,authority_version:Id,expires_at:z.number().finite()});
export const EmailInvitationDestination=Object.freeze({id:'deft_personal' as const,label:'Deft personal calendar',visibility:'owner_in_current_organization' as const,external_notifications:false});
