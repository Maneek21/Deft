import {z} from 'zod';
import type {EmailActor,EmailScope} from './email-mailbox-service.js';
import type {EmailAccountOwnerSnapshot} from './email-account-owner-authority.js';
import {planEmailAccountAdoption,planEmailAccountConsent,planEmailAccountReconnect,planEmailAccountStop,type EmailAccountLifecyclePlan,type EmailAccountConnectionProof,type EmailAccountConsent} from './email-account-lifecycle.js';
const counter=z.number().int().min(0).max(2147483646),caps=z.array(z.enum(['read','modify','send'])).min(1).max(3).refine(v=>v.includes('read')&&new Set(v).size===v.length);
export const EmailAccountLifecycleRequestSchema=z.strictObject({expected_revision:counter,expected_native_revision:counter.refine(v=>v>0),operation:z.enum(['adopt','consent','pause','disconnect','reconnect','revoke']),capabilities:caps.optional()}).superRefine((v,c)=>{if(['adopt','consent'].includes(v.operation)!==(v.capabilities!==undefined))c.addIssue({code:'custom',message:'Capabilities required only for explicit consent'});});
export type EmailAccountLifecycleStatus=Readonly<{schema_version:'deft.email_account_lifecycle.v1';account_id:string;provider:'gmail'|'microsoft'|'imap_smtp';authority_mode:'legacy'|'standalone';state:'active'|'paused'|'disconnected'|'revoked';revision:number;native_revision:number;credential_revision:number|null;capabilities:readonly ('read'|'modify'|'send')[];available_capabilities:readonly ('read'|'modify'|'send')[];adoption_available:boolean;connection_available:boolean}>;
export type EmailAccountLifecycleCatalogEntry=Pick<EmailAccountLifecycleStatus,'account_id'|'provider'|'authority_mode'|'state'|'revision'|'native_revision'>&{primary_address:string;display_label:string};
export type EmailAccountLifecyclePorts={
 snapshot(actor:EmailActor,scope:EmailScope,signal?:AbortSignal):Promise<EmailAccountOwnerSnapshot>;
 connection(actor:EmailActor,scope:EmailScope,snapshot:EmailAccountOwnerSnapshot,signal?:AbortSignal):Promise<EmailAccountConnectionProof>;
 commit(actor:EmailActor,plan:EmailAccountLifecyclePlan,signal?:AbortSignal):Promise<EmailAccountConsent>;
 schedule?(scope:EmailScope,revision:number):Promise<void>;
 catalog(actor:EmailActor,orgId:string,signal?:AbortSignal):Promise<{accounts:EmailAccountLifecycleCatalogEntry[];has_more:boolean}>;
};
/** A deliberate human management operation. Connection inspection is metadata
 * only; it cannot perform provider reads, writes or restart uncertain effects. */
export class EmailAccountLifecycleService{
 constructor(private readonly ports:EmailAccountLifecyclePorts,private readonly now=Date.now){}
 catalog(actor:EmailActor,orgId:string,signal?:AbortSignal){return this.ports.catalog(actor,orgId,signal);}
 private project(snapshot:EmailAccountOwnerSnapshot,proof:EmailAccountConnectionProof|null):EmailAccountLifecycleStatus{
  const a=snapshot.account,c=snapshot.consent,available=proof?.available_capabilities??[];
  return {schema_version:'deft.email_account_lifecycle.v1',account_id:a.account_id,provider:a.provider as EmailAccountLifecycleStatus['provider'],authority_mode:c?'standalone':'legacy',state:(c?.state??a.state) as EmailAccountLifecycleStatus['state'],revision:c?.revision??0,native_revision:a.authority_revision,credential_revision:proof?.credential_revision??c?.credential_revision??null,capabilities:c?.capabilities??(available.length?available:['read']),available_capabilities:available,adoption_available:!c&&a.state==='active'&&Boolean(proof),connection_available:Boolean(proof)};
 }
 async read(actor:EmailActor,scope:EmailScope,signal?:AbortSignal):Promise<EmailAccountLifecycleStatus>{
  const before=await this.ports.snapshot(actor,scope,signal);let proof:EmailAccountConnectionProof|null=null;
  try{proof=await this.ports.connection(actor,scope,before,signal);}catch{signal?.throwIfAborted();}
  const after=await this.ports.snapshot(actor,scope,signal);if(after.capability.authority_version!==before.capability.authority_version)throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');return this.project(after,proof);
 }
 async update(actor:EmailActor,scope:EmailScope,raw:z.infer<typeof EmailAccountLifecycleRequestSchema>,signal?:AbortSignal):Promise<EmailAccountLifecycleStatus>{
  const input=EmailAccountLifecycleRequestSchema.parse(raw),before=await this.ports.snapshot(actor,scope,signal),prior=before.consent;
  if(input.expected_revision!==(prior?.revision??0)||input.expected_native_revision!==before.account.authority_revision)throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');
  let proof:EmailAccountConnectionProof|null=null,plan:EmailAccountLifecyclePlan;
  if(['adopt','consent','reconnect'].includes(input.operation)){
   try{proof=await this.ports.connection(actor,scope,before,signal);}catch(error){signal?.throwIfAborted();if(error instanceof Error&&error.message==='EMAIL_ACCESS_DENIED')throw error;throw Error('EMAIL_ACCOUNT_CONNECTION_UNAVAILABLE');}
   if(input.capabilities?.some(cap=>!proof!.available_capabilities.includes(cap)))throw Error('EMAIL_ACCOUNT_CAPABILITY_UNAVAILABLE');
   if(input.operation==='adopt'){if(prior||before.account.state!=='active')throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');plan=planEmailAccountAdoption(proof,input.capabilities!,this.now());}
   else {if(!prior)throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');plan=input.operation==='consent'?planEmailAccountConsent(prior,proof,input.capabilities!,this.now()):planEmailAccountReconnect(prior,proof,this.now());}
  }else{if(!prior)throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');plan=planEmailAccountStop(prior,{scope,provider:prior.provider,principal_digest:prior.principal_digest,native_revision:before.account.authority_revision,consent_revision:prior.revision,credential_revision:prior.credential_revision},input.operation as 'pause'|'disconnect'|'revoke',this.now());}
  const after=await this.ports.snapshot(actor,scope,signal);if(after.capability.authority_version!==before.capability.authority_version)throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');
  const committed=await this.ports.commit(actor,plan,signal);
  if(committed.state==='active'&&['adopt','reconnect','consent'].includes(input.operation)){
   // Durable active account + current revision remains the bounded periodic
   // repair source if queue enqueue fails. Never requeue an Outbox effect.
   try{await this.ports.schedule?.(scope,committed.native_revision);}catch{signal?.throwIfAborted();}
  }
  const final=await this.ports.snapshot(actor,scope,signal);
  if(final.consent?.revision!==committed.revision||final.account.authority_revision!==committed.native_revision)throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');
  return this.project(final,proof);
 }
}
