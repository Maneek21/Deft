import {z} from 'zod';
const id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)),sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const EmailGraphSendPlanSchema=z.strictObject({schema_version:z.literal('deft.email_graph_send_plan.v1'),operation_id:z.string().uuid(),
 scope:z.strictObject({org_id:id,owner_user_id:id,account_id:id}),binding_digest:sha,mime_digest:sha,skeleton_digest:sha,content_digest:sha,from_address:z.string().email().max(320),
 files:z.array(z.strictObject({index:z.number().int().min(0).max(31),name:z.string().min(1).max(255),content_type:id,disposition:z.enum(['inline','attachment']),content_id:z.string().max(256),size:z.number().int().min(0).max(25*1024*1024),digest:sha})).max(32),digest:sha})
 .refine(v=>v.files.every((file,index)=>file.index===index)&&v.files.reduce((size,file)=>size+file.size,0)<=25*1024*1024);
export type EmailGraphSendPlan=z.infer<typeof EmailGraphSendPlanSchema>;
const phase=z.enum(['prepared','started','applied','unknown','conflict']);
export const EmailGraphSendValueSchema=z.strictObject({plan:EmailGraphSendPlanSchema,prepare_attempts:z.number().int().min(0).max(64),create:z.strictObject({state:phase,ref:id.optional()}),
 files:z.array(z.strictObject({index:z.number().int().min(0).max(31),state:z.enum(['prepared','session_started','uploading','applied','unknown','conflict']),offset:z.number().int().min(0).max(25*1024*1024),
  upload_url:z.string().max(8192).optional(),expires_at:z.iso.datetime().optional(),range:z.strictObject({start:z.number().int().nonnegative(),end:z.number().int().nonnegative()}).optional(),attachment_id:id.optional()})).max(32),
 send:z.strictObject({state:z.enum(['prepared','started','accepted','unknown'])})}).superRefine((v,c)=>{
 if(v.files.length!==v.plan.files.length||v.files.some((f,i)=>f.index!==i||f.offset>v.plan.files[i]!.size||f.state==='applied'&&f.offset!==v.plan.files[i]!.size||Boolean(f.upload_url)!==Boolean(f.expires_at)
  ||f.range&&(f.range.start!==f.offset||f.range.end<f.range.start||f.range.end>=v.plan.files[i]!.size))||v.create.state==='applied'&&!v.create.ref||v.send.state!=='prepared'&&(!v.files.every(f=>f.state==='applied')||v.create.state!=='applied'))c.addIssue({code:'custom',message:'Invalid Graph send progress'});
});
export type EmailGraphSendValue=z.infer<typeof EmailGraphSendValueSchema>;
export type EmailGraphSendJournal=Readonly<{create(plan:EmailGraphSendPlan):Promise<EmailGraphSendValue>;load(scope:EmailGraphSendPlan['scope'],operationId:string):Promise<EmailGraphSendValue|null>;
 change<T>(scope:EmailGraphSendPlan['scope'],operationId:string,work:(value:EmailGraphSendValue|null,write:(next:EmailGraphSendValue)=>Promise<void>)=>Promise<T>|T):Promise<T>}>;
