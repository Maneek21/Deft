import {createHash,randomUUID} from 'node:crypto';
import {and,desc,eq,lt,or} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {emailOutbox,emailOutboxEvents,emailDrafts,emailAccounts,emailProviderDraftMirrors,emailOperations,jobQueue} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailOutboxCrypto} from './email-outbox-crypto.js';
import {EmailDraftStore,emailDraftContext} from './email-draft-store.js';
import {EmailOutboxSnapshotSchema,EmailOutboxScheduleSchema,EmailOutboxEnqueueSchema,EMAIL_OUTBOX_JOB,type EmailOutboxSnapshot,type EmailOutboxGuard,type EmailOutboxLease,type EmailOutboxState,type EmailOutboxPublic,type EmailOutboxSchedule} from './email-outbox-contract.js';
import type {EmailScope} from './email-mailbox-service.js';
import {EMAIL_SENT_COPY_JOB,EmailSentCopyJobSchema,EmailSentCopyValueSchema,type EmailSentCopyLease} from './email-sent-copy-contract.js';
const schema={emailOutbox,emailOutboxEvents,emailDrafts,emailAccounts,emailProviderDraftMirrors,jobQueue};
type Database=Pick<NodePgDatabase<typeof schema>,'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
export type EmailOutboxTransaction=Tx;
type Row=typeof emailOutbox.$inferSelect;
const State=z.strictObject({schedule:EmailOutboxScheduleSchema.nullable(),reason:z.enum(['authority_changed','missed_schedule','send_unknown','preparation_unknown','preparation_conflict']).nullable(),provider_message_id:z.string().min(1).max(256).nullable()});
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const key=(scope:EmailScope,id:string)=>and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),eq(emailOutbox.outbox_id,id));
const draftKey=(scope:EmailScope,id:string)=>and(eq(emailDrafts.org_id,scope.org_id),eq(emailDrafts.owner_user_id,scope.owner_user_id),eq(emailDrafts.account_id,scope.account_id),eq(emailDrafts.draft_id,id));
const context=(scope:EmailScope,id:string,kind:string,revision:number)=>({...scope,kind:'operation' as const,record_id:`outbox:${id}:${kind}`,revision});
const terminal=(state:EmailOutboxState)=>['accepted','uncertain','cancelled'].includes(state);
export class EmailOutboxStore{
 constructor(private readonly database:Database,private readonly crypto:EmailMailboxCrypto,private readonly binary:EmailOutboxCrypto,private readonly now=()=>new Date()){}
 private values(scope:EmailScope,row:Row){
  const snapshot=EmailOutboxSnapshotSchema.parse(this.crypto.open(row.snapshot_envelope,context(scope,row.outbox_id,'snapshot',1)));
  const state=State.parse(this.crypto.open(row.state_envelope,context(scope,row.outbox_id,'state',row.revision)));
  if(snapshot.transport.account_id!==scope.account_id||snapshot.transport.scope.org_id!==scope.org_id||snapshot.transport.scope.owner_id!==scope.owner_user_id
   ||snapshot.transport.operation_id!==row.operation_id||snapshot.request.request_id!==row.request_id||snapshot.request.draft_id!==row.draft_id||snapshot.request.expected_revision!==row.draft_revision
   ||snapshot.mime_digest!==row.mime_digest||snapshot.byte_length!==row.byte_length||snapshot.transport.mime_digest!==row.mime_digest)throw Error('EMAIL_OUTBOX_UNAVAILABLE');
  return {snapshot,state};
 }
 private project(scope:EmailScope,row:Row):EmailOutboxPublic{
  const {snapshot,state}=this.values(scope,row);return Object.freeze({outbox_id:row.outbox_id,operation_id:row.operation_id,draft_id:row.draft_id,draft_revision:row.draft_revision,revision:row.revision,state:row.state,
   account_id:scope.account_id,from_address:snapshot.transport.from_address,...snapshot.display,earliest_dispatch_at:row.earliest_dispatch_at.toISOString(),undo_until:snapshot.undo_until,
   schedule:state.schedule,reason:state.reason,delivery_status:'unknown',created_at:row.created_at.toISOString(),updated_at:row.updated_at.toISOString()});
 }
 private async transition(tx:Tx,scope:EmailScope,row:Row,state:EmailOutboxState,value:z.infer<typeof State>,extras:Partial<typeof emailOutbox.$inferInsert>={}){
  if(row.revision>=128||terminal(row.state))throw Error('EMAIL_OUTBOX_CONFLICT');const revision=row.revision+1,at=this.now();
  const [updated]=await tx.update(emailOutbox).set({...extras,state,revision,state_envelope:this.crypto.seal(State.parse(value),context(scope,row.outbox_id,'state',revision)),updated_at:at}).where(and(key(scope,row.outbox_id),eq(emailOutbox.revision,row.revision))).returning();
  if(!updated)throw Error('EMAIL_OUTBOX_CONFLICT');
  await tx.insert(emailOutboxEvents).values({...scope,outbox_id:row.outbox_id,revision,envelope:this.crypto.seal({state,reason:value.reason,at:at.toISOString(),attempt_id:updated.attempt_id},context(scope,row.outbox_id,'event',revision)),created_at:at});
  return updated;
 }
 async byRequest(scope:EmailScope,request:ReturnType<typeof EmailOutboxEnqueueSchema.parse>,guard:EmailOutboxGuard,signal?:AbortSignal){
  return this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),eq(emailOutbox.request_id,request.request_id))).limit(1);
   if(row&&canonicalCapabilityJson(this.values(scope,row).snapshot.request)!==canonicalCapabilityJson(request))throw Error('EMAIL_OUTBOX_CONFLICT');await guard(tx);signal?.throwIfAborted();return row?this.project(scope,row):null;});
 }
 async readRequest(scope:EmailScope,requestId:string,guard:EmailOutboxGuard,signal?:AbortSignal){z.string().uuid().parse(requestId);return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),eq(emailOutbox.request_id,requestId))).limit(1);
  await guard(tx);signal?.throwIfAborted();return row?this.project(scope,row):null;});}
 async readDraft(scope:EmailScope,draftId:string,revision:number,guard:EmailOutboxGuard,signal?:AbortSignal){z.string().uuid().parse(draftId);if(!Number.isSafeInteger(revision)||revision<1||revision>2147483647)throw Error('EMAIL_OUTBOX_INVALID');return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),eq(emailOutbox.draft_id,draftId),eq(emailOutbox.draft_revision,revision))).limit(1);
  await guard(tx);signal?.throwIfAborted();return row?this.project(scope,row):null;});}
 async enqueue(scope:EmailScope,outboxId:string,snapshotRaw:EmailOutboxSnapshot,bytes:Uint8Array,guard:EmailOutboxGuard,signal?:AbortSignal):Promise<EmailOutboxPublic>{
  return this.database.transaction(tx=>this.enqueueInTransaction(tx,scope,outboxId,snapshotRaw,bytes,guard,signal));
 }
 /** Host-only atomic composition with another owner action (Calendar RSVP).
  * The caller must await this inside its real SQL transaction; this method
  * performs no provider I/O and preserves the ordinary enqueue invariants. */
 async enqueueInTransaction(tx:Tx,scope:EmailScope,outboxId:string,snapshotRaw:EmailOutboxSnapshot,bytes:Uint8Array,guard:EmailOutboxGuard,signal?:AbortSignal):Promise<EmailOutboxPublic>{
  const snapshot=EmailOutboxSnapshotSchema.parse(snapshotRaw),operationId=snapshot.transport.operation_id;
  if(bytes.length>35*1024*1024||bytes.length!==snapshot.byte_length||hash(bytes)!==snapshot.mime_digest||snapshot.transport.mime_digest!==snapshot.mime_digest
   ||snapshot.identity.account_id!==scope.account_id||snapshot.identity.org_id!==scope.org_id||snapshot.identity.owner_user_id!==scope.owner_user_id
   ||snapshot.transport.account_id!==scope.account_id||snapshot.transport.scope.org_id!==scope.org_id||snapshot.transport.scope.owner_id!==scope.owner_user_id
   ||snapshot.transport.scope.installation_id!==snapshot.identity.installation_id||snapshot.transport.authority_epoch!==snapshot.identity.authority_epoch
   ||!snapshot.identity.verified_sender_identities.includes(snapshot.identity.primary_address)||!snapshot.identity.verified_sender_identities.includes(snapshot.transport.from_address)
   ||snapshot.transport.draft_id!==snapshot.request.draft_id||snapshot.transport.draft_revision!==snapshot.request.expected_revision
   ||snapshot.transport.transport_kind!==({gmail:'gmail_raw',microsoft:'graph_raw',imap_smtp:'smtp_raw'} as const)[snapshot.identity.provider])throw Error('EMAIL_OUTBOX_INVALID');
  const sealed=this.binary.seal({...scope,outbox_id:outboxId,operation_id:operationId,mime_digest:snapshot.mime_digest},bytes);
  try{
   await guard(tx);signal?.throwIfAborted();const [draft]=await tx.select().from(emailDrafts).where(draftKey(scope,snapshot.request.draft_id)).for('update');
   const [existing]=await tx.select().from(emailOutbox).where(and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),eq(emailOutbox.request_id,snapshot.request.request_id))).limit(1);
   if(existing){if(canonicalCapabilityJson(this.values(scope,existing).snapshot.request)!==canonicalCapabilityJson(snapshot.request))throw Error('EMAIL_OUTBOX_CONFLICT');await guard(tx);signal?.throwIfAborted();return this.project(scope,existing);}
   if(!draft||draft.status!=='draft'||draft.revision!==snapshot.request.expected_revision||draft.content_revision!==draft.revision)throw Error('EMAIL_OUTBOX_CONFLICT');
   const at=this.now(),earliest=new Date(Math.max(Date.parse(snapshot.undo_until),snapshot.schedule?Date.parse(snapshot.schedule.instant):0));
   const [account]=await tx.select({revision:emailAccounts.authority_revision}).from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
   const authorityRevision=account?.revision;if(!Number.isFinite(earliest.getTime())||!Number.isSafeInteger(authorityRevision)||authorityRevision!<1)throw Error('EMAIL_OUTBOX_INVALID');
   const jobId=randomUUID();const [row]=await tx.insert(emailOutbox).values({...scope,outbox_id:outboxId,request_id:snapshot.request.request_id,operation_id:operationId,draft_id:draft.draft_id,draft_revision:draft.revision,state:'queued',job_id:jobId,
    earliest_dispatch_at:earliest,snapshot_envelope:this.crypto.seal(snapshot,context(scope,outboxId,'snapshot',1)),state_envelope:this.crypto.seal({schedule:snapshot.schedule,reason:null,provider_message_id:null},context(scope,outboxId,'state',1)),mime_digest:snapshot.mime_digest,byte_length:bytes.length,...sealed,created_at:at,updated_at:at}).returning();
   await tx.insert(emailOutboxEvents).values({...scope,outbox_id:outboxId,revision:1,envelope:this.crypto.seal({state:'queued',reason:null,at:at.toISOString(),attempt_id:null},context(scope,outboxId,'event',1)),created_at:at});
   await tx.update(emailDrafts).set({status:'submitted',revision:draft.revision+1,submitted_at:at,updated_at:at}).where(draftKey(scope,draft.draft_id));
   await tx.insert(jobQueue).values({id:jobId,org_id:scope.org_id,queue:'scheduled-jobs',name:EMAIL_OUTBOX_JOB,data:{...scope,outbox_id:outboxId,operation_id:operationId,authority_revision:authorityRevision},status:'pending',run_at:earliest,max_attempts:2,dedupe_key:`email-outbox:${scope.owner_user_id}:${scope.account_id}:${outboxId}`});
   await guard(tx);signal?.throwIfAborted();return this.project(scope,row!);
  }finally{sealed.ciphertext.fill(0);}
 }
 async read(scope:EmailScope,outboxId:string,guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).limit(1);await guard(tx);signal?.throwIfAborted();return row?{public:this.project(scope,row),snapshot:this.values(scope,row).snapshot}:null;});}
 async cancel(scope:EmailScope,outboxId:string,expectedRevision:number,guard:EmailOutboxGuard,signal?:AbortSignal){
  return this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const [locator]=await tx.select({draft_id:emailOutbox.draft_id,job_id:emailOutbox.job_id}).from(emailOutbox).where(key(scope,outboxId)).limit(1);if(!locator)throw Error('EMAIL_OUTBOX_NOT_FOUND');
   // Service authority locks queue before domain. Human mutations use the same
   // order; updating the queue after taking the outbox lock would deadlock.
   await tx.select({id:jobQueue.id}).from(jobQueue).where(and(eq(jobQueue.id,locator.job_id),eq(jobQueue.org_id,scope.org_id))).for('update');
   const [draft]=await tx.select().from(emailDrafts).where(draftKey(scope,locator.draft_id)).for('update');const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).for('update');
   if(!row||row.revision!==expectedRevision||!['queued','paused'].includes(row.state)||!draft||draft.status!=='submitted'||draft.content_revision!==row.draft_revision||draft.revision!==row.draft_revision+1)throw Error('EMAIL_OUTBOX_CONFLICT');
   const {state}=this.values(scope,row),updated=await this.transition(tx,scope,row,'cancelled',state),revision=draft.revision+1;
   const content=this.crypto.open(draft.content_envelope,emailDraftContext(scope,draft.draft_id,draft.content_revision));
   await tx.update(emailDrafts).set({status:'draft',revision,content_revision:revision,content_envelope:this.crypto.seal(content,emailDraftContext(scope,draft.draft_id,revision)),submitted_at:null,updated_at:this.now()}).where(draftKey(scope,draft.draft_id));
   await new EmailDraftStore(this.database,this.crypto,this.now).recordDesired(tx,scope,draft.draft_id,revision);
   await tx.update(jobQueue).set({status:'completed',completed_at:this.now(),lock_token:null,locked_by:null,lock_expires_at:null}).where(and(eq(jobQueue.id,row.job_id),eq(jobQueue.org_id,scope.org_id)));
   await guard(tx);signal?.throwIfAborted();return this.project(scope,updated);
  });
 }
 async reschedule(scope:EmailScope,outboxId:string,expectedRevision:number,schedule:EmailOutboxSchedule,guard:EmailOutboxGuard,signal?:AbortSignal){
  EmailOutboxScheduleSchema.parse(schedule);return this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const [locator]=await tx.select({job_id:emailOutbox.job_id}).from(emailOutbox).where(key(scope,outboxId)).limit(1);if(!locator)throw Error('EMAIL_OUTBOX_NOT_FOUND');
   await tx.select({id:jobQueue.id}).from(jobQueue).where(and(eq(jobQueue.id,locator.job_id),eq(jobQueue.org_id,scope.org_id))).for('update');
   const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).for('update');
   if(!row||row.revision!==expectedRevision||!['queued','paused'].includes(row.state)||row.revision>=120)throw Error('EMAIL_OUTBOX_CONFLICT');const {state,snapshot}=this.values(scope,row);
   const due=new Date(Math.max(Date.parse(schedule.instant),Date.parse(snapshot.undo_until)));if(due.getTime()<this.now().getTime())throw Error('EMAIL_OUTBOX_SCHEDULE_PAST');
   const updated=await this.transition(tx,scope,row,'queued',{...state,schedule,reason:null},{earliest_dispatch_at:due});
   const [job]=await tx.update(jobQueue).set({status:'pending',attempts:0,run_at:due,completed_at:null,error:null,lock_token:null,locked_by:null,lock_expires_at:null}).where(and(eq(jobQueue.id,row.job_id),eq(jobQueue.org_id,scope.org_id))).returning();if(!job)throw Error('EMAIL_OUTBOX_UNAVAILABLE');
   await guard(tx);signal?.throwIfAborted();return this.project(scope,updated);
  });
 }
 async pause(scope:EmailScope,outboxId:string,reason:'authority_changed'|'missed_schedule'|'preparation_unknown'|'preparation_conflict',guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).for('update');if(!row||terminal(row.state)||row.state==='submitting'){await guard(tx);signal?.throwIfAborted();return;}
  const {state}=this.values(scope,row);if(row.state==='paused'&&state.reason===reason){await guard(tx);signal?.throwIfAborted();return;}if(row.revision>=120)throw Error('EMAIL_OUTBOX_CONFLICT');await this.transition(tx,scope,row,'paused',{...state,reason});await guard(tx);signal?.throwIfAborted();});}
 async readPreparation(scope:EmailScope,outboxId:string,lease:EmailOutboxLease,guard:EmailOutboxGuard,signal?:AbortSignal){let bytes:Buffer|undefined;try{return await this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).limit(1);
  if(!row||row.job_id!==lease.job_id||row.operation_id!==lease.operation_id||row.outbox_id!==lease.outbox_id)throw Error('EMAIL_OUTBOX_LEASE_DENIED');
  const {snapshot,state}=this.values(scope,row);await guard(tx);signal?.throwIfAborted();
  if(row.state!=='queued')return {kind:'settled' as const,state:row.state};
  if(row.earliest_dispatch_at.getTime()>this.now().getTime())return {kind:'wait' as const,delay_ms:row.earliest_dispatch_at.getTime()-this.now().getTime()};
  if(state.schedule?.missed_policy==='pause_if_late'&&this.now().getTime()-Date.parse(state.schedule.instant)>5*60000)return {kind:'missed' as const};
  bytes=this.binary.open({...scope,outbox_id:outboxId,operation_id:row.operation_id,mime_digest:row.mime_digest},row);if(bytes.length!==row.byte_length||hash(bytes)!==row.mime_digest)throw Error('EMAIL_OUTBOX_UNAVAILABLE');
  await guard(tx);signal?.throwIfAborted();return {kind:'prepare' as const,bytes,snapshot};
 });}catch(error){bytes?.fill(0);throw error;}}
 async verifyQueuedPreparation(scope:EmailScope,outboxId:string,lease:EmailOutboxLease,mimeDigest:string,guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select({state:emailOutbox.state,operation_id:emailOutbox.operation_id,job_id:emailOutbox.job_id,mime_digest:emailOutbox.mime_digest}).from(emailOutbox).where(key(scope,outboxId)).limit(1);
  const allowed=!!row&&row.state==='queued'&&row.operation_id===lease.operation_id&&row.job_id===lease.job_id&&row.mime_digest===mimeDigest;await guard(tx);signal?.throwIfAborted();return allowed;});}
 async claim(scope:EmailScope,outboxId:string,lease:EmailOutboxLease,guard:EmailOutboxGuard,signal?:AbortSignal){let bytes:Buffer|undefined;
  try{return await this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).for('update');
   if(!row||row.job_id!==lease.job_id||row.operation_id!==lease.operation_id||row.outbox_id!==lease.outbox_id)throw Error('EMAIL_OUTBOX_LEASE_DENIED');
   const {state,snapshot}=this.values(scope,row);await guard(tx);signal?.throwIfAborted();
   if(terminal(row.state)||row.state==='paused')return {kind:'settled' as const,value:this.project(scope,row)};
   if(row.state==='submitting'){
    if(row.attempt_lock_hash===hash(lease.lock_token))return {kind:'settled' as const,value:this.project(scope,row)};
    const updated=await this.transition(tx,scope,row,'uncertain',{...state,reason:'send_unknown'});await guard(tx);return {kind:'settled' as const,value:this.project(scope,updated)};
   }
   if(row.earliest_dispatch_at.getTime()>this.now().getTime())return {kind:'wait' as const,delay_ms:row.earliest_dispatch_at.getTime()-this.now().getTime()};
   if(state.schedule?.missed_policy==='pause_if_late'&&this.now().getTime()-Date.parse(state.schedule.instant)>5*60000){const updated=await this.transition(tx,scope,row,'paused',{...state,reason:'missed_schedule'});await guard(tx);return {kind:'settled' as const,value:this.project(scope,updated)};}
   bytes=this.binary.open({...scope,outbox_id:outboxId,operation_id:row.operation_id,mime_digest:row.mime_digest},row);if(bytes.length!==row.byte_length||hash(bytes)!==row.mime_digest)throw Error('EMAIL_OUTBOX_UNAVAILABLE');
   const attemptId=randomUUID();const updated=await this.transition(tx,scope,row,'submitting',state,{attempt_id:attemptId,attempt_lock_hash:hash(lease.lock_token),started_at:this.now()});await guard(tx);signal?.throwIfAborted();
   return {kind:'dispatch' as const,value:this.project(scope,updated),snapshot,bytes,attempt_id:attemptId};
  });}catch(error){bytes?.fill(0);throw error;}
 }
 async verifyAttempt(scope:EmailScope,outboxId:string,lease:EmailOutboxLease,attemptId:string,mimeDigest:string,guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).limit(1);
  const matches=!!row&&row.state==='submitting'&&row.operation_id===lease.operation_id&&row.job_id===lease.job_id&&row.attempt_id===attemptId&&row.attempt_lock_hash===hash(lease.lock_token)&&row.mime_digest===mimeDigest;await guard(tx);signal?.throwIfAborted();return matches;});}
 async finish(scope:EmailScope,outboxId:string,lease:EmailOutboxLease,attemptId:string,state:'accepted'|'uncertain',providerMessageId:string|null,guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).for('update');if(!row||row.job_id!==lease.job_id||row.operation_id!==lease.operation_id||row.attempt_id!==attemptId||row.attempt_lock_hash!==hash(lease.lock_token))throw Error('EMAIL_OUTBOX_LEASE_DENIED');
  if(row.state===state){await guard(tx);signal?.throwIfAborted();return this.project(scope,row);}if(row.state!=='submitting')throw Error('EMAIL_OUTBOX_CONFLICT');const old=this.values(scope,row).state;
  const updated=await this.transition(tx,scope,row,state,{...old,provider_message_id:state==='accepted'?providerMessageId:null,reason:state==='uncertain'?'send_unknown':null});
  if(state==='accepted'&&this.values(scope,row).snapshot.transport.transport_kind==='smtp_raw'){
   const [account]=await tx.select({revision:emailAccounts.authority_revision}).from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
   if(!account)throw Error('EMAIL_OUTBOX_UNAVAILABLE');await tx.insert(jobQueue).values({id:randomUUID(),org_id:scope.org_id,queue:'scheduled-jobs',name:EMAIL_SENT_COPY_JOB,
    data:EmailSentCopyJobSchema.parse({...scope,outbox_id:outboxId,operation_id:row.operation_id,mime_digest:row.mime_digest,authority_revision:account.revision}),status:'pending',run_at:this.now(),max_attempts:2,
    dedupe_key:`email-sent-copy:${scope.owner_user_id}:${scope.account_id}:${outboxId}`});
  }
  await guard(tx);signal?.throwIfAborted();return this.project(scope,updated);
 });}
 private async acceptedCopy(tx:Tx,scope:EmailScope,lease:EmailSentCopyLease){
  const [job]=await tx.select().from(jobQueue).where(and(eq(jobQueue.id,lease.job_id),eq(jobQueue.org_id,scope.org_id))).limit(1);
  if(!job||job.name!==EMAIL_SENT_COPY_JOB||lease.job_name!==EMAIL_SENT_COPY_JOB||job.status!=='running'||job.lock_token!==lease.lock_token||!job.lock_expires_at||job.lock_expires_at.getTime()<=this.now().getTime())throw Error('EMAIL_SENT_COPY_LEASE_DENIED');
  const data=EmailSentCopyJobSchema.parse(job.data);if(data.org_id!==scope.org_id||data.owner_user_id!==scope.owner_user_id||data.account_id!==scope.account_id||data.operation_id!==lease.operation_id||data.outbox_id!==lease.outbox_id)throw Error('EMAIL_SENT_COPY_LEASE_DENIED');
  const [row]=await tx.select().from(emailOutbox).where(key(scope,lease.outbox_id)).limit(1);if(!row||row.state!=='accepted'||row.operation_id!==lease.operation_id||row.mime_digest!==data.mime_digest||this.values(scope,row).snapshot.transport.transport_kind!=='smtp_raw')throw Error('EMAIL_SENT_COPY_ACCEPTED_SEND_REQUIRED');return row;
 }
 async readAcceptedCopy(scope:EmailScope,lease:EmailSentCopyLease,guard:EmailOutboxGuard,signal?:AbortSignal){let bytes:Buffer|undefined;try{return await this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const row=await this.acceptedCopy(tx,scope,lease);bytes=this.binary.open({...scope,outbox_id:row.outbox_id,operation_id:row.operation_id,mime_digest:row.mime_digest},row);
  if(bytes.length!==row.byte_length||hash(bytes)!==row.mime_digest)throw Error('EMAIL_OUTBOX_UNAVAILABLE');const snapshot=this.values(scope,row).snapshot;await guard(tx);signal?.throwIfAborted();return {bytes,snapshot};
 });}catch(error){bytes?.fill(0);throw error;}}
 async verifyAcceptedCopy(scope:EmailScope,lease:EmailSentCopyLease,mimeDigest:string,guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const row=await this.acceptedCopy(tx,scope,lease);await guard(tx);signal?.throwIfAborted();return row.mime_digest===mimeDigest;});}
 async readCopyStatus(scope:EmailScope,outboxId:string,guard:EmailOutboxGuard,signal?:AbortSignal){return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).limit(1);if(!row||row.state!=='accepted'||this.values(scope,row).snapshot.transport.transport_kind!=='smtp_raw'){await guard(tx);return null;}
  const [job]=await tx.select().from(jobQueue).where(and(eq(jobQueue.org_id,scope.org_id),eq(jobQueue.dedupe_key,`email-sent-copy:${scope.owner_user_id}:${scope.account_id}:${outboxId}`))).limit(1);if(!job){await guard(tx);return null;}
  const data=EmailSentCopyJobSchema.parse(job.data);if(job.name!==EMAIL_SENT_COPY_JOB||data.org_id!==scope.org_id||data.owner_user_id!==scope.owner_user_id||data.account_id!==scope.account_id||data.outbox_id!==outboxId||data.operation_id!==row.operation_id||data.mime_digest!==row.mime_digest)throw Error('EMAIL_SENT_COPY_LEASE_DENIED');
  const [journal]=await tx.select().from(emailOperations).where(and(eq(emailOperations.org_id,scope.org_id),eq(emailOperations.owner_user_id,scope.owner_user_id),eq(emailOperations.account_id,scope.account_id),eq(emailOperations.operation_id,row.operation_id))).limit(1);
  let outcome:'pending'|'copied'|'unknown'|'failed'|'server_managed'='pending';if(journal){if(journal.kind!=='sent_copy')throw Error('EMAIL_SENT_COPY_JOURNAL_DENIED');if(journal.revision>0){const value=EmailSentCopyValueSchema.parse(this.crypto.open(journal.content_envelope,{...scope,kind:'operation',record_id:'sent-copy:'+row.operation_id,revision:journal.revision}));
   if(value.plan.operation_id!==row.operation_id||value.plan.mime_digest!==row.mime_digest||canonicalCapabilityJson(value.plan.scope)!==canonicalCapabilityJson(scope))throw Error('EMAIL_SENT_COPY_JOURNAL_DENIED');outcome=value.state==='prepared'||value.state==='started'?'pending':value.state;
   if(value.state==='started'&&['failed','completed'].includes(job.status))outcome='unknown';}}
  if(outcome==='pending'&&['failed','completed'].includes(job.status))outcome='failed';
  await guard(tx);signal?.throwIfAborted();return {outbox_id:outboxId,operation_id:row.operation_id,outcome,delivery_status:'unknown' as const};
 });}
 async reconcileCopy(scope:EmailScope,outboxId:string,guard:EmailOutboxGuard,signal?:AbortSignal){z.string().uuid().parse(outboxId);return this.database.transaction(async tx=>{
  await guard(tx);signal?.throwIfAborted();const [job]=await tx.select().from(jobQueue).where(and(eq(jobQueue.org_id,scope.org_id),eq(jobQueue.dedupe_key,`email-sent-copy:${scope.owner_user_id}:${scope.account_id}:${outboxId}`))).limit(1).for('update');
  if(!job||job.name!==EMAIL_SENT_COPY_JOB||!['completed','failed'].includes(job.status)||job.lock_token)throw Error('EMAIL_SENT_COPY_RECONCILE_CONFLICT');
  const data=EmailSentCopyJobSchema.parse(job.data),[row]=await tx.select().from(emailOutbox).where(key(scope,outboxId)).limit(1);if(!row||row.state!=='accepted'||this.values(scope,row).snapshot.transport.transport_kind!=='smtp_raw'||data.operation_id!==row.operation_id||data.mime_digest!==row.mime_digest
   ||data.org_id!==scope.org_id||data.owner_user_id!==scope.owner_user_id||data.account_id!==scope.account_id||data.outbox_id!==outboxId)throw Error('EMAIL_SENT_COPY_ACCEPTED_SEND_REQUIRED');
  const [journal]=await tx.select().from(emailOperations).where(and(eq(emailOperations.org_id,scope.org_id),eq(emailOperations.owner_user_id,scope.owner_user_id),eq(emailOperations.account_id,scope.account_id),eq(emailOperations.operation_id,row.operation_id))).limit(1).for('update');
  if(!journal||journal.kind!=='sent_copy'||journal.revision<1||journal.revision>=256||journal.lease_token&&journal.lease_until&&journal.lease_until.getTime()>this.now().getTime())throw Error('EMAIL_SENT_COPY_RECONCILE_CONFLICT');
  const value=EmailSentCopyValueSchema.parse(this.crypto.open(journal.content_envelope,{...scope,kind:'operation',record_id:'sent-copy:'+row.operation_id,revision:journal.revision}));
  if(!['started','unknown'].includes(value.state)||value.plan.operation_id!==row.operation_id||value.plan.mime_digest!==row.mime_digest||value.plan.principal_digest!==this.values(scope,row).snapshot.identity.principal_digest||canonicalCapabilityJson(value.plan.scope)!==canonicalCapabilityJson(scope))throw Error('EMAIL_SENT_COPY_RECONCILE_CONFLICT');
  const [account]=await tx.select({revision:emailAccounts.authority_revision}).from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);if(!account)throw Error('EMAIL_SENT_COPY_RECONCILE_CONFLICT');
  await tx.update(jobQueue).set({status:'pending',data:{...data,authority_revision:account.revision},attempts:0,run_at:this.now(),completed_at:null,error:null,lock_token:null,locked_by:null,lock_expires_at:null}).where(and(eq(jobQueue.id,job.id),eq(jobQueue.org_id,scope.org_id)));
  await guard(tx);signal?.throwIfAborted();return {outbox_id:outboxId,operation_id:row.operation_id,outcome:'pending' as const,delivery_status:'unknown' as const};
 });}
 async list(scope:EmailScope,limit:number,cursor:string|null,guard:EmailOutboxGuard,signal?:AbortSignal){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('EMAIL_OUTBOX_INVALID');const cctx={...scope,kind:'checkpoint' as const,record_id:'outbox-list',revision:0};
  const C=z.strictObject({created_at:z.iso.datetime(),outbox_id:z.string().uuid(),expires_at:z.number().finite()});let after:z.infer<typeof C>|undefined;
  if(cursor){if(cursor.length>8192||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw Error('EMAIL_OUTBOX_CURSOR_INVALID');try{after=C.parse(this.crypto.open(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')),cctx));if(after.expires_at<=this.now().getTime())throw Error();}catch{throw Error('EMAIL_OUTBOX_CURSOR_INVALID');}}
  return this.database.transaction(async tx=>{await guard(tx);signal?.throwIfAborted();const rows=await tx.select().from(emailOutbox).where(and(eq(emailOutbox.org_id,scope.org_id),eq(emailOutbox.owner_user_id,scope.owner_user_id),eq(emailOutbox.account_id,scope.account_id),after?or(lt(emailOutbox.created_at,new Date(after.created_at)),and(eq(emailOutbox.created_at,new Date(after.created_at)),lt(emailOutbox.outbox_id,after.outbox_id))):undefined)).orderBy(desc(emailOutbox.created_at),desc(emailOutbox.outbox_id)).limit(limit+1);
   const selected=rows.slice(0,limit),last=selected.at(-1),hasMore=rows.length>limit,next=hasMore&&last?Buffer.from(JSON.stringify(this.crypto.seal({created_at:last.created_at.toISOString(),outbox_id:last.outbox_id,expires_at:this.now().getTime()+15*60000},cctx))).toString('base64url'):null;
   await guard(tx);signal?.throwIfAborted();return {items:selected.map(row=>this.project(scope,row)),next_cursor:next,has_more:hasMore};});
 }
}
