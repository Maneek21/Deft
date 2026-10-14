import {createHash,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailOperations} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import type {db} from './db.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import type {NativeEmailTriagePlan, NativeEmailTriageValue} from './email-native-adapter-contract.js';

type ProviderScope={org_id:string;owner_id:string;installation_id:string};
type Database=Pick<typeof db,'transaction'>;
const LEASE_MS=120_000;
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);

/** Each write commits before the callback resumes. The exclusive lease protects
 * concurrent requests without holding a transaction across network operations.
 * Expired leases retain every started marker, so recovery cannot resend. */
export class PostgresEmailOperationJournal{
  constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto,
    private readonly scope:EmailScope,private readonly providerScope:ProviderScope,
    private readonly guard:(transaction:unknown)=>Promise<void>,private readonly now=Date.now){
      this.scope=Object.freeze({...scope});this.providerScope=Object.freeze({...providerScope});
    }
  private where(id:string){return and(eq(emailOperations.org_id,this.scope.org_id),eq(emailOperations.owner_user_id,this.scope.owner_user_id),eq(emailOperations.account_id,this.scope.account_id),eq(emailOperations.operation_id,id));}
  private context(id:string,revision:number){return {...this.scope,kind:'operation' as const,record_id:id,revision};}
  private location(scope:ProviderScope,id:string){
    if(!uuid(id)||scope.org_id!==this.scope.org_id||scope.owner_id!==this.scope.owner_user_id
      ||canonicalCapabilityJson(scope)!==canonicalCapabilityJson(this.providerScope))fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
  }
  private validate(value:NativeEmailTriageValue,id:string){
    if(!value||!value.plan||!Array.isArray(value.items)||value.items.length>25
      ||Buffer.byteLength(canonicalCapabilityJson(value))>65536)fail('EMAIL_TRIAGE_JOURNAL_LIMIT');
    const plan=value.plan;this.location(plan.binding.scope,id);
    if(plan.operation_id!==id||plan.binding.account.account_id!==this.scope.account_id||plan.schema_version!=='deft.email_triage_plan.v1'
      ||!Array.isArray(plan.items)||plan.items.length!==value.items.length||!plan.items.length
      ||Buffer.byteLength(canonicalCapabilityJson(plan))>24576)fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
    const {digest,...unsigned}=plan;
    if(createHash('sha256').update(canonicalCapabilityJson(unsigned)).digest('hex')!==digest)fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
    if(new Set(value.items.map(item=>item.logical_id)).size!==value.items.length||value.items.some((item,index)=>item.logical_id!==plan.items[index]?.logical_id
      ||!['prepared','started','succeeded','failed','unknown'].includes(item.state)))fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
    return value;
  }
  private open(row:typeof emailOperations.$inferSelect):NativeEmailTriageValue|null{
    if(row.kind!=='triage')fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
    if(row.revision===0&&row.content_envelope===null)return null;
    return this.validate(this.cipher.open(row.content_envelope,this.context(row.operation_id,row.revision)) as unknown as NativeEmailTriageValue,row.operation_id);
  }
  async load(scope:ProviderScope,id:string):Promise<NativeEmailTriageValue|null>{
    this.location(scope,id);
    return this.database.transaction(async tx=>{
      await this.guard(tx);const [row]=await tx.select().from(emailOperations).where(this.where(id)).limit(1);
      const value=row?this.open(row):null;await this.guard(tx);return value;
    });
  }
  async create(plan:NativeEmailTriagePlan):Promise<NativeEmailTriageValue>{
    return this.change(plan.binding.scope,plan.operation_id,async(prior,write)=>{
      if(prior){if(prior.plan.digest!==plan.digest)fail('EMAIL_TRIAGE_OPERATION_CONFLICT');return prior;}
      const value:NativeEmailTriageValue={plan,items:plan.items.map(item=>({logical_id:item.logical_id,state:'prepared'}))};
      await write(value);return structuredClone(value);
    });
  }
  async change<T>(scope:ProviderScope,id:string,callback:(value:NativeEmailTriageValue|null,write:(next:NativeEmailTriageValue)=>Promise<void>)=>Promise<T>|T):Promise<T>{
    this.location(scope,id);const token=randomUUID();
    const row=await this.database.transaction(async tx=>{
      await this.guard(tx);const time=this.now();if(!Number.isFinite(time))fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
      await tx.insert(emailOperations).values({...this.scope,operation_id:id,kind:'triage'}).onConflictDoNothing();
      const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');
      if(!current||current.kind!=='triage')fail('EMAIL_TRIAGE_JOURNAL_UNAVAILABLE');
      if(current.lease_token&&current.lease_until&&current.lease_until.getTime()>time)fail('EMAIL_TRIAGE_BUSY');
      await tx.update(emailOperations).set({lease_token:token,lease_until:new Date(time+LEASE_MS),updated_at:new Date(time)}).where(this.where(id));
      await this.guard(tx);return current;
    });
    let revision=row.revision,previous=this.open(row);
    try{
      return await callback(structuredClone(previous),async next=>{
        this.validate(next,id);
        if(previous){
          if(previous.plan.digest!==next.plan.digest)fail('EMAIL_TRIAGE_OPERATION_CONFLICT');
          const transitions:Record<string,readonly string[]>={prepared:['prepared','started','failed'],started:['started','succeeded','failed','unknown'],succeeded:['succeeded'],failed:['failed'],unknown:['unknown']};
          for(let index=0;index<previous.items.length;index++){
            const before=previous.items[index]!,after=next.items[index]!;
            if(!transitions[before.state]?.includes(after.state)||['succeeded','failed','unknown'].includes(before.state)&&canonicalCapabilityJson(before)!==canonicalCapabilityJson(after))fail('EMAIL_TRIAGE_OPERATION_CONFLICT');
          }
        }else if(next.items.some(item=>item.state!=='prepared'))fail('EMAIL_TRIAGE_OPERATION_CONFLICT');
        const nextRevision=revision+1;if(nextRevision>2147483647)fail('EMAIL_TRIAGE_JOURNAL_LIMIT');
        const envelope=this.cipher.seal(next,this.context(id,nextRevision));
        await this.database.transaction(async tx=>{
          await this.guard(tx);const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');
          const time=this.now();
          if(!current||current.revision!==revision||current.lease_token!==token||!current.lease_until||current.lease_until.getTime()<=time)fail('EMAIL_TRIAGE_JOURNAL_CONFLICT');
          await tx.update(emailOperations).set({revision:nextRevision,content_envelope:envelope,lease_until:new Date(time+LEASE_MS),updated_at:new Date(time)}).where(this.where(id));
          await this.guard(tx);
        });
        revision=nextRevision;previous=structuredClone(next);
      });
    }finally{
      // A failed cleanup leaves only a bounded lease. It never rewinds content.
      await this.database.transaction(async tx=>{await tx.update(emailOperations).set({lease_token:null,lease_until:null})
        .where(and(this.where(id),eq(emailOperations.lease_token,token)));}).catch(()=>{});
    }
  }
}
