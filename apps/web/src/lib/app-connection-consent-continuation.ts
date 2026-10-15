import {appConsentDeadline,type AppConsentLifetime} from '../../../../packages/app-kit/src/consent-lifetime';
import { AppConnectionSessionViewSchema } from '../../../../packages/app-kit/src/connection-session';
import { AppConnectionConsentContinuationSourceSchema, AppConnectionConsentContinuationReviewViewSchema,
  canonicalConnectionConsentContinuationJson } from '../../../../packages/app-kit/src/connection-session-consent-continuation';
const id=AppConnectionSessionViewSchema.shape.session_id,key=AppConnectionSessionViewSchema.shape.scope.shape.target_key;
const account=AppConnectionSessionViewSchema.shape.account.unwrap(),date=AppConnectionConsentContinuationReviewViewSchema.shape.expires_at;
const review=AppConnectionConsentContinuationReviewViewSchema,result=AppConnectionSessionViewSchema;
export type ConsentContinuationReview=ReturnType<typeof review.parse>;
type Source=ReturnType<typeof AppConnectionConsentContinuationSourceSchema.parse>;
type Account=ReturnType<typeof account.parse>;
export type ConsentContinuationIdentity={installationId:string;orgId:string;ownerId:string;sessionTag:string};
export type ConsentContinuationTarget={target_key:string;source:Source;account:Account;max_consent_expires_at:string;allow_until_revoked?:true;runtime_ready:boolean;
 pending:null|{session_id:string;consent_expires_at:string|null;consent_lifetime?:AppConsentLifetime;state:string;activation_started:boolean;review:ConsentContinuationReview|null}};
export type ConsentContinuationContext={schema_version:'deft.app_connection_consent_continuation_context.v1';installation_id:string;org_id:string;owner_user_id:string;targets:ConsentContinuationTarget[]};
type Pointer={schema_version:'deft.app_consent_continuation_pending.v1';identity:ConsentContinuationIdentity;target_key:string;session_id:string;source:Source;account:Account;consent_expires_at:string|null;consent_lifetime?:AppConsentLifetime;phase:'reviewing'|'reviewed'|'activating'|'uncertain'|'resolved';review:ConsentContinuationReview|null};
const bad=():never=>{throw Error('Account permission metadata is invalid. Check the original request status.');};
function object(raw:unknown,keys:string,optional=''){if(!raw||typeof raw!=='object'||Array.isArray(raw))return bad();const o=raw as Record<string,unknown>;if(keys.split(',').some(k=>!Object.hasOwn(o,k))||Object.keys(o).some(k=>![...keys.split(','),...optional.split(',')].includes(k)))return bad();return o;}
const boolean=(v:unknown)=>typeof v==='boolean'?v:bad();
export type ConsentContinuationChoice={consent_expires_at:string|null;consent_lifetime?:AppConsentLifetime};
function choice(raw:Record<string,unknown>):ConsentContinuationChoice{const lifetime=raw.consent_lifetime;if(lifetime!==undefined&&lifetime!=='until_revoked')return bad();const expiry=raw.consent_expires_at;if(expiry!==null&&typeof expiry!=='string')return bad();appConsentDeadline(expiry,lifetime);return {consent_expires_at:expiry,...(lifetime?{consent_lifetime:lifetime}:{})};}
const deadline=(v:ConsentContinuationChoice)=>appConsentDeadline(v.consent_expires_at,v.consent_lifetime);
const sameChoice=(a:ConsentContinuationChoice,b:ConsentContinuationChoice)=>a.consent_expires_at===b.consent_expires_at&&a.consent_lifetime===b.consent_lifetime;
const ceiling=(t:ConsentContinuationTarget,c:ConsentContinuationChoice)=>c.consent_lifetime==='until_revoked'&&t.allow_until_revoked===true?Infinity:Date.parse(t.max_consent_expires_at);
const identity={parse(raw:unknown):ConsentContinuationIdentity{const v=object(raw,'installationId,orgId,ownerId,sessionTag');if(typeof v.sessionTag!=='string'||!/^[a-f0-9]{64}$/u.test(v.sessionTag))return bad();return {installationId:id.parse(v.installationId),orgId:id.parse(v.orgId),ownerId:id.parse(v.ownerId),sessionTag:v.sessionTag};}};
const context={parse(raw:unknown):ConsentContinuationContext{const v=object(raw,'schema_version,installation_id,org_id,owner_user_id,targets');if(v.schema_version!=='deft.app_connection_consent_continuation_context.v1'||!Array.isArray(v.targets)||v.targets.length>32)return bad();
 return {schema_version:v.schema_version,installation_id:id.parse(v.installation_id),org_id:id.parse(v.org_id),owner_user_id:id.parse(v.owner_user_id),targets:v.targets.map(raw=>{const t=object(raw,'target_key,source,account,max_consent_expires_at,runtime_ready,pending','allow_until_revoked');if(t.allow_until_revoked!==undefined&&t.allow_until_revoked!==true)return bad();let pending:ConsentContinuationTarget['pending']=null;if(t.pending!==null){const p=object(t.pending,'session_id,consent_expires_at,state,activation_started,review','consent_lifetime');if(typeof p.state!=='string'||!/^[a-z_]{1,48}$/u.test(p.state))return bad();pending={session_id:id.parse(p.session_id),...choice(p),state:p.state,activation_started:boolean(p.activation_started),review:p.review===null?null:review.parse(p.review)};}
 return {target_key:key.parse(t.target_key),source:AppConnectionConsentContinuationSourceSchema.parse(t.source),account:account.parse(t.account),max_consent_expires_at:date.parse(t.max_consent_expires_at),...(t.allow_until_revoked===true?{allow_until_revoked:true as const}:{}),runtime_ready:boolean(t.runtime_ready),pending};})};}};
