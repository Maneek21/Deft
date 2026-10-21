import {AppIntegrationDestinationReviewInputSchema,AppIntegrationDestinationCommitInputSchema,type AppIntegrationDestinationReviewInput,type AppIntegrationDestination,type AppIntegrationTaskDetails} from '../../../../packages/app-kit/src/app-integration-destination.js';
import type {AppIntegrationSourceIdentity,AppIntegrationSourceTarget} from '../../../../packages/app-kit/src/app-integration-source.js';
import {appIntegrationSourceDigest,type AppIntegrationSourceCaller,type AppIntegrationSourceSnapshot} from './app-integration-source.js';
export type DestinationAudience=Readonly<{identity:unknown;visibility:'private'|'org'|'space'|'project';label:string;member_count:number}>;
export type DestinationReviewState=Readonly<{identity:unknown;summary?:Readonly<{has_local_edits:boolean}>}>;
export type DestinationResult=Readonly<{destination_kind:AppIntegrationDestination['kind'];destination_id:string;destination_url:string;replayed:boolean}>;
export type DestinationReceipt=Readonly<{request_digest:string;source:AppIntegrationSourceIdentity;destination:AppIntegrationDestination;result:DestinationResult}>;
export interface AppIntegrationDestinationPorts<Tx>{
 transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;
 source:{resolve(caller:AppIntegrationSourceCaller,identity:AppIntegrationSourceIdentity,purpose:'transfer'):Promise<AppIntegrationSourceTarget>;
  read(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:'transfer',signal?:AbortSignal):Promise<AppIntegrationSourceSnapshot>;
  guard(tx:Tx,caller:AppIntegrationSourceCaller,snapshot:AppIntegrationSourceSnapshot,purpose:'transfer'):Promise<void>};
 audience(tx:Tx,caller:AppIntegrationSourceCaller,destination:AppIntegrationDestination,taskDetails?:AppIntegrationTaskDetails):Promise<DestinationAudience>;
 /** Native owners read and lock current destination state in the same transaction.
  * Absent state preserves existing review digests. Never call an app under locks. */
 reviewState?(tx:Tx,caller:AppIntegrationSourceCaller,input:AppIntegrationDestinationReviewInput):Promise<DestinationReviewState|undefined>;
 receipt(tx:Tx,caller:AppIntegrationSourceCaller,request_id:string):Promise<DestinationReceipt|null>;
 reserve(tx:Tx,caller:AppIntegrationSourceCaller,input:{request_id:string;request_digest:string;review_digest:string;source:AppIntegrationSourceIdentity;destination:AppIntegrationDestination}):Promise<boolean>;
 create(tx:Tx,caller:AppIntegrationSourceCaller,input:AppIntegrationDestinationReviewInput,snapshot:AppIntegrationSourceSnapshot,request_id:string):Promise<DestinationResult>;
 visibleResult(tx:Tx,caller:AppIntegrationSourceCaller,result:DestinationResult):Promise<void>;
complete(tx:Tx,caller:AppIntegrationSourceCaller,request_id:string,result:DestinationResult):Promise<void>;
 afterCommit?(result:DestinationResult):Promise<void>;clock?:()=>number;
}
const denied=()=>new Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');
const conflict=()=>new Error('APP_INTEGRATION_DESTINATION_REQUEST_CONFLICT');
const evidence=(s:AppIntegrationSourceSnapshot)=>({publication:s.publication,authority_identity:s.authority.identity,resource:s.resource});
/** Network source verification precedes the destination transaction. This binds
 * an exact observed publication, not remote provider-global freshness. */
