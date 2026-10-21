import {createHash} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailAttachments,emailDrafts,emailProviderDraftMirrors} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {trustedRichtextInlineFileIds} from '@deft/app-kit/experience/core';
import type {EmailScope} from './email-mailbox-service.js';
import {EmailDraftStore,emailDraftContext as draftContext,type EmailDraftGuard} from './email-draft-store.js';
import {EmailDraftContentSchema} from './email-draft-service.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailAttachmentCrypto,EMAIL_ATTACHMENT_MAX_BYTES} from './email-attachment-crypto.js';

const schema={emailAccounts,emailAttachments,emailDrafts,emailProviderDraftMirrors};
type Database=Pick<NodePgDatabase<typeof schema>,'transaction'>;
export const EmailAttachmentMetadataSchema=z.strictObject({file_id:z.string().uuid(),filename:z.string().min(1).max(255).refine(value=>!/[\/\\\u0000-\u001f\u007f]/u.test(value)),
 media_type:z.string().regex(/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u),size_bytes:z.number().int().min(0).max(EMAIL_ATTACHMENT_MAX_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/u)});
export type EmailAttachmentMetadata=z.infer<typeof EmailAttachmentMetadataSchema>;
const draftWhere=(scope:EmailScope,draftId:string)=>and(eq(emailDrafts.org_id,scope.org_id),eq(emailDrafts.owner_user_id,scope.owner_user_id),eq(emailDrafts.account_id,scope.account_id),eq(emailDrafts.draft_id,draftId));
const filesWhere=(scope:EmailScope,draftId:string)=>and(eq(emailAttachments.org_id,scope.org_id),eq(emailAttachments.owner_user_id,scope.owner_user_id),eq(emailAttachments.account_id,scope.account_id),eq(emailAttachments.draft_id,draftId));
const fileContext=(scope:EmailScope,draftId:string,fileId:string)=>({...scope,kind:'attachment' as const,record_id:'attachment:'+draftId+':'+fileId,revision:1});
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function failure(code:string):never{throw Object.assign(Error(code),{code});}

/** Draft lock serializes attachment changes with autosave and Send. All bytes
 * and metadata remain encrypted, with no file path or Experience lease. */