const pointer={parse(raw:unknown):Pointer{const p=object(raw,'schema_version,identity,target_key,session_id,source,account,consent_expires_at,phase,review','consent_lifetime');if(p.schema_version!=='deft.app_consent_continuation_pending.v1'||typeof p.phase!=='string'||!['reviewing','reviewed','activating','uncertain','resolved'].includes(p.phase))return bad();return {schema_version:p.schema_version,identity:identity.parse(p.identity),target_key:key.parse(p.target_key),session_id:id.parse(p.session_id),source:AppConnectionConsentContinuationSourceSchema.parse(p.source),account:account.parse(p.account),...choice(p),phase:p.phase as Pointer['phase'],review:p.review===null?null:review.parse(p.review)};}};
type Ports={identity:ConsentContinuationIdentity;storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;current:()=>boolean;
 get:()=>Promise<unknown>;post:(operation:'review'|'activate'|'status',body:unknown)=>Promise<unknown>;now?:()=>number;uuid?:()=>string};
const same=(a:unknown,b:unknown)=>canonicalConnectionConsentContinuationJson(a)===canonicalConnectionConsentContinuationJson(b);
function fail():never{throw Error('Account permission was not confirmed. Check the original request status before continuing.');}
/** Browser pointer is an acknowledgement fence, never consent authority. */
export function createConsentContinuationFlow(ports:Ports){
 const owner=identity.parse(ports.identity),now=()=>ports.now?.()??Date.now();let busy=false,disposed=false,value:ConsentContinuationContext|null=null;
 const current=()=>{if(disposed||!ports.current())fail();};
 const storageKey=(targetKey:string)=>'deft.app-consent-continuation.pending.v1:'+JSON.stringify([owner,targetKey]);
 function read(targetKey:string){const raw=ports.storage.getItem(storageKey(targetKey));if(!raw)return null;if(raw.length>32768)fail();const p=pointer.parse(JSON.parse(raw));if(!same(p.identity,owner)||p.target_key!==targetKey)fail();return p;}
 function write(p:Pointer){current();ports.storage.setItem(storageKey(p.target_key),JSON.stringify(pointer.parse(p)));}
 function chosen(targetKey:string){current();const chosen=value?.targets.find(t=>t.target_key===targetKey);if(!chosen)fail();return chosen;}
 function checkedReview(raw:unknown,t:ConsentContinuationTarget,p:Pointer){const v=review.parse(raw);
  if(v.session_id!==p.session_id||v.source_session_id!==p.source.session_id||v.source_revision!==p.source.session_revision||!same(v.account,p.account)
   ||!sameChoice(v.scope,p)||Object.keys(p.source.scope).some(k=>!['consent_expires_at','consent_lifetime'].includes(k)&&v.scope[k as keyof typeof v.scope]!==p.source.scope[k as keyof typeof p.source.scope])
   ||deadline(v.scope)>ceiling(t,p)||v.action_consents.length!==p.source.action_consents.length
   ||v.action_consents.some((a,i)=>{const old=p.source.action_consents[i]!;return ['action_binding_id','action_key','authority_epoch','consent_id'].some(k=>a[k as keyof typeof a]!==old[k as keyof typeof old])
    ||appConsentDeadline(a.expires_at,a.consent_lifetime)<=appConsentDeadline(old.expires_at,old.consent_lifetime)||appConsentDeadline(a.expires_at,a.consent_lifetime)>deadline(v.scope)||a.consent_digest===old.consent_digest;}))fail();
  return v;
 }
 function nomination(t:ConsentContinuationTarget){const local=read(t.target_key);if(local&&(local.phase!=='resolved'||!t.pending||t.pending.session_id===local.session_id))return local;
  if(!t.pending)return null;const v=t.pending.review;return pointer.parse({schema_version:'deft.app_consent_continuation_pending.v1',identity:owner,target_key:t.target_key,
   session_id:t.pending.session_id,source:t.source,account:t.account,...choice(t.pending),
   phase:t.pending.activation_started?'uncertain':v?'reviewed':'reviewing',review:v});
 }
 async function exclusively<T>(work:()=>Promise<T>){current();if(busy)fail();busy=true;try{return await work();}finally{busy=false;}}
 function acceptResult(raw:unknown,t:ConsentContinuationTarget,p:Pointer){const v=result.parse(raw);
  if(v.session_id!==p.session_id||v.scope.org_id!==owner.orgId||v.scope.owner_user_id!==owner.ownerId||v.scope.installation_id!==owner.installationId||v.scope.target_key!==t.target_key
   ||Object.keys(p.source.scope).some(k=>!['consent_expires_at','consent_lifetime'].includes(k)&&v.scope[k as keyof typeof v.scope]!==p.source.scope[k as keyof typeof p.source.scope])
   ||!sameChoice(v.scope,p)||p.review&&!same(v.scope,p.review.scope)
   ||v.state==='connected'&&(!v.account||!same(v.account,p.account))||!['connected','not_connected','indeterminate'].includes(v.state))fail();
  write({...p,phase:v.state==='connected'||v.state==='not_connected'?'resolved':'uncertain'});return v;
 }
 return {
  async load(){current();const next=context.parse(await ports.get());current();
   if(next.installation_id!==owner.installationId||next.org_id!==owner.orgId||next.owner_user_id!==owner.ownerId||new Set(next.targets.map(t=>t.target_key)).size!==next.targets.length)fail();
   for(const t of next.targets){if(t.source.scope.org_id!==owner.orgId||t.source.scope.owner_user_id!==owner.ownerId||t.source.scope.installation_id!==owner.installationId||t.source.scope.target_key!==t.target_key||t.account.account_ref!==t.source.account_ref)fail();
    if(t.pending&&(deadline(t.pending)<=deadline(t.source.scope)||deadline(t.pending)>ceiling(t,t.pending)||t.pending.review&&!sameChoice(t.pending.review.scope,t.pending)))fail();
    const local=read(t.target_key);if(local&&local.phase!=='resolved'&&t.pending&&t.pending.session_id===local.session_id){
     if(!sameChoice(t.pending,local))fail();
     if(t.pending.activation_started)write({...local,phase:'uncertain'});
     else if(t.pending.review&&!['activating','uncertain'].includes(local.phase)){const v=checkedReview(t.pending.review,t,local);write({...local,phase:'reviewed',review:v});}
    }
   }value=next;return next;
  },
  pending(targetKey:string){return nomination(chosen(targetKey));},
  visibleReview(targetKey:string){const t=chosen(targetKey),p=nomination(t);return p?.phase==='reviewed'&&p.review&&Date.parse(p.review.expires_at)>now()
   &&!(t.pending?.session_id===p.session_id&&t.pending.state==='not_connected')?checkedReview(p.review,t,p):null;},
  canReview(targetKey:string){const t=chosen(targetKey),p=nomination(t);if(!t.runtime_ready||Math.max(Date.parse(t.max_consent_expires_at),t.allow_until_revoked===true?Infinity:0)<=Math.max(now(),deadline(t.source.scope)))return false;
   if(!p||p.phase==='resolved')return true;
   // Time alone never clears an attempted activation. The fresh Host context
   // must explicitly identify this unstarted review as expired/closed.
   return !['activating','uncertain'].includes(p.phase)&&!!t.pending&&t.pending.session_id===p.session_id&&!t.pending.activation_started&&t.pending.state==='not_connected';
  },
  async prepare(targetKey:string,input:string|ConsentContinuationChoice){return exclusively(async()=>{const t=chosen(targetKey),selected=choice(typeof input==='string'?{consent_expires_at:input}:input);if(!this.canReview(targetKey)||deadline(selected)<=Math.max(now(),deadline(t.source.scope))||deadline(selected)>ceiling(t,selected))fail();
   const p=pointer.parse({schema_version:'deft.app_consent_continuation_pending.v1',identity:owner,target_key:targetKey,session_id:(ports.uuid??(()=>crypto.randomUUID()))(),source:t.source,account:t.account,...selected,phase:'reviewing',review:null});write(p);
   const raw=await ports.post('review',{installation_id:owner.installationId,target_key:targetKey,source_session_id:t.source.session_id,request_id:p.session_id,...selected});current();const v=checkedReview(raw,t,p);write({...p,phase:'reviewed',review:v});return v;
  });},
  async activate(targetKey:string){return exclusively(async()=>{const t=chosen(targetKey),p=nomination(t),v=this.visibleReview(targetKey);if(!p||!v||p.phase!=='reviewed'||t.pending?.activation_started)fail();write({...p,phase:'activating'});
   const raw=await ports.post('activate',{session_id:p.session_id,review_digest:v.review_digest});current();return acceptResult(raw,t,p);
  });},
  async check(targetKey:string){return exclusively(async()=>{const t=chosen(targetKey),p=nomination(t);if(!p||p.phase==='resolved')fail();
   const raw=await ports.post('status',{session_id:p.session_id});current();return acceptResult(raw,t,p);
  });},
  dispose(){disposed=true;value=null;},
 };
}
