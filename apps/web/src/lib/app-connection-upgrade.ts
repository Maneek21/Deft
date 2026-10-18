import {appConsentDeadline} from '../../../../packages/app-kit/src/consent-lifetime';
import {appConnectionReattachmentMetadata} from './app-connection-reattachment';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data';
import {AppConnectionUpgradeContextSchema,type AppConnectionUpgradeContext} from '../../../../packages/app-kit/src/connection-session-upgrade-context';
import {AppConnectionUpgradeReviewViewSchema,AppConnectionUpgradeBegunSchema,AppConnectionUpgradeClosedViewSchema} from '../../../../packages/app-kit/src/connection-session-upgrade';
import {AppConnectionSessionViewSchema,AppConnectionSessionCallbackSchema} from '../../../../packages/app-kit/src/connection-session';
import type {AppConnectionIdentity,AppConnectionTarget} from './app-connection-session-flow';
export const APP_CONNECTION_UPGRADE_PENDING_KEY='deft.app-connection-upgrade.oauth.v1';
export type ConnectionUpgradeReview=ReturnType<typeof AppConnectionUpgradeReviewViewSchema.parse>;
export type ConnectionUpgradeMetadata=AppConnectionUpgradeContext['targets'][number]['upgrade'];
const same=(a:unknown,b:unknown)=>canonicalAppDataJson(a)===canonicalAppDataJson(b),account=AppConnectionSessionViewSchema.shape.account.unwrap();
type Intent={schema_version:'deft.app_connection_upgrade_pending.v1';identity:AppConnectionIdentity;target_key:string;session_id:string;scope:AppConnectionTarget['scope'];
 source_session_id:string|null;source_revision:number|null;account:ReturnType<typeof account.parse>|null;phase:'reviewing'|'reviewed'|'starting'|'awaiting'|'consumed'|'resolved'};
function parseIntent(raw:unknown):Intent{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail();const value=raw as Record<string,unknown>;
 if(Object.keys(value).sort().join(',')!=='account,identity,phase,schema_version,scope,session_id,source_revision,source_session_id,target_key'||value.schema_version!=='deft.app_connection_upgrade_pending.v1'
  ||typeof value.target_key!=='string'||!/^[a-z][a-z0-9_]{0,47}$/u.test(value.target_key)||typeof value.phase!=='string'||!['reviewing','reviewed','starting','awaiting','consumed','resolved'].includes(value.phase))fail();
 const i=value.identity as AppConnectionIdentity;if(!i||typeof i!=='object'||Object.keys(i).sort().join(',')!=='experienceKey,installationId,orgId,ownerId,sessionTag'||typeof i.experienceKey!=='string'||!/^[a-z][a-z0-9_]{0,47}$/u.test(i.experienceKey)||typeof i.sessionTag!=='string'||!/^[a-f0-9]{64}$/u.test(i.sessionTag))fail();
 for(const id of [i.installationId,i.orgId,i.ownerId,value.session_id])AppConnectionSessionViewSchema.shape.session_id.parse(id);
 AppConnectionSessionViewSchema.shape.scope.parse(value.scope);if(value.source_session_id!==null)AppConnectionSessionViewSchema.shape.session_id.parse(value.source_session_id);
 if(value.source_revision!==null&&(!Number.isInteger(value.source_revision)||(value.source_revision as number)<0||(value.source_revision as number)>2147483646))fail();if(value.account!==null)account.parse(value.account);
 return value as unknown as Intent;
}
function parseOAuth(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail();const {state,expires_at,...intent}=raw as Record<string,unknown>,value=parseIntent(intent);
 AppConnectionSessionCallbackSchema.options[0].shape.state.parse(state);AppConnectionSessionViewSchema.shape.expires_at.parse(expires_at);
 return {...value,state:state as string,expires_at:expires_at as string};
}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
function fail():never{throw Error('Account update was not confirmed. Check status before continuing.');}
export function parseConnectionUpgradeContext(raw:unknown,identity:AppConnectionIdentity){
 const value=AppConnectionUpgradeContextSchema.parse(raw);
 if(value.installation_id!==identity.installationId||value.org_id!==identity.orgId||value.owner_user_id!==identity.ownerId)fail();
 for(const target of value.targets){
  if(target.reattachment)target.reattachment=appConnectionReattachmentMetadata(target.reattachment,target);
  if(target.profile.label.length>200||/[\u0000-\u001f\u007f<>]/u.test(target.profile.label)||target.profile.authorization_origin.length>512
   ||target.session?.state==='connected'&&!target.session.account||target.session&&target.session.state!=='connected'&&target.session.state!=='indeterminate'&&target.session.account
   ||target.session&&appConsentDeadline(target.session.expires_at,target.session.expires_at===null?target.session.scope.consent_lifetime:undefined)>appConsentDeadline(target.scope.consent_expires_at,target.scope.consent_lifetime))fail();
 }
 return value;
}
function stored(storage:StoragePort,key:string){const value=storage.getItem(key);if(!value)return null;if(value.length>16384)fail();return JSON.parse(value);}
type Ports={identity:AppConnectionIdentity;storage:StoragePort;current:()=>void;target:(key:string)=>AppConnectionTarget;
 post:(operation:string,body:unknown)=>Promise<unknown>;now?:()=>number};
