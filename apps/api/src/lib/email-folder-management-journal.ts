import {randomUUID} from 'node:crypto';
import {and,eq,desc} from 'drizzle-orm';
import {emailOperations} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import type {db} from './db.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';
import {EmailFolderManageValueSchema,emailFolderManageDigest,EmailFolderManageError,type EmailFolderManageJournal,type EmailFolderManageValue} from './email-folder-management-contract.js';
const same=(a:unknown,b:unknown)=>canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
/** Separate domain discriminator/envelope. No historical journal reader changes.
 * Every marker commits before I/O; expiry never replays a started effect. */
export class PostgresEmailFolderManagementJournal implements EmailFolderManageJournal{
 constructor(private readonly database:Pick<typeof db,'transaction'>,private readonly cipher:EmailMailboxCrypto,private readonly scope:EmailScope,private readonly guard:(transaction:unknown)=>Promise<void>,private readonly now=Date.now){this.scope=Object.freeze({...scope});}
 private where(id:string){return and(eq(emailOperations.org_id,this.scope.org_id),eq(emailOperations.owner_user_id,this.scope.owner_user_id),eq(emailOperations.account_id,this.scope.account_id),eq(emailOperations.operation_id,id));}
 private context(id:string,revision:number){return {...this.scope,kind:'operation' as const,record_id:'folder-manage:'+id,revision};}
 private location(id:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');}
 private validate(raw:unknown,id:string){if(Buffer.byteLength(canonicalCapabilityJson(raw))>16384)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');const value=EmailFolderManageValueSchema.parse(raw),{digest,...unsigned}=value.plan;
  if(value.plan.operation_id!==id||!same(value.plan.scope,this.scope)||emailFolderManageDigest(unsigned)!==digest)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');return value;}
 private open(row:typeof emailOperations.$inferSelect){if(row.kind!=='folder_manage')throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');return row.revision===0&&row.content_envelope===null?null:this.validate(this.cipher.open(row.content_envelope,this.context(row.operation_id,row.revision)),row.operation_id);}
 async load(id:string){this.location(id);return this.database.transaction(async tx=>{await this.guard(tx);const [row]=await tx.select().from(emailOperations).where(this.where(id)).limit(1);const value=row?this.open(row):null;await this.guard(tx);return value;});}
 async recent(){return this.database.transaction(async tx=>{await this.guard(tx);const rows=await tx.select().from(emailOperations).where(and(eq(emailOperations.org_id,this.scope.org_id),eq(emailOperations.owner_user_id,this.scope.owner_user_id),eq(emailOperations.account_id,this.scope.account_id),eq(emailOperations.kind,'folder_manage'))).orderBy(desc(emailOperations.created_at),desc(emailOperations.operation_id)).limit(20);
  const items=rows.flatMap(row=>{const value=this.open(row);return value?[{created_at:row.created_at.toISOString(),value}]:[];});await this.guard(tx);return items;});}
 async change<T>(id:string,work:(value:EmailFolderManageValue|null,write:(next:EmailFolderManageValue)=>Promise<void>)=>Promise<T>){
  this.location(id);const lease=randomUUID(),row=await this.database.transaction(async tx=>{await this.guard(tx);const time=this.now();if(!Number.isFinite(time))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');
   await tx.insert(emailOperations).values({...this.scope,operation_id:id,kind:'folder_manage'}).onConflictDoNothing();const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');
   if(!current||current.kind!=='folder_manage')throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');if(current.lease_token&&current.lease_until&&current.lease_until.getTime()>time)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_BUSY');
   await tx.update(emailOperations).set({lease_token:lease,lease_until:new Date(time+120000),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);return current;});
  let revision=row.revision,previous:EmailFolderManageValue|null;
  try{previous=this.open(row);return await work(structuredClone(previous),async raw=>{const next=this.validate(raw,id);if(previous){
    const transitions:Record<string,readonly string[]>={prepared:['started','failed'],started:['succeeded','failed','unknown'],succeeded:[],failed:[],unknown:[]};
    if(!same(previous.plan,next.plan)||!transitions[previous.state]?.includes(next.state))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');
   }else if(next.state!=='prepared')throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');
   const nextRevision=revision+1;if(nextRevision>2147483647)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');const envelope=this.cipher.seal(next,this.context(id,nextRevision));
   await this.database.transaction(async tx=>{await this.guard(tx);const [current]=await tx.select().from(emailOperations).where(this.where(id)).limit(1).for('update');const time=this.now();
    if(!current||current.revision!==revision||current.lease_token!==lease||!current.lease_until||current.lease_until.getTime()<=time)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');
    await tx.update(emailOperations).set({revision:nextRevision,content_envelope:envelope,lease_until:new Date(time+120000),updated_at:new Date(time)}).where(this.where(id));await this.guard(tx);});revision=nextRevision;previous=structuredClone(next);
  });}finally{await this.database.transaction(async tx=>{await tx.update(emailOperations).set({lease_token:null,lease_until:null}).where(and(this.where(id),eq(emailOperations.lease_token,lease)));}).catch(()=>{});}
 }
}
