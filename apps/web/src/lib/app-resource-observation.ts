import {ResourceObservationContextSchema,ResourceObservationReviewSchema,ResourceObservationStatusSchema,type ResourceObservationContext} from '../../../../packages/app-kit/src/resource-observation';
import {canonicalConnectionReattachmentJson} from '../../../../packages/app-kit/src/connection-session-reattach';
import {type AppConnectionSessionScope} from '../../../../packages/app-kit/src/connection-session';
export type ResourceObservationReview=ReturnType<typeof ResourceObservationReviewSchema.parse>;
export type ObservationTarget=ResourceObservationContext['targets'][number];
export type ObservationIdentity={installation_id:string;org_id:string;owner_user_id:string;target_key:string;scope:AppConnectionSessionScope;connection_session_id:string;account_ref:string};
type Journal={schema_version:'deft.browser_resource_observation_intent.v1';identity:ObservationIdentity;consent_id:string;phase:'reviewing'|'reviewed'|'activating'|'revoking';review_digest:string|null};
type Status=ReturnType<typeof ResourceObservationStatusSchema.parse>;
function fail():never{throw Error('Background refresh access changed. Check its status before continuing.');}
const object=(raw:unknown)=>raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:fail();
const closed=(raw:unknown,keys:string)=>{const v=object(raw);if(Object.keys(v).sort().join(',')!==keys.split(',').sort().join(','))fail();return v;};
const uuid=(raw:unknown):raw is string=>typeof raw==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(raw);
const digest=(raw:unknown):raw is string=>typeof raw==='string'&&/^sha256:[a-f0-9]{64}$/u.test(raw);
const equal=(a:unknown,b:unknown)=>canonicalConnectionReattachmentJson(a)===canonicalConnectionReattachmentJson(b);
export function observationContext(raw:unknown,identity:ObservationIdentity):ObservationTarget{
 const value=ResourceObservationContextSchema.parse(raw);
 if(value.installation_id!==identity.installation_id||value.org_id!==identity.org_id||value.owner_user_id!==identity.owner_user_id)fail();
 const targets=value.targets;
 if(new Set(targets.map(target=>target.target_key)).size!==targets.length||targets.some(target=>target.scope.org_id!==identity.org_id||target.scope.owner_user_id!==identity.owner_user_id||target.scope.installation_id!==identity.installation_id||target.scope.target_key!==target.target_key))fail();
 const target=targets.find(target=>target.target_key===identity.target_key);if(!target||target.connection_session_id!==identity.connection_session_id||target.account.account_ref!==identity.account_ref||!equal(target.scope,identity.scope))fail();return target;
}
/** This journal retains metadata only. A new human session can recover status
 * after fresh owner/scope validation; no JWT, provider token or grant is stored. */
