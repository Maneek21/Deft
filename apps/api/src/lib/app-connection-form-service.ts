import {appConsentDeadline} from '@deft/app-kit/core';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {AppConnectionFormBeginSchema,AppConnectionFormManageSchema,AppConnectionFormRecordSchema,
 AppConnectionFormRuntimeResultSchema,AppConnectionFormRuntimeRequestSchema,AppConnectionFormSessionViewSchema,
 type AppConnectionFormRecord,type AppConnectionFormRuntimeRequest,type AppConnectionFormRuntimeResult} from '../../../../packages/app-kit/src/connection-form.js';
import type {AppConnectionSessionScope} from '../../../../packages/app-kit/src/connection-session.js';
import type {AppConnectionActionConsents} from '../../../../packages/app-kit/src/connection-session-v2.js';

export type FormCaller=Readonly<{org_id:string;user_id:string;sid:string;access_expires_at:number}>;
export type FormAuthority=Readonly<{scope:AppConnectionSessionScope;action_consents:AppConnectionActionConsents;transport_digest:string;authorization_origin:string;connection_protocol:'credential_form.v1';expires_at:number}>;
export type FormLocator=Readonly<{org_id:string;owner_user_id:string;session_id:string}>;
export type FormStore=Readonly<{create(record:AppConnectionFormRecord,caller:FormCaller):Promise<boolean>;read(locator:FormLocator):Promise<AppConnectionFormRecord|null>;compareAndSet(prior:AppConnectionFormRecord,next:AppConnectionFormRecord,caller:FormCaller):Promise<boolean>}>;
export type FormPorts=Readonly<{store:FormStore;sourceAvailable(record:AppConnectionFormRecord):Promise<boolean>;current(caller:FormCaller,nomination:{installation_id:string;target_key:string},operation:'begin'|'status'|'disconnect'):Promise<FormAuthority>;request(record:AppConnectionFormRecord,input:AppConnectionFormRuntimeRequest,signal:AbortSignal):Promise<unknown>}>;
const fail=(code:string,status:number):never=>{throw Object.assign(new Error(code),{code,status});};
const canonical=(raw:unknown):string=>JSON.stringify(raw,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const digest=(raw:unknown)=>'sha256:'+createHash('sha256').update(canonical(raw)).digest('hex');
const receiptDigest=(receipt:Record<string,unknown>)=>digest(Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=='digest')));
/** One host-side Begin consumption/reservation, then status-only lost response
 * recovery. Credential submission is outside this host service entirely. */