/** A current-context nomination and a browser acknowledgement fence, never stored authority. */
export function createConnectionUpgradeFlow(ports:Ports){
 let busy=false;const now=()=>ports.now?.()??Date.now(),key=(target:AppConnectionTarget)=>'deft.app-connection-upgrade.pending.v1:'+JSON.stringify([ports.identity,target.target_key,target.scope]);
 const write=(target:AppConnectionTarget,value:Intent)=>ports.storage.setItem(key(target),JSON.stringify(value));
 function read(target:AppConnectionTarget):Intent|null{
  const raw=stored(ports.storage,key(target));if(!raw)return null;const value=parseIntent(raw);
  if(!same(value.identity,ports.identity)||value.target_key!==target.target_key||!same(value.scope,target.scope))fail();return value;
 }
 function pending(target:AppConnectionTarget):Intent|null{
  const local=read(target);if(local&&local.phase!=='resolved'){
   if(target.session?.session_id===local.session_id&&same(target.session.scope,local.scope)&&target.session.state==='connected'&&target.session.account&&local.account&&same(target.session.account,local.account)){write(target,{...local,phase:'resolved'});return null;}
   return local;}
  const value=target.upgrade?.pending;if(!value)return null;const review=value.review;
  return {schema_version:'deft.app_connection_upgrade_pending.v1',identity:ports.identity,target_key:target.target_key,session_id:value.session_id,scope:target.scope,
   source_session_id:review?.source_session_id??null,source_revision:review?.source_revision??null,account:review?.account??target.session?.account??null,
   phase:value.callback_consumed?'consumed':value.begin_consumed?'starting':review?'reviewed':'reviewing'};
 }
 function ready(target:AppConnectionTarget){ports.current();if(!target.upgrade||!target.runtime_ready||appConsentDeadline(target.scope.consent_expires_at,target.scope.consent_lifetime)<=now())fail();}
 function accept(raw:unknown,target:AppConnectionTarget,expected:Intent,allowReview:boolean){
  if((raw as {schema_version?:string})?.schema_version==='deft.app_connection_upgrade_review.v1'){
   const value=AppConnectionUpgradeReviewViewSchema.parse(raw);
   if(!allowReview||['starting','awaiting','consumed'].includes(expected.phase)||target.upgrade?.pending?.begin_consumed||value.session_id!==expected.session_id
    ||!same(value.scope,target.scope)||expected.source_session_id!==null&&value.source_session_id!==expected.source_session_id||expected.source_revision!==null&&value.source_revision!==expected.source_revision
    ||expected.account&&!same(value.account,expected.account)||Date.parse(value.expires_at)>appConsentDeadline(target.scope.consent_expires_at,target.scope.consent_lifetime))fail();
   target.upgrade={candidate:null,pending:{session_id:value.session_id,state:'upgrade_reviewed',begin_consumed:false,callback_consumed:false,review:value}};
   target.session={schema_version:'deft.app_connection_session.v1',session_id:value.session_id,state:'indeterminate',scope:value.scope,account:null,expires_at:value.scope.consent_expires_at};
   write(target,{...expected,source_session_id:value.source_session_id,source_revision:value.source_revision,account:value.account,phase:'reviewed'});return value;
  }
  let verifiedClosure=false;
  if((raw as {schema_version?:string})?.schema_version==='deft.app_connection_upgrade_closed.v1'){
   const closed=AppConnectionUpgradeClosedViewSchema.parse(raw);
   if(expected.phase==='consumed'||target.upgrade?.pending?.callback_consumed||Date.parse(closed.review_expires_at)>now()
    ||expected.source_session_id!==null&&closed.source_session_id!==expected.source_session_id
    ||expected.source_revision!==null&&closed.source_revision!==expected.source_revision||expected.account&&closed.account_ref!==expected.account.account_ref)fail();
   raw={schema_version:'deft.app_connection_session.v1',session_id:closed.session_id,scope:closed.scope,state:closed.state,account:null,expires_at:closed.expires_at};verifiedClosure=true;
  }
  const value=AppConnectionSessionViewSchema.parse(raw);
  if(value.session_id!==expected.session_id||!same(value.scope,target.scope)||appConsentDeadline(value.expires_at,value.expires_at===null?value.scope.consent_lifetime:undefined)>appConsentDeadline(target.scope.consent_expires_at,target.scope.consent_lifetime)
   ||value.state==='connected'&&!value.account||value.state!=='connected'&&value.state!=='indeterminate'&&value.account
   ||expected.account&&value.account&&!same(value.account,expected.account)
   ||['starting','awaiting','consumed'].includes(expected.phase)&&value.state==='not_connected'&&!verifiedClosure)fail();
  target.session=value;write(target,{...expected,phase:['connected','not_connected','disconnected'].includes(value.state)?'resolved':expected.phase});
  if(['connected','not_connected','disconnected'].includes(value.state)){target.upgrade={candidate:null,pending:null};
   const raw=stored(ports.storage,APP_CONNECTION_UPGRADE_PENDING_KEY);if(raw){const oauth=parseOAuth(raw);if(oauth.session_id===value.session_id&&same(oauth.identity,ports.identity))ports.storage.removeItem(APP_CONNECTION_UPGRADE_PENDING_KEY);}}
  return value;
 }
 return {
  unresolved(targetKey:string){ports.current();return !!pending(ports.target(targetKey));},
  reviewView(targetKey:string):ConnectionUpgradeReview|null{ports.current();const target=ports.target(targetKey),intent=pending(target),value=target.upgrade?.pending?.review??null;
   if(intent&&['starting','awaiting','consumed'].includes(intent.phase)||target.upgrade?.pending?.begin_consumed)return null;
   if(value&&(value.session_id!==intent?.session_id||!same(value.scope,target.scope)||intent?.account&&!same(value.account,intent.account)))fail();return value;},
  async review(targetKey:string){
   ports.current();if(busy||stored(ports.storage,APP_CONNECTION_UPGRADE_PENDING_KEY))fail();const target=ports.target(targetKey);ready(target);
   const candidate=target.upgrade?.candidate;if(!candidate||pending(target))fail();
   const expected:Intent={schema_version:'deft.app_connection_upgrade_pending.v1',identity:ports.identity,target_key:targetKey,session_id:crypto.randomUUID(),scope:target.scope,
    source_session_id:candidate.source_session_id,source_revision:candidate.source_revision,account:candidate.account,phase:'reviewing'};write(target,expected);busy=true;
   try{const raw=await ports.post('upgrade/review',{installation_id:ports.identity.installationId,target_key:targetKey,source_session_id:candidate.source_session_id,request_id:expected.session_id});
    ready(target);if(!same(ports.target(targetKey).scope,target.scope))fail();return accept(raw,target,expected,true);}finally{busy=false;}
  },
  async begin(targetKey:string){
   ports.current();if(busy||stored(ports.storage,APP_CONNECTION_UPGRADE_PENDING_KEY))fail();const target=ports.target(targetKey);ready(target);
   const value=this.reviewView(targetKey),intent=pending(target);if(!value||!intent||intent.phase!=='reviewed'||Date.parse(value.expires_at)<=now())fail();
   const expected:Intent={...intent,phase:'starting'};write(target,expected);target.upgrade={candidate:null,pending:{session_id:expected.session_id,state:'upgrade_starting',begin_consumed:true,callback_consumed:false,review:null}};busy=true;
   try{const raw=await ports.post('upgrade/begin',{session_id:expected.session_id,review_digest:value.review_digest});ready(target);
    const begun=AppConnectionUpgradeBegunSchema.parse(raw),url=new URL(begun.authorization_url);
    if(begun.session_id!==expected.session_id||!same(begun.scope,target.scope)||!same(ports.target(targetKey).scope,target.scope)||begun.account!==null
     ||typeof begun.expires_at!=='string'||Date.parse(begun.expires_at)<=now()||Date.parse(begun.expires_at)>appConsentDeadline(target.scope.consent_expires_at,target.scope.consent_lifetime)||url.origin!==target.profile.authorization_origin||url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==begun.callback_state)fail();
    const pointer={...expected,phase:'awaiting' as const,state:begun.callback_state,expires_at:begun.expires_at};ports.storage.setItem(APP_CONNECTION_UPGRADE_PENDING_KEY,JSON.stringify(pointer));write(target,{...expected,phase:'awaiting'});
    target.session={schema_version:'deft.app_connection_session.v1',session_id:begun.session_id,state:begun.state,scope:begun.scope,account:null,expires_at:begun.expires_at};return url.href;
   }finally{busy=false;}
  },
  async check(targetKey:string){
   ports.current();if(busy)fail();const target=ports.target(targetKey);ready(target);const expected=pending(target);if(!expected)fail();write(target,expected);busy=true;
   try{const raw=await ports.post('upgrade/status',{session_id:expected.session_id});ready(target);if(!same(ports.target(targetKey).scope,target.scope))fail();return accept(raw,target,expected,true);}finally{busy=false;}
  },
 };
}
type CallbackPorts={identity:AppConnectionIdentity;storage:StoragePort;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;search:string;now?:()=>number};
async function json(ports:CallbackPorts,path:string,body?:unknown,max=65536){
 if(!ports.current())fail();const response=await ports.fetch(path,{signal:AbortSignal.timeout(35000),cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 if(!response.ok||!response.body||!ports.current())fail();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
 try{for(;;){const row=await reader.read();if(!ports.current())fail();if(row.done)break;size+=row.value.length;if(size>max)fail();parts.push(row.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const row of parts){bytes.set(row,offset);offset+=row.length;}
  try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
 }finally{parts.forEach(row=>row.fill(0));await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function completeConnectionUpgrade(ports:CallbackPorts){
 if(!ports.current())fail();const pointer=parseOAuth(stored(ports.storage,APP_CONNECTION_UPGRADE_PENDING_KEY));
 if(!same(pointer.identity,ports.identity)||!['awaiting','consumed'].includes(pointer.phase)||Date.parse(pointer.expires_at)<=(ports.now?.()??Date.now()))fail();
 const params=new URLSearchParams(ports.search),allowed=new Set(['state','code','error','scope','authuser','prompt','iss','error_description','error_uri']);
 for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)fail();
 if(pointer.phase==='awaiting'&&(params.get('state')!==pointer.state||Boolean(params.get('code'))===Boolean(params.get('error'))||params.get('error')&&!/^[a-zA-Z0-9_.-]{1,128}$/u.test(params.get('error')!)))fail();
 const context=parseConnectionUpgradeContext(await json(ports,'/api/app-connection-sessions/installations/'+encodeURIComponent(ports.identity.installationId)+'/upgrade-context',undefined,262144),ports.identity),target=context.targets.find(t=>t.target_key===pointer.target_key);
 if(!target?.runtime_ready||!same(target.scope,pointer.scope)||target.session?.session_id!==pointer.session_id
  ||target.session.account&&pointer.account&&!same(target.session.account,pointer.account))fail();
 let raw:unknown;
 if(pointer.phase==='awaiting'&&target.session.state==='awaiting_callback'){
  ports.storage.setItem(APP_CONNECTION_UPGRADE_PENDING_KEY,JSON.stringify({...pointer,phase:'consumed'}));
  raw=await json(ports,'/api/app-connection-sessions/upgrade/callback',AppConnectionSessionCallbackSchema.parse({session_id:pointer.session_id,state:pointer.state,...(params.get('code')?{outcome:'authorized',code:params.get('code')}:{outcome:'denied'})}));
 }else raw=await json(ports,'/api/app-connection-sessions/upgrade/status',{session_id:pointer.session_id});
 const result=AppConnectionSessionViewSchema.parse(raw);
 if(!ports.current()||result.session_id!==pointer.session_id||!same(result.scope,pointer.scope)||result.state==='connected'&&!result.account
  ||result.state!=='connected'&&result.state!=='indeterminate'&&result.account
  ||result.account&&pointer.account&&!same(result.account,pointer.account)||appConsentDeadline(result.expires_at,result.expires_at===null?result.scope.consent_lifetime:undefined)>appConsentDeadline(pointer.scope.consent_expires_at,pointer.scope.consent_lifetime))fail();
 if(['connected','not_connected','disconnected'].includes(result.state))ports.storage.removeItem(APP_CONNECTION_UPGRADE_PENDING_KEY);
 return result;
}