export class EmailAttachmentStore{
 constructor(private readonly database:Database,private readonly metadata:EmailMailboxCrypto,private readonly binary:EmailAttachmentCrypto,private readonly now=()=>new Date()){}
 private open(scope:EmailScope,draftId:string,row:typeof emailAttachments.$inferSelect){
  const value=EmailAttachmentMetadataSchema.parse(this.metadata.open(row.metadata_envelope,fileContext(scope,draftId,row.file_id)));
  if(value.file_id!==row.file_id||value.size_bytes!==row.size_bytes)failure('EMAIL_ATTACHMENT_UNAVAILABLE');return value;
 }
 async upload(scope:EmailScope,draftId:string,expectedRevision:number,fileId:string,input:{filename:string;media_type:string},bytes:Uint8Array,guard:EmailDraftGuard,signal?:AbortSignal){
  const metadata=EmailAttachmentMetadataSchema.parse({...input,file_id:fileId,size_bytes:bytes.byteLength,sha256:digest(bytes)});
  const sealed=this.binary.seal({...scope,draft_id:draftId,file_id:fileId},bytes);
  try{return await this.database.transaction(async tx=>{
   await guard(tx);signal?.throwIfAborted();
   const [draft]=await tx.select().from(emailDrafts).where(draftWhere(scope,draftId)).for('update');
   if(!draft)failure('EMAIL_DRAFT_NOT_FOUND');
   const content=EmailDraftContentSchema.parse(this.metadata.open(draft.content_envelope,draftContext(scope,draftId,draft.content_revision)));
   const [prior]=await tx.select().from(emailAttachments).where(and(filesWhere(scope,draftId),eq(emailAttachments.file_id,fileId))).limit(1);
   if(prior){
    if(prior.detached_at||prior.upload_revision!==expectedRevision||draft.revision!==expectedRevision+1||draft.status!=='draft'
     ||canonicalCapabilityJson(this.open(scope,draftId,prior))!==canonicalCapabilityJson(metadata)
     ||!content.attachments.some(file=>canonicalCapabilityJson(file)===canonicalCapabilityJson(metadata)))failure('EMAIL_DRAFT_CONFLICT');
    await guard(tx);signal?.throwIfAborted();return {revision:draft.revision,file:metadata};
   }
   if(draft.status!=='draft'||draft.revision!==expectedRevision||draft.revision>=2147483646)failure('EMAIL_DRAFT_CONFLICT');
   const active=await tx.select({size:emailAttachments.size_bytes}).from(emailAttachments).where(and(filesWhere(scope,draftId),isNull(emailAttachments.detached_at))).limit(33);
   if(active.length>=32||active.reduce((sum,row)=>sum+row.size,bytes.byteLength)>EMAIL_ATTACHMENT_MAX_BYTES)failure('EMAIL_ATTACHMENT_TOO_LARGE');
   const next=EmailDraftContentSchema.parse({...content,attachments:[...content.attachments,metadata]}),revision=draft.revision+1;
   await tx.insert(emailAttachments).values({...scope,draft_id:draftId,file_id:fileId,upload_revision:expectedRevision,size_bytes:bytes.byteLength,
    metadata_envelope:this.metadata.seal(metadata,fileContext(scope,draftId,fileId)),...sealed});
   await tx.update(emailDrafts).set({revision,content_revision:revision,content_envelope:this.metadata.seal(next,draftContext(scope,draftId,revision)),
    last_edited_by_user_id:scope.owner_user_id,updated_at:this.now()}).where(draftWhere(scope,draftId));
   await new EmailDraftStore(this.database,this.metadata,this.now).recordDesired(tx,scope,draftId,revision);
   await guard(tx);signal?.throwIfAborted();return {revision,file:metadata};
  });}finally{sealed.ciphertext.fill(0);}
 }
 async detach(scope:EmailScope,draftId:string,expectedRevision:number,fileId:string,guard:EmailDraftGuard,signal?:AbortSignal){
  return this.database.transaction(async tx=>{
   await guard(tx);signal?.throwIfAborted();const [draft]=await tx.select().from(emailDrafts).where(draftWhere(scope,draftId)).for('update');
   if(!draft)failure('EMAIL_DRAFT_NOT_FOUND');if(draft.status!=='draft'||draft.revision!==expectedRevision||draft.revision>=2147483646)failure('EMAIL_DRAFT_CONFLICT');
   const [file]=await tx.select().from(emailAttachments).where(and(filesWhere(scope,draftId),eq(emailAttachments.file_id,fileId))).limit(1);
   if(!file||file.detached_at)failure('EMAIL_ATTACHMENT_UNAVAILABLE');
   const content=EmailDraftContentSchema.parse(this.metadata.open(draft.content_envelope,draftContext(scope,draftId,draft.content_revision)));
   // Removing a file must not orphan a saved body reference. The caller first
   // removes its image atom and acknowledges the current draft save.
   if(/<img\b|cid:deft-/iu.test(content.body_html)){
    let references:readonly string[];try{references=trustedRichtextInlineFileIds(content.body_html,{inlineAttachments:content.attachments});}
    catch{failure('EMAIL_DRAFT_CONFLICT');}
    if(references!.includes(fileId))failure('EMAIL_DRAFT_CONFLICT');
   }
   const next={...content,attachments:content.attachments.filter(item=>item.file_id!==fileId)},revision=draft.revision+1;
   await tx.update(emailAttachments).set({detached_at:this.now()}).where(and(filesWhere(scope,draftId),eq(emailAttachments.file_id,fileId)));
   await tx.update(emailDrafts).set({revision,content_revision:revision,content_envelope:this.metadata.seal(next,draftContext(scope,draftId,revision)),
    last_edited_by_user_id:scope.owner_user_id,updated_at:this.now()}).where(draftWhere(scope,draftId));
   await new EmailDraftStore(this.database,this.metadata,this.now).recordDesired(tx,scope,draftId,revision);
   await guard(tx);signal?.throwIfAborted();return {revision};
  });
 }
 /** Send supplies the exact pinned saved metadata; download uses the same
  * currently attached reference. No nominated file id alone releases bytes. */
 async read(scope:EmailScope,draftId:string,fileId:string,expected:EmailAttachmentMetadata|undefined,guard:EmailDraftGuard,signal?:AbortSignal){
  let bytes:Buffer|undefined;
  try{return await this.database.transaction(async tx=>{
   await guard(tx);signal?.throwIfAborted();const [draft]=await tx.select().from(emailDrafts).where(draftWhere(scope,draftId)).limit(1).for('share');
   if(!draft||draft.status==='archived')failure('EMAIL_ATTACHMENT_UNAVAILABLE');
   const [file]=await tx.select().from(emailAttachments).where(and(filesWhere(scope,draftId),eq(emailAttachments.file_id,fileId))).limit(1);
   if(!file||file.detached_at)failure('EMAIL_ATTACHMENT_UNAVAILABLE');
   const value=this.open(scope,draftId,file),content=EmailDraftContentSchema.parse(this.metadata.open(draft.content_envelope,draftContext(scope,draftId,draft.content_revision)));
   if(expected&&canonicalCapabilityJson(expected)!==canonicalCapabilityJson(value)
    ||!content.attachments.some(item=>canonicalCapabilityJson(item)===canonicalCapabilityJson(value)))failure('EMAIL_ATTACHMENT_UNAVAILABLE');
   bytes=this.binary.open({...scope,draft_id:draftId,file_id:fileId},file);
   if(bytes.length!==value.size_bytes||digest(bytes)!==value.sha256)failure('EMAIL_ATTACHMENT_UNAVAILABLE');
   await guard(tx);signal?.throwIfAborted();return {...value,bytes};
  });}catch(error){bytes?.fill(0);throw error;}
 }
}