export class AppConnectionFormService{
 constructor(private readonly ports:FormPorts,private readonly now=Date.now){}
 private locator(caller:FormCaller,id:string){return {org_id:caller.org_id,owner_user_id:caller.user_id,session_id:id};}
 private async current(caller:FormCaller,nomination:{installation_id:string;target_key:string},operation:'begin'|'status'|'disconnect',record?:AppConnectionFormRecord){
  const current=await this.ports.current(caller,nomination,operation);
  if(current.connection_protocol!=='credential_form.v1'||current.scope.org_id!==caller.org_id||current.scope.owner_user_id!==caller.user_id||current.scope.installation_id!==nomination.installation_id||current.scope.target_key!==nomination.target_key||!Number.isFinite(current.expires_at)||!Number.isFinite(caller.access_expires_at)||Math.min(current.expires_at,caller.access_expires_at,appConsentDeadline(current.scope.consent_expires_at, current.scope.consent_lifetime))<=this.now()
  ||record&&(!isDeepStrictEqual(current.scope,record.scope)||current.transport_digest!==record.transport_digest||current.authorization_origin!==record.authorization_origin||operation==='begin'&&!isDeepStrictEqual(current.action_consents,record.action_consents)))return fail('APP_ACCESS_DENIED',403);
  if(record&&!await this.ports.sourceAvailable(record))return fail('APP_ACCESS_DENIED',403);
  return current;
 }
 private nomination(record:AppConnectionFormRecord){return {installation_id:record.scope.installation_id,target_key:record.scope.target_key};}
 private async read(caller:FormCaller,id:string){const found=await this.ports.store.read(this.locator(caller,id));if(!found)throw fail('APP_ACCESS_DENIED',403);return AppConnectionFormRecordSchema.parse(found);}
 private async write(caller:FormCaller,prior:AppConnectionFormRecord,change:Partial<AppConnectionFormRecord>){const next=AppConnectionFormRecordSchema.parse({...prior,...change,revision:prior.revision+1,updated_at:new Date(this.now()).toISOString()});if(!await this.ports.store.compareAndSet(prior,next,caller))return fail('APP_STATE_CONFLICT',409);return next;}
 private view(record:AppConnectionFormRecord){const {action_consents,source,transport_digest,authorization_origin,runtime_session_ref,...view}=record;return AppConnectionFormSessionViewSchema.parse({...view,schema_version:'deft.app_connection_form_session.v1'});}
 private envelope(record:AppConnectionFormRecord,current:FormAuthority,operation:'begin'|'status'|'disconnect'){
  return AppConnectionFormRuntimeRequestSchema.parse({schema_version:'deft.app_connection_form_runtime.v1',session_id:record.session_id,scope:record.scope,source:record.source,action_consents:record.action_consents,setup_expires_at:record.input_expires_at,operation,expires_at:new Date(Math.min(this.now()+30000,current.expires_at,appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime))).toISOString(),...(operation==='begin'?{}:{runtime_session_ref:record.runtime_session_ref})});
 }
 private validateResult(record:AppConnectionFormRecord,raw:unknown,operation:string){const reply=AppConnectionFormRuntimeResultSchema.parse(raw);if(reply.session_id!==record.session_id||record.runtime_session_ref&&record.runtime_session_ref!==reply.runtime_session_ref||operation!=='begin'&&reply.state==='awaiting_input'&&reply.setup_url)return fail('APP_PROVIDER_UNAVAILABLE',503);
  if(reply.state==='connected'&&(reply.receipt.scope_digest!==digest(record.scope)||reply.receipt.digest!==receiptDigest(reply.receipt)||record.source&&reply.account.account_ref!==record.source.account_ref))return fail('APP_PROVIDER_UNAVAILABLE',503);
  if(reply.state==='awaiting_input'&&(reply.setup_expires_at!==record.input_expires_at||reply.setup_url&&new URL(reply.setup_url).origin!==record.authorization_origin))return fail('APP_PROVIDER_UNAVAILABLE',503);return reply;
 }
 private projection(reply:AppConnectionFormRuntimeResult):Partial<AppConnectionFormRecord>{return {state:reply.state,runtime_session_ref:reply.runtime_session_ref,input_consumed:reply.input_consumed,account:'account' in reply?reply.account:null,receipt:reply.receipt};}
 async begin(caller:FormCaller,raw:unknown){const input=AppConnectionFormBeginSchema.parse(raw),authority=await this.current(caller,input,'begin'),existing=await this.ports.store.read(this.locator(caller,input.request_id));
  if(existing){await this.current(caller,this.nomination(existing),'status',existing);return {session:this.view(existing)};}
  let source:AppConnectionFormRecord['source']=null;if(input.source_session_id){const prior=await this.read(caller,input.source_session_id);if(prior.state!=='connected'||!prior.account||!prior.runtime_session_ref||['org_id','owner_user_id','installation_id','target_key','resource_key','operator_user_id'].some(key=>prior.scope[key as keyof AppConnectionSessionScope]!==authority.scope[key as keyof AppConnectionSessionScope]))return fail('APP_STATE_CONFLICT',409);source={session_id:prior.session_id,session_revision:prior.revision,scope:prior.scope,runtime_session_ref:prior.runtime_session_ref,account_ref:prior.account.account_ref};}
  const created=this.now(),at=new Date(created).toISOString();let record=AppConnectionFormRecordSchema.parse({schema_version:'deft.app_connection_form_record.v1',session_id:input.request_id,revision:1,scope:authority.scope,action_consents:authority.action_consents,source,transport_digest:authority.transport_digest,authorization_origin:authority.authorization_origin,state:'starting',runtime_session_ref:null,begin_consumed:false,input_consumed:false,input_expires_at:new Date(Math.min(created+300000,appConsentDeadline(authority.scope.consent_expires_at, authority.scope.consent_lifetime))).toISOString(),account:null,receipt:null,created_at:at,updated_at:at});
  if(!await this.ports.store.create(record,caller))return fail('APP_STATE_CONFLICT',409);
  record=await this.write(caller,record,{begin_consumed:true});const current=await this.current(caller,input,'begin',record);
  try{const reply=this.validateResult(record,await this.ports.request(record,this.envelope(record,current,'begin'),AbortSignal.timeout(30000)),'begin');await this.current(caller,input,'begin',record);record=await this.write(caller,record,this.projection(reply));await this.current(caller,this.nomination(record),'begin',record);return {session:this.view(record),...(reply.state==='awaiting_input'&&reply.setup_url?{setup_url:reply.setup_url}:{})};}
  catch(error){await this.write(caller,record,{state:'indeterminate'});throw error;}
 }
 async manage(caller:FormCaller,raw:unknown,operation:'status'|'disconnect'='status'){const {session_id}=AppConnectionFormManageSchema.parse(raw);let record=await this.read(caller,session_id),authority=await this.current(caller,this.nomination(record),operation,record);
  if(!record.runtime_session_ref&&operation==='disconnect')return {session:this.view(record)};if(operation==='status'&&['not_connected','disconnected'].includes(record.state))return {session:this.view(record)};
  record=await this.write(caller,record,{state:operation==='status'?'checking':'disconnecting'});
  try{const reply=this.validateResult(record,await this.ports.request(record,this.envelope(record,authority,operation),AbortSignal.timeout(30000)),operation);await this.current(caller,this.nomination(record),operation,record);record=await this.write(caller,record,this.projection(reply));await this.current(caller,this.nomination(record),operation,record);return {session:this.view(record)};}
  catch(error){await this.write(caller,record,{state:'indeterminate'});throw error;}
 }
}
