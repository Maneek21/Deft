import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AppDataRuntimeRequestSchema,AppDataRuntimeAuthorityRequestSchema,AppDataRuntimeAuthorityResultSchema,canonicalAppDataJson,type AppDataRuntimeRequest} from '@deft/app-kit/core';
import type {AppIntegrationSourceCaller,AppIntegrationSourceAuthority} from './app-integration-source.js';
import type {AppIntegrationSourcePurpose,AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
export type AppIntegrationAccountScope=Readonly<{installation_id:string;account_ref:string;store_key:string}>;
export type AppIntegrationCurrentAccount=AppIntegrationSourceAuthority&Readonly<{resource_binding_id:string;resource_key:string;
 scope:AppDataRuntimeRequest['scope'];connection:AppDataRuntimeRequest['connection'];authority:AppDataRuntimeRequest['authority'];profile:unknown}>;
export type AppIntegrationInvocation=Readonly<{caller:AppIntegrationSourceCaller;target:AppIntegrationAccountScope;purpose:AppIntegrationSourcePurpose;
 identity:string;authority_expires_at:number;context:ReturnType<typeof AppDataRuntimeAuthorityRequestSchema.parse>;state:'inflight'|'completed'|'indeterminate'}>;
export interface AppIntegrationDataGatewayPorts<Tx>{
 /** Concrete principal/policy authority must bind actual token version, private
  * DM or enabled capture policy revision; no caller is accepted from Runtime. */
 account(caller:AppIntegrationSourceCaller,target:AppIntegrationAccountScope,purpose:AppIntegrationSourcePurpose,tx?:Tx):Promise<AppIntegrationCurrentAccount>;
 journal:{begin(row:AppIntegrationInvocation):Promise<boolean>;read(id:string):Promise<AppIntegrationInvocation|null>;
  finish(id:string,state:'completed'|'indeterminate'):Promise<void>};
 authenticate(scope:AppDataRuntimeRequest['scope'],authorization:string|undefined):Promise<void>;
 transport(account:AppIntegrationCurrentAccount,request:AppDataRuntimeRequest,signal:AbortSignal):Promise<{result?:{request_id:string;operation:string;input_digest:string;outcome:string}}>;clock?:()=>number;
}
const denied=()=>new Error('APP_INTEGRATION_DATA_ACCESS_DENIED');
const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
/** Existing public data protocol with a separate metadata-only retained actor
 * journal. No browser SID, new provider executor or content in the journal. */
export function createAppIntegrationDataGateway<Tx>(ports:AppIntegrationDataGatewayPorts<Tx>){
 const now=ports.clock??Date.now;
 async function currentAccount(caller:AppIntegrationSourceCaller,target:AppIntegrationAccountScope,purpose:AppIntegrationSourcePurpose,tx?:Tx){
  const account=await ports.account(caller,target,purpose,tx);
  if(!account.identity||!Number.isFinite(account.expires_at)||account.expires_at<=now()
   ||account.scope.org_id!==caller.org_id||account.scope.owner_user_id!==caller.user_id
   ||account.scope.installation_id!==target.installation_id||account.connection.account_ref!==target.account_ref)throw denied();return account;
 }
 async function retained(id:string){const row=await ports.journal.read(id);if(!row||row.state!=='inflight'||Date.parse(row.context.expires_at)<=now()
  ||row.authority_expires_at<=now())throw denied();return row;}
 async function same(row:AppIntegrationInvocation){const account=await currentAccount(row.caller,row.target,row.purpose);
  if(account.identity!==row.identity||!isDeepStrictEqual(account.scope,row.context.scope)||!isDeepStrictEqual(account.connection,row.context.connection)
   ||!isDeepStrictEqual(account.authority,row.context.authority))throw denied();return account;}
 return Object.freeze({currentAccount,
  async current(caller:AppIntegrationSourceCaller,target:AppIntegrationAccountScope,purpose:AppIntegrationSourcePurpose){
   const account=await currentAccount(caller,target,purpose);return {identity:account.identity,expires_at:account.expires_at};},
  async mint(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,
   operation:AppDataRuntimeRequest['operation'],input:Record<string,unknown>,max_ms=5000){
   if(!Number.isSafeInteger(max_ms)||max_ms<1||max_ms>30000)throw denied();
   // This shared source gateway discloses one observed presentation only.
   // Draft/triage/Send tool admissions use their independent operation grants.
   if((purpose==='notification_projection')!==(caller.kind==='notification_policy')||purpose==='notification_projection'&&operation!=='resource_read_metadata'||!['resource_read_presentation','resource_read_metadata'].includes(operation)||input.store_key!==target.store_key||input.resource_key!==target.ref.resource_key
    ||input.record_id!==target.ref.record_id||input.content_digest!==target.ref.content_digest)throw denied();
   const account=await currentAccount(caller,target,purpose);
   if(account.resource_binding_id!==target.resource_binding_id)throw denied();
   const request=AppDataRuntimeRequestSchema.parse({schema_version:'deft.app_data_runtime.v1',request_id:randomUUID(),scope:account.scope,
    connection:account.connection,authority:account.authority,operation,input,expires_at:new Date(Math.min(now()+max_ms,account.expires_at)).toISOString()});
   const {input:discard,...envelope}=request;void discard;
   const context=AppDataRuntimeAuthorityRequestSchema.parse({...envelope,schema_version:'deft.app_data_authority.v1',input_digest:digest({operation,input})});
   const scope={installation_id:target.installation_id,account_ref:target.account_ref,store_key:target.store_key};
   if(!await ports.journal.begin(structuredClone({caller,target:scope,purpose,identity:account.identity,authority_expires_at:account.expires_at,context,state:'inflight'})))throw denied();
   return request;
  },
  async dispatch(request:AppDataRuntimeRequest,signal?:AbortSignal){
   const parsed=AppDataRuntimeRequestSchema.parse(request),row=await retained(parsed.request_id);
   const {input:discard,...envelope}=parsed;void discard;
   if(!isDeepStrictEqual(row.context,{...envelope,schema_version:'deft.app_data_authority.v1',input_digest:digest({operation:parsed.operation,input:parsed.input})}))throw denied();
   const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
   const timer=setTimeout(()=>controller.abort(),Math.max(1,Date.parse(parsed.expires_at)-now()));
   try{const account=await same(row);controller.signal.throwIfAborted();const reply=await ports.transport(account,parsed,controller.signal);
    controller.signal.throwIfAborted();await same(await retained(parsed.request_id));
    if(!reply.result||reply.result.request_id!==parsed.request_id||reply.result.operation!==parsed.operation||reply.result.input_digest!==row.context.input_digest)throw denied();
    await ports.journal.finish(parsed.request_id,'completed');return reply;
   }catch(error){await ports.journal.finish(parsed.request_id,'indeterminate');throw error;}
   finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  },
  async callback(raw:unknown,authorization:string|undefined){const input=AppDataRuntimeAuthorityRequestSchema.parse(raw);
   await ports.authenticate(input.scope,authorization);const row=await retained(input.request_id);
   if(!isDeepStrictEqual(row.context,input))throw denied();const account=await same(row);
   const after=await retained(input.request_id);if(!isDeepStrictEqual(after,row))throw denied();await ports.authenticate(input.scope,authorization);
   return AppDataRuntimeAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(Math.min(Date.parse(input.expires_at),account.expires_at,row.authority_expires_at)).toISOString()});
  }
 });
}