export function createResourceObservationFlow(options:{identity:ObservationIdentity;current:()=>boolean;signal:AbortSignal;call:(path:string,init:RequestInit)=>Promise<unknown>;load:()=>unknown;store:(journal:Journal|null)=>void;now?:()=>number;uuid?:()=>string}){
 let target:ObservationTarget|undefined,status:Status|undefined,review:ResourceObservationReview|undefined,journal:Journal|undefined,busy=false;
 const now=()=>options.now?.()??Date.now(),check=()=>{if(options.signal.aborted||!options.current())throw Error('Background refresh session ended');};
 const input=options.load();if(input!==null&&input!==undefined){const v=closed(input,'schema_version,identity,consent_id,phase,review_digest');if(v.schema_version!=='deft.browser_resource_observation_intent.v1'||!equal(v.identity,options.identity)||!uuid(v.consent_id)||!['reviewing','reviewed','activating','revoking'].includes(String(v.phase))||v.review_digest!==null&&!digest(v.review_digest)||v.phase==='reviewing'&&v.review_digest!==null||v.phase!=='reviewing'&&v.review_digest===null)fail();journal=v as unknown as Journal;}
 const save=(next:Journal|null)=>{options.store(next);journal=next??undefined;};
 const post=async(operation:string,body:unknown)=>{check();const raw=await options.call(`/api/app-resource-observations/consent/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:options.signal,cache:'no-store'});check();return raw;};
 const view=(raw:unknown,consentId:string)=>{const value=ResourceObservationReviewSchema.parse(raw);const i=options.identity;
  if(value.consent_id!==consentId||value.connection_session_id!==i.connection_session_id||value.account.account_ref!==i.account_ref||!equal(value.scope,i.scope)||!target||value.interval_seconds<target.min_interval_seconds||Date.parse(value.expires_at)>Date.parse(i.scope.consent_expires_at)||value.attachment_mode!=='unsupported')fail();return value;};
 const parseStatus=(raw:unknown,consentId:string)=>{const value=ResourceObservationStatusSchema.parse(raw);if(value.consent_id!==consentId)fail();const checked=view(value.review,consentId);if(journal?.review_digest&&checked.review_digest!==journal.review_digest)fail();return {...value,review:checked};};
 const checkStatus=async()=>{
  const id=journal?.consent_id??target?.consent?.consent_id;if(!id){review=undefined;status=undefined;return;}
  const value=parseStatus(await post('status',{consent_id:id}),id);status=value;review=undefined;
  if(journal?.phase==='revoking'){if(value.state==='revoked'||value.state==='unavailable'&&Date.parse(value.review.expires_at)<=now())save(null);return;}
  if(value.state==='active'||value.state==='revoked'||value.state==='unavailable'&&Date.parse(value.review.expires_at)<=now()){save(null);return;}
  if(value.state==='proposed'&&Date.parse(value.review.expires_at)>now()&&(!journal||['reviewing','reviewed'].includes(journal.phase))){save({schema_version:'deft.browser_resource_observation_intent.v1',identity:options.identity,consent_id:id,phase:'reviewed',review_digest:value.review.review_digest});review=value.review;}
 };
 return {get target(){return target;},get status(){return status;},get review(){return review;},get uncertain(){return !!journal&&journal.phase!=='reviewed';},get pending(){return !!journal;},
  async load(){if(busy)fail();busy=true;try{check();const next=observationContext(await options.call(`/api/app-resource-observations/installations/${encodeURIComponent(options.identity.installation_id)}/context`,{method:'GET',cache:'no-store',signal:options.signal}),options.identity);check();target=next;await checkStatus();check();return target;}finally{busy=false;}},
  async check(){if(busy)fail();busy=true;try{check();await checkStatus();check();}finally{busy=false;}},
  async prepare(intervalSeconds:number,expiresAt:string){if(busy||journal)fail();check();if(!target||!Number.isSafeInteger(intervalSeconds)||intervalSeconds<target.min_interval_seconds||intervalSeconds>86400||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now())fail();
   const id=options.uuid?.()??crypto.randomUUID();if(!uuid(id))fail();busy=true;review=undefined;const next:Journal={schema_version:'deft.browser_resource_observation_intent.v1',identity:options.identity,consent_id:id,phase:'reviewing',review_digest:null};
   try{save(next);const value=view(await post('review',{connection_session_id:options.identity.connection_session_id,request_id:id,interval_seconds:intervalSeconds,expires_at:expiresAt}),id);
    if(value.interval_seconds!==intervalSeconds||Date.parse(value.expires_at)>Date.parse(expiresAt)||Date.parse(value.expires_at)<=now())fail();check();save({...next,phase:'reviewed',review_digest:value.review_digest});review=value;status={schema_version:'deft.app_resource_observation_status.v1',consent_id:id,state:'proposed',review:value};return value;
   }finally{busy=false;}
  },
  async activate(){if(busy||!review||journal?.phase!=='reviewed'||status?.state!=='proposed'||Date.parse(review.expires_at)<=now())fail();check();const captured=review;busy=true;
   try{save({...journal,phase:'activating'});review=undefined;const value=parseStatus(await post('activate',{consent_id:captured.consent_id,review_digest:captured.review_digest}),captured.consent_id);if(value.state!=='active')fail();check();save(null);status=value;return true;}catch{review=undefined;return false;}finally{busy=false;}
  },
  async revoke(){if(busy||journal||status?.state!=='active')fail();check();const captured=status.review;busy=true;
   try{save({schema_version:'deft.browser_resource_observation_intent.v1',identity:options.identity,consent_id:captured.consent_id,phase:'revoking',review_digest:captured.review_digest});const value=closed(await post('revoke',{consent_id:captured.consent_id}),'consent_id,state');if(value.consent_id!==captured.consent_id||value.state!=='revoked')fail();check();save(null);status={schema_version:'deft.app_resource_observation_status.v1',consent_id:captured.consent_id,state:'revoked',review:captured};review=undefined;return true;}catch{return false;}finally{busy=false;}
  },closeReview(){review=undefined;}
 };
}
