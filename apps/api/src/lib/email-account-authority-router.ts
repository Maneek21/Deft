import {and,eq} from 'drizzle-orm';
import {assertNativeAccountAvailable} from './email-native-adoption-gate.js';
import {emailAccountConsents} from '@deft/db/schema';
import {PostgresEmailMailboxAuthority,type EmailAuthorityDatabase,type EmailServiceLease} from './email-mailbox-authority.js';
import {PostgresEmailAccountAuthority} from './email-account-authority.js';
import {PostgresEmailAccountConsentStore,type EmailAccountConsentTransaction} from './email-account-consent-store.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailMailboxError,type EmailOperationActor,type EmailScope,type EmailOperation,type EmailAuthority} from './email-mailbox-service.js';
import {PostgresEmailAgentAuthority} from './email-agent-authority.js';
export class EmailAccountAuthorityRouter implements EmailAuthority{
 private readonly modes=new WeakMap<object,Map<string,boolean>>();
 constructor(private readonly database:EmailAuthorityDatabase,private readonly legacy:PostgresEmailMailboxAuthority,private readonly standalone:PostgresEmailAccountAuthority,private readonly agents?:PostgresEmailAgentAuthority){}
 private async run<T>(scope:EmailScope,transaction:unknown,work:(native:boolean,tx:EmailAccountConsentTransaction)=>Promise<T>){
  const select=async(tx:EmailAccountConsentTransaction)=>{await assertNativeAccountAvailable(tx,scope);const [row]=await tx.select({account_id:emailAccountConsents.account_id}).from(emailAccountConsents)
   .where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,scope.account_id))).limit(1);
   const native=Boolean(row),key=JSON.stringify([scope.org_id,scope.owner_user_id,scope.account_id]),held=this.modes.get(tx)??new Map();
   if(held.has(key)&&held.get(key)!==native)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');held.set(key,native);this.modes.set(tx,held);
   const result=await work(native,tx);
   // A legacy call may have observed no consent before waiting for the account
   // lock held by adoption. Re-read after that wait; never return legacy effect
   // rights for an account that has meanwhile narrowed its owner consent.
   if(!native){const [after]=await tx.select({account_id:emailAccountConsents.account_id}).from(emailAccountConsents).where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,scope.account_id))).limit(1);
    if(after)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');}
   // Native consent deletion is forbidden by the durable retention trigger;
   // all subsequent state/capability changes are checked by native authority.
   return result;
  };return transaction!==undefined?select(transaction as EmailAccountConsentTransaction):this.database.transaction(select);
 }
 current(actor:EmailOperationActor,scope:EmailScope,operation:EmailOperation,transaction?:unknown,signal?:AbortSignal){
  if('agent_grant_id' in actor){if(!this.agents)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return this.run(scope,transaction,(_native,tx)=>this.agents!.current(actor,scope,operation,tx,signal));}
  signal?.throwIfAborted();return this.run(scope,transaction,(native,tx)=>(native?this.standalone:this.legacy).current(actor,scope,operation,tx,signal));
 }
 currentService(scope:EmailScope,lease:EmailServiceLease,transaction?:unknown,signal?:AbortSignal){
  signal?.throwIfAborted();return this.run(scope,transaction,(native,tx)=>(native?this.standalone:this.legacy).currentService(scope,lease,tx,signal));
 }
}
export async function getEmailMailboxAuthority(database:EmailAuthorityDatabase){
 const {keys}=await(await import('./app-run-runtime.js')).getAppRunRuntime(),cipher=new EmailMailboxCrypto(keys),store=new PostgresEmailAccountConsentStore(database,cipher);
 return new EmailAccountAuthorityRouter(database,new PostgresEmailMailboxAuthority(database),new PostgresEmailAccountAuthority(database,store),new PostgresEmailAgentAuthority(database,store));
}
