import {and,desc,eq,gt,inArray,lte,sql} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {z} from 'zod';
import {canonicalCapabilityJson} from '@deft/shared';
import {emailPresentationCache} from '@deft/db/schema';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {NativeEmailPresentationSchema, type NativeEmailPresentation} from './email-native-adapter-contract.js';
import type {EmailScope} from './email-mailbox-service.js';
import type {EmailPresentationCache} from './email-message-content.js';

const schema={emailPresentationCache};
type Database=Pick<NodePgDatabase<typeof schema>,'transaction'>;
const keySchema=z.string().regex(/^[a-f0-9]{64}$/u);
const scoped=(scope:EmailScope,key?:string)=>and(eq(emailPresentationCache.org_id,scope.org_id),
 eq(emailPresentationCache.owner_user_id,scope.owner_user_id),eq(emailPresentationCache.account_id,scope.account_id),
 key===undefined?undefined:eq(emailPresentationCache.cache_key,key));
const context=(scope:EmailScope,key:string)=>({...scope,kind:'presentation_cache' as const,record_id:key,revision:1});
const MAX_BYTES=480*1024,TTL_MS=300_000;

/** The guard is SQL-only. Human connected authority is checked by the content
 * service before/after every hit; no cached object bypasses that service. */
export class PostgresEmailPresentationCache implements EmailPresentationCache{
 constructor(private readonly database:Database,private readonly crypto:EmailMailboxCrypto,
  private readonly guard:(scope:EmailScope,transaction:unknown,signal?:AbortSignal)=>Promise<void>,
  private readonly now=Date.now,private readonly capacity=64){
  if(!Number.isSafeInteger(capacity)||capacity<1||capacity>64)throw new TypeError('Invalid reader cache capacity');
 }
 async read(scope:EmailScope,key:string,signal?:AbortSignal):Promise<NativeEmailPresentation|null>{
  keySchema.parse(key);signal?.throwIfAborted();
  return this.database.transaction(async tx=>{
   await this.guard(scope,tx,signal);
   const [row]=await tx.select().from(emailPresentationCache).where(and(scoped(scope,key),gt(emailPresentationCache.expires_at,new Date(this.now())))).limit(1);
   if(!row)return null;
   const value=NativeEmailPresentationSchema.parse(this.crypto.open(row.content_envelope,context(scope,key)));
   if(value.account_id!==scope.account_id||Buffer.byteLength(canonicalCapabilityJson(value))!==row.byte_length)throw new Error('EMAIL_SOURCE_UNAVAILABLE');
   await this.guard(scope,tx,signal);signal?.throwIfAborted();
   return row.expires_at.getTime()>this.now()?value:null;
  });
 }
 async write(scope:EmailScope,key:string,raw:NativeEmailPresentation,signal?:AbortSignal):Promise<void>{
  keySchema.parse(key);signal?.throwIfAborted();const value=NativeEmailPresentationSchema.parse(raw);
  if(value.account_id!==scope.account_id)throw new Error('EMAIL_ACCESS_DENIED');
  const bytes=Buffer.byteLength(canonicalCapabilityJson(value));if(bytes>MAX_BYTES)return;
  const envelope=this.crypto.seal(value,context(scope,key));
  await this.database.transaction(async tx=>{
   await this.guard(scope,tx,signal);
   // Serialize only bounded cache writes. No session/custody lock is acquired
   // after this lock; the same SQL authority lock order is retained.
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['email-presentation-cache',scope.org_id,scope.owner_user_id,scope.account_id])},0))`);
   const now=new Date(this.now());
   await tx.delete(emailPresentationCache).where(and(scoped(scope),lte(emailPresentationCache.expires_at,now)));
   await tx.insert(emailPresentationCache).values({...scope,cache_key:key,revision:1,content_envelope:envelope,byte_length:bytes,
    created_at:now,updated_at:now,expires_at:new Date(now.getTime()+TTL_MS)})
    .onConflictDoUpdate({target:[emailPresentationCache.org_id,emailPresentationCache.owner_user_id,emailPresentationCache.account_id,emailPresentationCache.cache_key],
     set:{content_envelope:envelope,byte_length:bytes,created_at:now,updated_at:now,expires_at:new Date(now.getTime()+TTL_MS)}});
   const evicted=await tx.select({key:emailPresentationCache.cache_key}).from(emailPresentationCache).where(scoped(scope))
    .orderBy(desc(emailPresentationCache.updated_at),desc(emailPresentationCache.cache_key)).offset(this.capacity);
   if(evicted.length)await tx.delete(emailPresentationCache).where(and(scoped(scope),inArray(emailPresentationCache.cache_key,evicted.map(row=>row.key))));
   await this.guard(scope,tx,signal);signal?.throwIfAborted();
  });
 }
}
