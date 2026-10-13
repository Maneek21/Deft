import {createHash,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailOperations} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import type {db} from './db.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import {NativeEmailDraftSyncPlanSchema,NativeEmailDraftSyncValueSchema,type NativeEmailDraftSyncPlan,type NativeEmailDraftSyncValue,type NativeEmailDraftSyncJournal} from './email-draft-sync-contract.js';
type Database=Pick<typeof db,'transaction'>;
const LEASE_MS=120000;
const same=(a:unknown,b:unknown)=>canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
/** Domain journal uses the existing encrypted scoped operation storage. Each
 * write commits before provider I/O; lease expiry never rewinds started work. */
export class PostgresEmailDraftSyncJournal implements NativeEmailDraftSyncJournal{
 constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto,private readonly scope:EmailScope,private readonly guard:(transaction:unknown)=>Promise<void>,private readonly now=Date.now){this.scope=Object.freeze({...scope});}
 private location(scope:EmailScope,id:string){if(!same(scope,this.scope)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id))fail('EMAIL_DRAFT_SYNC_JOURNAL_DENIED');}
 private where(id:string){return and(eq(emailOperations.org_id,this.scope.org_id),eq(emailOperations.owner_user_id,this.scope.owner_user_id),eq(emailOperations.account_id,this.scope.account_id),eq(emailOperations.operation_id,id));}
 private context(id:string,revision:number){return {...this.scope,kind:'operation' as const,record_id:'draft-sync:'+id,revision};}
 private validate(raw:unknown,id:string):NativeEmailDraftSyncValue{
  if(Buffer.byteLength(canonicalCapabilityJson(raw))>65536)fail('EMAIL_DRAFT_SYNC_JOURNAL_LIMIT');const value=NativeEmailDraftSyncValueSchema.parse(raw);this.location(value.plan.scope,id);
  if(value.plan.operation_id!==id||Buffer.byteLength(canonicalCapabilityJson(value.plan))>24576)fail('EMAIL_DRAFT_SYNC_JOURNAL_DENIED');
  const {digest,...unsigned}=value.plan;if(createHash('sha256').update(canonicalCapabilityJson(unsigned)).digest('hex')!==digest)fail('EMAIL_DRAFT_SYNC_PLAN_CONFLICT');return value;
 }
 private open(row:typeof emailOperations.$inferSelect):NativeEmailDraftSyncValue|null{
  if(row.kind!=='draft_sync')fail('EMAIL_DRAFT_SYNC_JOURNAL_DENIED');if(row.revision===0&&row.content_envelope===null)return null;
  return this.validate(this.cipher.open(row.content_envelope,this.context(row.operation_id,row.revision)),row.operation_id);
 }
 async load(scope:EmailScope,id:string):Promise<NativeEmailDraftSyncValue|null>{
  this.location(scope,id);return this.database.transaction(async tx=>{await this.guard(tx);const [row]=await tx.select().from(emailOperations).where(this.where(id)).limit(1);const value=row?this.open(row):null;await this.guard(tx);return value;});
 }
 async create(raw:NativeEmailDraftSyncPlan):Promise<NativeEmailDraftSyncValue>{
  const plan=NativeEmailDraftSyncPlanSchema.parse(raw);return this.change(plan.scope,plan.operation_id,async(prior,write)=>{if(prior){if(!same(prior.plan,plan))fail('EMAIL_DRAFT_SYNC_PLAN_CONFLICT');return prior;}
   const next={plan,steps:plan.steps.map(step=>({step_id:step.step_id,state:'prepared' as const}))};await write(next);return structuredClone(next);});
 }
 async change<T>(scope:EmailScope,id:string,callback:(value:NativeEmailDraftSyncValue|null,write:(next:NativeEmailDraftSyncValue)=>Promise<void>)=>Promise<T>|T):Promise<T>{
  this.location(scope,id);const token=randomUUID();
  const row=await this.database.transaction(async tx=>{
   await this.guard(tx);const time=this.now();if(!Number.isFinite(time))fail('EMAIL_DRAFT_SYNC_JOURNAL_DENIED');
   await tx.insert(emailOperations).values({...this.scope,operation_id:id,kind:'draft_sync'}).onConflictDoNothing();
   const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');if(!current||current.kind!=='draft_sync')fail('EMAIL_DRAFT_SYNC_JOURNAL_DENIED');
   if(current.lease_token&&current.lease_until&&current.lease_until.getTime()>time)fail('EMAIL_DRAFT_SYNC_BUSY');
   await tx.update(emailOperations).set({lease_token:token,lease_until:new Date(time+LEASE_MS),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);return current;
  });
  let revision=row.revision,previous:NativeEmailDraftSyncValue|null;
  try{previous=this.open(row);return await callback(structuredClone(previous),async raw=>{
   const next=this.validate(raw,id);
   if(previous){
    if(!same(previous.plan,next.plan))fail('EMAIL_DRAFT_SYNC_PLAN_CONFLICT');
    const transitions:Record<string,readonly string[]>={prepared:['prepared','started','conflict'],started:['started','applied','unknown','conflict'],unknown:['unknown','applied','conflict'],applied:['applied'],conflict:['conflict']};
    for(let index=0;index<previous.steps.length;index++){const before=previous.steps[index]!,after=next.steps[index]!;if(!transitions[before.state]?.includes(after.state)||['applied','conflict'].includes(before.state)&&!same(before,after))fail('EMAIL_DRAFT_SYNC_STATE_CONFLICT');}
   }else if(next.steps.some(step=>step.state!=='prepared'))fail('EMAIL_DRAFT_SYNC_STATE_CONFLICT');
   const nextRevision=revision+1;if(nextRevision>2147483647)fail('EMAIL_DRAFT_SYNC_JOURNAL_LIMIT');const envelope=this.cipher.seal(next,this.context(id,nextRevision));
   await this.database.transaction(async tx=>{
    await this.guard(tx);const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');const time=this.now();
    if(!current||current.kind!=='draft_sync'||current.revision!==revision||current.lease_token!==token||!current.lease_until||current.lease_until.getTime()<=time)fail('EMAIL_DRAFT_SYNC_JOURNAL_CONFLICT');
    await tx.update(emailOperations).set({revision:nextRevision,content_envelope:envelope,lease_until:new Date(time+LEASE_MS),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);
   });revision=nextRevision;previous=structuredClone(next);
  });}finally{
   await this.database.transaction(async tx=>{await tx.update(emailOperations).set({lease_token:null,lease_until:null}).where(and(this.where(id),eq(emailOperations.lease_token,token)));}).catch(()=>{});
  }
 }
}