export function createAppIntegrationDestination<Tx>(ports:AppIntegrationDestinationPorts<Tx>){
 const now=ports.clock??Date.now;
 const current=(caller:AppIntegrationSourceCaller,s:AppIntegrationSourceSnapshot,signal?:AbortSignal)=>{signal?.throwIfAborted();if((caller.kind==='capture_policy'||caller.kind==='notification_policy')||!Number.isFinite(s.authority.expires_at)||s.authority.expires_at<=now())throw denied();};
 const read=async(caller:AppIntegrationSourceCaller,input:AppIntegrationDestinationReviewInput,signal?:AbortSignal)=>{
  if((caller.kind==='capture_policy'||caller.kind==='notification_policy'))throw denied();const target=await ports.source.resolve(caller,input.source,'transfer');
  const snapshot=await ports.source.read(caller,target,'transfer',signal);current(caller,snapshot,signal);
  if(input.mode==='excerpt'&&(typeof snapshot.presentation.plain_text!=='string'||!snapshot.presentation.plain_text.includes(input.excerpt!)))throw denied();return snapshot;
 };
 const reviewDigest=(caller:AppIntegrationSourceCaller,input:AppIntegrationDestinationReviewInput,s:AppIntegrationSourceSnapshot,a:DestinationAudience,state?:DestinationReviewState)=>appIntegrationSourceDigest(['deft.app_integration_destination_review.v1',caller.org_id,caller.user_id,caller.kind,caller.principal_id,input,evidence(s),a.identity,...(state===undefined?[]:[{destination_state:state.identity}])]);
 const statusWithSource=async(caller:AppIntegrationSourceCaller,request_id:string,signal?:AbortSignal)=>{
  if(!/^[a-f0-9-]{36}$/u.test(request_id))throw denied();const old=await ports.transaction(tx=>ports.receipt(tx,caller,request_id));if(!old)throw denied();
  const snapshot=await read(caller,{source:old.source,destination:old.destination,title:'status',mode:'source_link'},signal);
  return ports.transaction(async tx=>{await ports.source.guard(tx,caller,snapshot,'transfer');await ports.audience(tx,caller,old.destination);await ports.visibleResult(tx,caller,old.result);current(caller,snapshot,signal);return {snapshot,result:{...old.result,replayed:true}};});
 };
 return {
  async review(caller:AppIntegrationSourceCaller,raw:unknown,signal?:AbortSignal){const input=AppIntegrationDestinationReviewInputSchema.parse(raw),snapshot=await read(caller,input,signal);return ports.transaction(async tx=>{
   await ports.source.guard(tx,caller,snapshot,'transfer');const audience=await ports.audience(tx,caller,input.destination,input.task_details),state=await ports.reviewState?.(tx,caller,input);await ports.source.guard(tx,caller,snapshot,'transfer');current(caller,snapshot,signal);
   const {identity:unused,...publicAudience}=audience;void unused;return {schema_version:'deft.app_integration_destination_review.v1' as const,review_digest:reviewDigest(caller,input,snapshot,audience,state),audience:publicAudience,...(state?.summary?{destination_state:state.summary}:{}),observed_at:snapshot.publication.observed_at,partial:snapshot.publication.partial,expires_at:new Date(snapshot.authority.expires_at).toISOString()};
  });},
  statusWithSource,
  async status(caller:AppIntegrationSourceCaller,request_id:string,signal?:AbortSignal){return (await statusWithSource(caller,request_id,signal)).result;},
  async commit(caller:AppIntegrationSourceCaller,raw:unknown,signal?:AbortSignal){const parsed=AppIntegrationDestinationCommitInputSchema.parse(raw),{request_id,review_digest,...input}=parsed;
   const requestDigest=appIntegrationSourceDigest([caller.org_id,caller.user_id,parsed]),snapshot=await read(caller,input,signal);
   const result=await ports.transaction(async tx=>{await ports.source.guard(tx,caller,snapshot,'transfer');let audience=await ports.audience(tx,caller,input.destination,input.task_details);
    const old=await ports.receipt(tx,caller,request_id);if(old){if(old.request_digest!==requestDigest)throw conflict();await ports.visibleResult(tx,caller,old.result);current(caller,snapshot,signal);await ports.source.guard(tx,caller,snapshot,'transfer');return {...old.result,replayed:true};}
    const state=await ports.reviewState?.(tx,caller,input);
    if(reviewDigest(caller,input,snapshot,audience,state)!==review_digest)throw denied();
    if(!await ports.reserve(tx,caller,{request_id,request_digest:requestDigest,review_digest,source:input.source,destination:input.destination})){
     const receipt=await ports.receipt(tx,caller,request_id);if(!receipt||receipt.request_digest!==requestDigest)throw conflict();await ports.visibleResult(tx,caller,receipt.result);await ports.source.guard(tx,caller,snapshot,'transfer');current(caller,snapshot,signal);return {...receipt.result,replayed:true};
    }
    const created=await ports.create(tx,caller,input,snapshot,request_id);await ports.source.guard(tx,caller,snapshot,'transfer');audience=await ports.audience(tx,caller,input.destination,input.task_details);if(reviewDigest(caller,input,snapshot,audience,state)!==review_digest)throw denied();
    await ports.complete(tx,caller,request_id,created);await ports.source.guard(tx,caller,snapshot,'transfer');current(caller,snapshot,signal);return created;
   });if(!result.replayed&&ports.afterCommit)await ports.afterCommit(result).catch(()=>undefined);return result;
  },
 };
}
