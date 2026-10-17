import {createHash,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailOperations} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import type {db} from './db.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import {EmailSentCopyPlanSchema,EmailSentCopyValueSchema,type EmailSentCopyPlan,type EmailSentCopyValue,type EmailSentCopyJournal} from './email-sent-copy-contract.js';
const same=(a:unknown,b:unknown)=>canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
function fail(code:string):never{throw Error(code);}
/** Short guarded SQL commits surround, but never hold locks during, IMAP I/O.
 * Expiry releases only the execution lease; a started APPEND never resets. */
export class PostgresEmailSentCopyJournal implements EmailSentCopyJournal{
 constructor(private readonly database:Pick<typeof db,'transaction'>,private readonly cipher:EmailMailboxCrypto,private readonly scope:EmailScope,
  private readonly guard:(tx:unknown)=>Promise<void>,private readonly now=Date.now){this.scope=Object.freeze({...scope});}
 private location(scope:EmailScope,id:string){if(!same(scope,this.scope)||!z.string().uuid().safeParse(id).success)fail('EMAIL_SENT_COPY_JOURNAL_DENIED');}
 private where(id:string){return and(eq(emailOperations.org_id,this.scope.org_id),eq(emailOperations.owner_user_id,this.scope.owner_user_id),eq(emailOperations.account_id,this.scope.account_id),eq(emailOperations.operation_id,id));}
 private context(id:string,revision:number){return {...this.scope,kind:'operation' as const,record_id:'sent-copy:'+id,revision};}
 private validate(raw:unknown,id:string){if(Buffer.byteLength(canonicalCapabilityJson(raw))>16384)fail('EMAIL_SENT_COPY_JOURNAL_LIMIT');const value=EmailSentCopyValueSchema.parse(raw);this.location(value.plan.scope,id);
  const {digest,...unsigned}=value.plan;if(value.plan.operation_id!==id||createHash('sha256').update(canonicalCapabilityJson(unsigned)).digest('hex')!==digest)fail('EMAIL_SENT_COPY_PLAN_CONFLICT');return value;}
 private open(row:typeof emailOperations.$inferSelect){if(row.kind!=='sent_copy')fail('EMAIL_SENT_COPY_JOURNAL_DENIED');return row.revision===0&&row.content_envelope===null?null:this.validate(this.cipher.open(row.content_envelope,this.context(row.operation_id,row.revision)),row.operation_id);}
 async load(scope:EmailScope,id:string){this.location(scope,id);return this.database.transaction(async tx=>{await this.guard(tx);const [row]=await tx.select().from(emailOperations).where(this.where(id)).limit(1);const value=row?this.open(row):null;await this.guard(tx);return value;});}
 async create(raw:EmailSentCopyPlan){const plan=EmailSentCopyPlanSchema.parse(raw);return this.change(plan.scope,plan.operation_id,async(prior,write)=>{
  if(prior){if(!same(prior.plan,plan))fail('EMAIL_SENT_COPY_PLAN_CONFLICT');return prior;}const value:EmailSentCopyValue={plan,state:plan.mode==='server_managed'?'server_managed':'prepared'};await write(value);return value;});}
 async change<T>(scope:EmailScope,id:string,work:(value:EmailSentCopyValue|null,write:(next:EmailSentCopyValue)=>Promise<void>)=>Promise<T>|T):Promise<T>{
  this.location(scope,id);const token=randomUUID();const row=await this.database.transaction(async tx=>{
   await this.guard(tx);const time=this.now();if(!Number.isFinite(time))fail('EMAIL_SENT_COPY_JOURNAL_DENIED');await tx.insert(emailOperations).values({...this.scope,operation_id:id,kind:'sent_copy'}).onConflictDoNothing();
   const [row]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');if(!row||row.kind!=='sent_copy')fail('EMAIL_SENT_COPY_JOURNAL_DENIED');
   if(row.lease_token&&row.lease_until&&row.lease_until.getTime()>time)fail('EMAIL_SENT_COPY_BUSY');await tx.update(emailOperations).set({lease_token:token,lease_until:new Date(time+120000),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);return row;
  });let previous:EmailSentCopyValue|null,revision=row.revision;
  try{previous=this.open(row);return await work(structuredClone(previous),async raw=>{
   const next=this.validate(raw,id);if(previous){if(!same(previous.plan,next.plan))fail('EMAIL_SENT_COPY_PLAN_CONFLICT');
    const transitions:Record<string,readonly string[]>={prepared:['prepared','started','failed'],started:['started','copied','unknown'],unknown:['unknown','copied'],copied:['copied'],failed:['failed'],server_managed:['server_managed']};
    if(!transitions[previous.state]?.includes(next.state)||['copied','failed','server_managed'].includes(previous.state)&&!same(previous,next))fail('EMAIL_SENT_COPY_STATE_CONFLICT');
    if(previous.scan&&(!next.scan||next.scan.next_uid<previous.scan.next_uid||next.scan.end_uid<previous.scan.end_uid||previous.scan.matches.some(uid=>!next.scan!.matches.includes(uid))))fail('EMAIL_SENT_COPY_STATE_CONFLICT');
   }else if(next.state!==(next.plan.mode==='server_managed'?'server_managed':'prepared')||next.scan||next.copied_uid!==undefined)fail('EMAIL_SENT_COPY_STATE_CONFLICT');
   if(revision>=256)fail('EMAIL_SENT_COPY_JOURNAL_LIMIT');const nextRevision=revision+1,envelope=this.cipher.seal(next,this.context(id,nextRevision));
   await this.database.transaction(async tx=>{await this.guard(tx);const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');const time=this.now();
    if(!current||current.kind!=='sent_copy'||current.revision!==revision||current.lease_token!==token||!current.lease_until||current.lease_until.getTime()<=time)fail('EMAIL_SENT_COPY_JOURNAL_CONFLICT');
    await tx.update(emailOperations).set({revision:nextRevision,content_envelope:envelope,lease_until:new Date(time+120000),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);
   });revision=nextRevision;previous=structuredClone(next);
  });}finally{await this.database.transaction(async tx=>{await tx.update(emailOperations).set({lease_token:null,lease_until:null}).where(and(this.where(id),eq(emailOperations.lease_token,token)));}).catch(()=>{});}
 }
}
