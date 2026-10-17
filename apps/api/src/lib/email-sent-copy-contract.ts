import {z} from 'zod';
const id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const sha=z.string().regex(/^[a-f0-9]{64}$/u),uid=z.number().int().min(1).max(4294967295);
export const EMAIL_SENT_COPY_JOB='native-email-sent-copy';
export const EmailSentCopyScopeSchema=z.strictObject({org_id:id,owner_user_id:id,account_id:id});
export const EmailSentCopyJobSchema=EmailSentCopyScopeSchema.extend({outbox_id:z.string().uuid(),operation_id:z.string().uuid(),mime_digest:sha,authority_revision:z.number().int().positive()});
export type EmailSentCopyLease=Readonly<{job_id:string;lock_token:string;job_name:'native-email-sent-copy';outbox_id:string;operation_id:string}>;
export const EmailSentCopyPlanSchema=z.strictObject({schema_version:z.literal('deft.email_sent_copy_plan.v1'),scope:EmailSentCopyScopeSchema,operation_id:z.string().uuid(),
 binding_digest:sha,principal_digest:sha,mime_digest:sha,byte_length:z.number().int().min(1).max(35*1024*1024),mode:z.enum(['server_managed','append']),
 message_id:z.string().min(3).max(256).regex(/^<[^<>\s\u0000-\u001f\u007f]+>$/u),
 mailbox:z.string().min(1).max(2048).refine(v=>!/[\u0000-\u001f\u007f]/u.test(v)).nullable(),uidvalidity:z.string().regex(/^[1-9]\d{0,29}$/u).nullable(),
 uidnext:z.number().int().min(1).max(4294967296).nullable(),digest:sha}).refine(v=>v.mode==='append'?[v.mailbox,v.uidvalidity,v.uidnext].every(x=>x!==null):[v.mailbox,v.uidvalidity,v.uidnext].every(x=>x===null));
export type EmailSentCopyPlan=z.infer<typeof EmailSentCopyPlanSchema>;
export const EmailSentCopyValueSchema=z.strictObject({plan:EmailSentCopyPlanSchema,state:z.enum(['prepared','started','copied','unknown','failed','server_managed']),
 copied_uid:uid.optional(),reason:z.enum(['append_limit','missing_sent','ambiguous_sent','append_unknown','copy_not_found','copy_ambiguous','uidvalidity_changed','inspection_limit']).optional(),
 scan:z.strictObject({next_uid:z.number().int().min(1).max(4294967296),end_uid:z.number().int().min(0).max(4294967295),pending:z.array(uid).max(16),matches:z.array(uid).max(2)}).optional()})
 .superRefine((v,c)=>{if(v.state==='server_managed'&&v.plan.mode!=='server_managed'||v.plan.mode==='server_managed'&&v.state!=='server_managed'||v.copied_uid!==undefined&&v.state!=='copied'
 ||v.scan&&(v.plan.mode!=='append'||v.scan.next_uid<v.plan.uidnext!||v.scan.matches.length!==new Set(v.scan.matches).size||v.scan.pending.length!==new Set(v.scan.pending).size))c.addIssue({code:'custom',message:'Invalid Sent-copy progress'});});
export type EmailSentCopyValue=z.infer<typeof EmailSentCopyValueSchema>;
export type EmailSentCopyJournal=Readonly<{create(plan:EmailSentCopyPlan):Promise<EmailSentCopyValue>;load(scope:EmailSentCopyPlan['scope'],operationId:string):Promise<EmailSentCopyValue|null>;
 change<T>(scope:EmailSentCopyPlan['scope'],operationId:string,work:(value:EmailSentCopyValue|null,write:(next:EmailSentCopyValue)=>Promise<void>)=>Promise<T>|T):Promise<T>}>;
export const NativeEmailSentCopyRequestSchema=z.strictObject({operation_id:z.string().uuid(),mime_digest:sha,mime_bytes:z.custom<Uint8Array>(v=>v instanceof Uint8Array&&v.length>=1&&v.length<=35*1024*1024)});
export const NativeEmailSentCopyResultSchema=z.strictObject({schema_version:z.literal('deft.email_sent_copy_result.v1'),account_id:id,operation_id:z.string().uuid(),mime_digest:sha,
 outcome:z.enum(['copied','unknown','failed','server_managed','pending'])});
export type NativeEmailSentCopyRequest=z.infer<typeof NativeEmailSentCopyRequestSchema>;
export type NativeEmailSentCopyResult=z.infer<typeof NativeEmailSentCopyResultSchema>;
export const EmailSentCopySettingsSchema=z.strictObject({account_id:id,revision:z.number().int().positive().safe(),sent_copy_mode:z.enum(['server_managed','append']),provider:z.literal('imap_smtp'),
 append_available:z.boolean(),reason:z.enum(['modify_unavailable','sent_folder_unavailable','connection_unavailable']).optional()}).refine(v=>v.append_available?v.reason===undefined:v.reason!==undefined);
export type EmailSentCopySettings=z.infer<typeof EmailSentCopySettingsSchema>;
