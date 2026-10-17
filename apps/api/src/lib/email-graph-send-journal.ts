import {createHash,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailOperations} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import type {db} from './db.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import {EmailGraphSendPlanSchema,EmailGraphSendValueSchema,type EmailGraphSendPlan,type EmailGraphSendValue,type EmailGraphSendJournal} from './email-graph-send-contract.js';
type Database=Pick<typeof db,'transaction'>;
const LEASE_MS=120000;
const same=(a:unknown,b:unknown)=>canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
/** Domain journal uses the existing encrypted scoped operation storage. Each
 * write commits before provider I/O; lease expiry never rewinds started work. */
export class PostgresEmailGraphSendJournal implements EmailGraphSendJournal{
 constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto,private readonly scope:EmailScope,private readonly guard:(transaction:unknown)=>Promise<void>,private readonly now=Date.now){this.scope=Object.freeze({...scope});}
 private location(scope:EmailScope,id:string){if(!same(scope,this.scope)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id))fail('EMAIL_GRAPH_SEND_JOURNAL_DENIED');}
 private where(id:string){return and(eq(emailOperations.org_id,this.scope.org_id),eq(emailOperations.owner_user_id,this.scope.owner_user_id),eq(emailOperations.account_id,this.scope.account_id),eq(emailOperations.operation_id,id));}
 private context(id:string,revision:number){return {...this.scope,kind:'operation' as const,record_id:'graph-send:'+id,revision};}
 private validate(raw:unknown,id:string):EmailGraphSendValue{
  if(Buffer.byteLength(canonicalCapabilityJson(raw))>131072)fail('EMAIL_GRAPH_SEND_JOURNAL_LIMIT');const value=EmailGraphSendValueSchema.parse(raw);this.location(value.plan.scope,id);
  if(value.plan.operation_id!==id||Buffer.byteLength(canonicalCapabilityJson(value.plan))>24576)fail('EMAIL_GRAPH_SEND_JOURNAL_DENIED');
  const {digest,...unsigned}=value.plan;if(createHash('sha256').update(canonicalCapabilityJson(unsigned)).digest('hex')!==digest)fail('EMAIL_GRAPH_SEND_PLAN_CONFLICT');return value;
 }
 private open(row:typeof emailOperations.$inferSelect):EmailGraphSendValue|null{
  if(row.kind!=='send_upload')fail('EMAIL_GRAPH_SEND_JOURNAL_DENIED');if(row.revision===0&&row.content_envelope===null)return null;
  return this.validate(this.cipher.open(row.content_envelope,this.context(row.operation_id,row.revision)),row.operation_id);
 }
 async load(scope:EmailScope,id:string):Promise<EmailGraphSendValue|null>{
  this.location(scope,id);return this.database.transaction(async tx=>{await this.guard(tx);const [row]=await tx.select().from(emailOperations).where(this.where(id)).limit(1);const value=row?this.open(row):null;await this.guard(tx);return value;});
 }
 async create(raw:EmailGraphSendPlan):Promise<EmailGraphSendValue>{
  const plan=EmailGraphSendPlanSchema.parse(raw);return this.change(plan.scope,plan.operation_id,async(prior,write)=>{if(prior){if(!same(prior.plan,plan))fail('EMAIL_GRAPH_SEND_PLAN_CONFLICT');return prior;}
   const next:EmailGraphSendValue={plan,prepare_attempts:0,create:{state:'prepared'},files:plan.files.map(file=>({index:file.index,state:'prepared',offset:0})),send:{state:'prepared'}};await write(next);return structuredClone(next);});
 }
 async change<T>(scope:EmailScope,id:string,callback:(value:EmailGraphSendValue|null,write:(next:EmailGraphSendValue)=>Promise<void>)=>Promise<T>|T):Promise<T>{
  this.location(scope,id);const token=randomUUID();
  const row=await this.database.transaction(async tx=>{
   await this.guard(tx);const time=this.now();if(!Number.isFinite(time))fail('EMAIL_GRAPH_SEND_JOURNAL_DENIED');
   await tx.insert(emailOperations).values({...this.scope,operation_id:id,kind:'send_upload'}).onConflictDoNothing();
   const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');if(!current||current.kind!=='send_upload')fail('EMAIL_GRAPH_SEND_JOURNAL_DENIED');
   if(current.lease_token&&current.lease_until&&current.lease_until.getTime()>time)fail('EMAIL_GRAPH_SEND_BUSY');
   await tx.update(emailOperations).set({lease_token:token,lease_until:new Date(time+LEASE_MS),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);return current;
  });
  let revision=row.revision,previous:EmailGraphSendValue|null;
  try{previous=this.open(row);return await callback(structuredClone(previous),async raw=>{
   const next=this.validate(raw,id);
   if(previous){
    if(!same(previous.plan,next.plan))fail('EMAIL_GRAPH_SEND_PLAN_CONFLICT');
    if(next.prepare_attempts<previous.prepare_attempts||next.prepare_attempts>previous.prepare_attempts+1)fail('EMAIL_GRAPH_SEND_STATE_CONFLICT');
    const phases:Record<string,readonly string[]>={prepared:['prepared','started','conflict'],started:['started','applied','unknown','conflict'],unknown:['unknown','applied','conflict'],applied:['applied'],conflict:['conflict']};
    if(!phases[previous.create.state]?.includes(next.create.state)||previous.create.ref&&previous.create.ref!==next.create.ref||['applied','conflict'].includes(previous.create.state)&&!same(previous.create,next.create))fail('EMAIL_GRAPH_SEND_STATE_CONFLICT');
    const files:Record<string,readonly string[]>={prepared:['prepared','session_started','uploading','applied','unknown','conflict'],session_started:['session_started','uploading','unknown','conflict'],uploading:['uploading','applied','unknown','conflict'],unknown:['unknown','uploading','applied','conflict'],applied:['applied'],conflict:['conflict']};
    for(let i=0;i<previous.files.length;i++){const before=previous.files[i]!,after=next.files[i]!;if(!files[before.state]?.includes(after.state)||after.offset<before.offset||['applied','conflict'].includes(before.state)&&!same(before,after)||before.upload_url&&after.upload_url!==before.upload_url)fail('EMAIL_GRAPH_SEND_STATE_CONFLICT');}
    const sends:Record<string,readonly string[]>={prepared:['prepared','started'],started:['started','accepted','unknown'],accepted:['accepted'],unknown:['unknown','accepted']};
    if(!sends[previous.send.state]?.includes(next.send.state))fail('EMAIL_GRAPH_SEND_STATE_CONFLICT');
   }else if(next.create.state!=='prepared'||next.send.state!=='prepared'||next.files.some(file=>file.state!=='prepared'||file.offset!==0))fail('EMAIL_GRAPH_SEND_STATE_CONFLICT');
   const nextRevision=revision+1;if(nextRevision>2147483647)fail('EMAIL_GRAPH_SEND_JOURNAL_LIMIT');const envelope=this.cipher.seal(next,this.context(id,nextRevision));
   await this.database.transaction(async tx=>{
    await this.guard(tx);const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');const time=this.now();
    if(!current||current.kind!=='send_upload'||current.revision!==revision||current.lease_token!==token||!current.lease_until||current.lease_until.getTime()<=time)fail('EMAIL_GRAPH_SEND_JOURNAL_CONFLICT');
    await tx.update(emailOperations).set({revision:nextRevision,content_envelope:envelope,lease_until:new Date(time+LEASE_MS),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);
   });revision=nextRevision;previous=structuredClone(next);
  });}finally{
   await this.database.transaction(async tx=>{await tx.update(emailOperations).set({lease_token:null,lease_until:null}).where(and(this.where(id),eq(emailOperations.lease_token,token)));}).catch(()=>{});
  }
 }
}
