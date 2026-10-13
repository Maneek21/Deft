import {z} from 'zod';
import {NativeEmailSendIdentitySchema} from './app-connection-contract.js';
const id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export const EmailOutboxScopeSchema=z.strictObject({org_id:id,owner_user_id:id,account_id:id});
export const EmailOutboxScheduleInputSchema=z.strictObject({wall_time:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),zone:z.string().min(1).max(128),
 ambiguity:z.enum(['earlier','later','reject']),missed_policy:z.enum(['send_when_available','pause_if_late'])});
export const EmailOutboxScheduleSchema=EmailOutboxScheduleInputSchema.extend({instant:z.iso.datetime(),rules_version:z.string().min(1).max(128)});
export type EmailOutboxSchedule=z.infer<typeof EmailOutboxScheduleSchema>;
export const EmailOutboxEnqueueSchema=z.strictObject({draft_id:z.string().uuid(),expected_revision:z.number().int().min(1).max(2147483645),request_id:z.string().uuid(),
 undo_delay_seconds:z.number().int().min(0).max(120),schedule:EmailOutboxScheduleInputSchema.optional()});
export const EmailOutboxTransportSchema=z.strictObject({operation_id:z.string().uuid(),snapshot_id:id,snapshot_digest:z.string().regex(/^[a-f0-9]{64}$/u),mime_digest:z.string().regex(/^[a-f0-9]{64}$/u),
 scope:z.strictObject({org_id:id,owner_id:id,installation_id:id}),account_id:id,authority_epoch:z.number().int().positive(),draft_id:z.string().uuid(),draft_revision:z.number().int().positive(),
 from_address:z.string().email().max(320),transport_kind:z.enum(['gmail_raw','graph_raw','smtp_raw']),thread_id:id.optional(),
 envelope:z.strictObject({from:z.string().email().max(320),to:z.array(z.string().email().max(320)).min(1).max(200).refine(a=>new Set(a.map(v=>v.toLowerCase())).size===a.length)}).optional()})
 .superRefine((v,c)=>{if(v.transport_kind==='smtp_raw'?(v.envelope?.from!==v.from_address||v.thread_id!==undefined):v.envelope!==undefined)c.addIssue({code:'custom',message:'Invalid transport envelope'});});
export const EmailOutboxSnapshotSchema=z.strictObject({schema_version:z.literal('deft.email_outbox_snapshot.v1'),request:EmailOutboxEnqueueSchema,
 identity:NativeEmailSendIdentitySchema,transport:EmailOutboxTransportSchema,mime_digest:z.string().regex(/^[a-f0-9]{64}$/u),byte_length:z.number().int().min(1).max(35*1024*1024),
 display:z.strictObject({subject:z.string().max(998),to:z.string().max(8192),cc:z.string().max(8192),bcc:z.string().max(8192)}),
 schedule:EmailOutboxScheduleSchema.nullable(),undo_until:z.iso.datetime()});
export type EmailOutboxSnapshot=z.infer<typeof EmailOutboxSnapshotSchema>;
export type EmailOutboxState='queued'|'paused'|'submitting'|'accepted'|'uncertain'|'cancelled';
export type EmailOutboxLease=Readonly<{job_id:string;lock_token:string;job_name:'native-email-outbox';outbox_id:string;operation_id:string}>;
export type EmailOutboxPublic=Readonly<{outbox_id:string;operation_id:string;draft_id:string;draft_revision:number;revision:number;state:EmailOutboxState;
 account_id:string;from_address:string;subject:string;to:string;cc:string;bcc:string;earliest_dispatch_at:string;undo_until:string;schedule:EmailOutboxSchedule|null;
 reason:string|null;delivery_status:'unknown';created_at:string;updated_at:string}>;
export type EmailOutboxGuard=(transaction:unknown)=>Promise<void>;
export const EMAIL_OUTBOX_JOB='native-email-outbox';
export const EMAIL_OUTBOX_EVENT_LIMIT=128;
export const EmailOutboxJobSchema=EmailOutboxScopeSchema.extend({outbox_id:z.string().uuid(),operation_id:z.string().uuid(),authority_revision:z.number().int().min(1).max(2147483647)});
