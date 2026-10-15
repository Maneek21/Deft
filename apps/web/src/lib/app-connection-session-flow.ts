import {appConsentDeadline} from '../../../../packages/app-kit/src/consent-lifetime';
import {parseConnectionUpgradeContext,createConnectionUpgradeFlow,type ConnectionUpgradeMetadata} from './app-connection-upgrade';
import {createConnectionRepairFlow,type ConnectionRepairMetadata} from './app-connection-repair';
import { appConnectionReattachmentMetadata, createAppConnectionReattachmentFlow, type AppConnectionReattachmentMetadata } from './app-connection-reattachment';
import { AppConnectionSessionViewSchema, AppConnectionSessionScopeSchema, AppConnectionSessionBegunSchema, AppConnectionSessionCallbackSchema,
 type AppConnectionSessionView } from '../../../../packages/app-kit/src/connection-session';

export const APP_CONNECTION_SESSION_PENDING_KEY='deft.app-connection-session.pending.v1';
/** Select a protocol only after independent native/legacy pending validation.
 * An own generic nonce always stays on its strict generic path, even if the
 * pointer is malformed. An unrelated, exact native nonce may coexist. */
export function appConnectionCallbackUsesGeneric(search:string,stored:string|null,nativeMatches:boolean,legacyMatches:boolean){
 if(!stored)return false;let state:unknown=null;
 try{if(stored.length<=8192)state=object(JSON.parse(stored)).state;}catch{/* Invalid generic intent never grants fallback. */}
 const params=new URLSearchParams(search);
 return typeof state==='string'&&params.get('state')===state||!nativeMatches&&!legacyMatches;
}
export type AppConnectionIdentity={installationId:string;experienceKey:string;orgId:string;ownerId:string;sessionTag:string};
type Profile={key:string;label:string;authorization_origin:string};
export type AppConnectionTarget={target_key:string;profile:Profile;scope:AppConnectionSessionView['scope'];runtime_ready:boolean;session:AppConnectionSessionView|null;reattachment?:AppConnectionReattachmentMetadata;upgrade?:ConnectionUpgradeMetadata;credential_repair?:ConnectionRepairMetadata};
export type AppConnectionContext={schema_version:'deft.app_connection_context.v1';installation_id:string;org_id:string;owner_user_id:string;targets:AppConnectionTarget[]};
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Ports={identity:AppConnectionIdentity;storage:StoragePort;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;includeUpgrades?:boolean;now?:()=>number};
type Pending=AppConnectionIdentity&{schema_version:'deft.app_connection_pending.v1';targetKey:string;phase:'starting'|'awaiting_callback'|'consumed';connectionSessionId:string|null;scope:AppConnectionSessionView['scope']|null;state:string|null;expiresAt:string;accountRef:string|null;protocol?:'v2'};
function fail():never{throw Error('Account setup changed or was not confirmed. Check its status before starting again.');}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const exact=(v:Record<string,unknown>,keys:string)=>{if(Object.keys(v).sort().join(',')!==keys.split(',').sort().join(','))fail();};
const key=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,47}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const validIdentity=(i:AppConnectionIdentity)=>{if(!uuid(i.installationId)||!uuid(i.orgId)||!uuid(i.ownerId)||!key(i.experienceKey)||!/^[a-f0-9]{64}$/.test(i.sessionTag))fail();};
export async function appConnectionSessionTag(scope:string){
 const parts=scope.split(':').map(decodeURIComponent);if(parts.length!==4||!parts[0]||!parts[1]||!parts[2]||parts[2]==='legacy')fail();
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts.slice(0,3))));
 return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
}
function sessionView(raw:unknown,identity:AppConnectionIdentity,targetKey:string,expected?:AppConnectionSessionView){
 const value=AppConnectionSessionViewSchema.parse(raw);
 if(value.scope.org_id!==identity.orgId||value.scope.owner_user_id!==identity.ownerId||value.scope.installation_id!==identity.installationId||value.scope.target_key!==targetKey
  ||value.state==='connected'&&!value.account||value.state!=='connected'&&value.state!=='indeterminate'&&!!value.account||appConsentDeadline(value.expires_at,value.expires_at===null?value.scope.consent_lifetime:undefined)>appConsentDeadline(value.scope.consent_expires_at,value.scope.consent_lifetime)
  ||expected&&(value.session_id!==expected.session_id||!equal(value.scope,expected.scope)||expected.account&&value.account&&value.account.account_ref!==expected.account.account_ref))fail();
 return value;
}
export function appConnectionContext(raw:unknown,identity:AppConnectionIdentity):AppConnectionContext{
 validIdentity(identity);const row=object(raw);exact(row,'schema_version,installation_id,org_id,owner_user_id,targets');
 if(row.schema_version!=='deft.app_connection_context.v1'||row.installation_id!==identity.installationId||row.org_id!==identity.orgId||row.owner_user_id!==identity.ownerId||!Array.isArray(row.targets)||row.targets.length>32)fail();
 const targets=row.targets.map(raw=>{const target=object(raw);exact(target,'target_key,profile,scope,runtime_ready,session'+('reattachment' in target?',reattachment':''));if(!key(target.target_key)||typeof target.runtime_ready!=='boolean')fail();
  const p=object(target.profile);exact(p,'key,label,authorization_origin');if(!key(p.key)||typeof p.label!=='string'||!p.label.trim()||p.label.length>200||/[\x00-\x1f\x7f<>]/.test(p.label)||typeof p.authorization_origin!=='string'||p.authorization_origin.length>512)fail();
  const url=new URL(p.authorization_origin);if(url.protocol!=='https:'||url.origin!==p.authorization_origin||url.username||url.password)fail();
  const scope=AppConnectionSessionScopeSchema.parse(target.scope);
  sessionView({schema_version:'deft.app_connection_session.v1',session_id:identity.installationId,state:'not_connected',scope,expires_at:scope.consent_expires_at,account:null},identity,target.target_key);
  const session=target.session===null?null:sessionView(target.session,identity,target.target_key);
  if(session&&!equal(session.scope,scope))fail();
  const parsed:AppConnectionTarget={target_key:target.target_key,profile:p as Profile,scope,runtime_ready:target.runtime_ready,session};
  if('reattachment' in target)parsed.reattachment=appConnectionReattachmentMetadata(target.reattachment,parsed);
  return parsed;
 });if(new Set(targets.map(t=>t.target_key)).size!==targets.length)fail();return {...row,targets} as AppConnectionContext;
}
function readPending(ports:Ports):Pending|null{
 const stored=ports.storage.getItem(APP_CONNECTION_SESSION_PENDING_KEY);if(!stored)return null;if(stored.length>8192)fail();
 const p=object(JSON.parse(stored));exact(p,'schema_version,installationId,experienceKey,orgId,ownerId,sessionTag,targetKey,phase,connectionSessionId,scope,state,expiresAt,accountRef'+('protocol' in p?',protocol':''));
 if(p.protocol!==undefined&&p.protocol!=='v2')fail();
 if(p.schema_version!=='deft.app_connection_pending.v1'||!key(p.targetKey)||!['starting','awaiting_callback','consumed'].includes(String(p.phase))||!iso(p.expiresAt)
  ||Object.entries(ports.identity).some(([k,v])=>p[k]!==v)||p.accountRef!==null&&(typeof p.accountRef!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(p.accountRef)))fail();
 if(p.phase==='starting'){if(p.connectionSessionId!==null||p.scope!==null||p.state!==null||p.accountRef!==null)fail();}
 else{if(!uuid(p.connectionSessionId)||typeof p.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(p.state))fail();
  sessionView({schema_version:'deft.app_connection_session.v1',session_id:p.connectionSessionId,state:'awaiting_callback',scope:p.scope,expires_at:p.expiresAt,account:null},ports.identity,p.targetKey);
 }return p as Pending;
}
const check=(ports:Ports)=>{validIdentity(ports.identity);if(!ports.current())throw Error('Account setup access ended.');};
async function json(ports:Ports,path:string,init:RequestInit,maxBytes=65536){
 check(ports);const response=await ports.fetch(path,{...init,cache:'no-store',signal:AbortSignal.timeout(35_000)});check(ports);
 if(!response.ok||!response.body)fail();const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const next=await reader.read();check(ports);if(next.done)break;size+=next.value.length;if(size>maxBytes)fail();chunks.push(next.value);}
  const bytes=new Uint8Array(size);let n=0;for(const chunk of chunks){bytes.set(chunk,n);n+=chunk.length;}return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)) as unknown;
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
const post=(ports:Ports,operation:string,body:unknown)=>json(ports,`/api/app-connection-sessions/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
// Up to32 closed metadata rows repeat exact target/session scopes. Unicode
// labels can exceed128KiB; mutation responses retain their separate64KiB cap.
async function context(ports:Ports){
 const base=appConnectionContext(await json(ports,`/api/app-connection-sessions/installations/${encodeURIComponent(ports.identity.installationId)}/context`,{method:'GET'},262144),ports.identity);
 if(!ports.includeUpgrades)return base;
 const upgraded=parseConnectionUpgradeContext(await json(ports,`/api/app-connection-sessions/installations/${encodeURIComponent(ports.identity.installationId)}/upgrade-context`,{method:'GET'},262144),ports.identity);
 if(base.targets.length+upgraded.targets.length>32||upgraded.targets.some(target=>base.targets.some(existing=>existing.target_key===target.target_key)))fail();
 return {...base,targets:[...base.targets,...upgraded.targets]};
}
function callback(search:string,p:Pending){
 const params=new URLSearchParams(search),allowed=new Set(['state','code','error','scope','authuser','prompt','iss','error_description','error_uri']);
 for(const k of params.keys())if(!allowed.has(k)||params.getAll(k).length!==1)fail();
 if(params.get('state')!==p.state||Boolean(params.get('code'))===Boolean(params.get('error'))||params.get('error')&&!/^[a-zA-Z0-9_.-]{1,128}$/.test(params.get('error')!))fail();
 return AppConnectionSessionCallbackSchema.parse({session_id:p.connectionSessionId,state:p.state,...(params.get('code')?{outcome:'authorized',code:params.get('code')}:{outcome:'denied'})});
}
export async function completeAppConnectionSession(ports:Ports&{search:string}){
 check(ports);const pending=readPending(ports);if(!pending||pending.phase==='starting'||!pending.connectionSessionId||Date.parse(pending.expiresAt)<=(ports.now?.()??Date.now()))fail();
 const body=pending.phase==='awaiting_callback'?callback(ports.search,pending):null;
 const ctx=await context({...ports,includeUpgrades:pending.protocol==='v2'}),target=ctx.targets.find(t=>t.target_key===pending.targetKey),current=target?.session;
 if(!target?.runtime_ready||Boolean(target.upgrade)!==(pending.protocol==='v2')||!current||current.session_id!==pending.connectionSessionId||!equal(current.scope,pending.scope)||pending.accountRef&&current.account&&pending.accountRef!==current.account.account_ref
  ||pending.phase==='awaiting_callback'&&current.state==='awaiting_callback'&&current.expires_at!==pending.expiresAt)fail();
 let value:AppConnectionSessionView;
 if(body&&current.state==='awaiting_callback'){check(ports);ports.storage.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify({...pending,phase:'consumed'}));
  value=sessionView(await post(ports,pending.protocol==='v2'?'v2/callback':'callback',body),ports.identity,pending.targetKey,current);
 }else value=sessionView(await post(ports,'status',{session_id:pending.connectionSessionId}),ports.identity,pending.targetKey,current);
 check(ports);
 if(['connected','not_connected','disconnected'].includes(value.state))ports.storage.removeItem(APP_CONNECTION_SESSION_PENDING_KEY);
 else ports.storage.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify({...pending,phase:'consumed',accountRef:value.account?.account_ref??pending.accountRef}));
 return value;
}
export function createAppConnectionSessionFlow(ports:Ports){
 let ctx:AppConnectionContext|null=null,busy=false,disposed=false;
 const current=()=>{if(disposed)throw Error('Account setup access ended.');check(ports);};
 const target=(key:string)=>ctx?.targets.find(t=>t.target_key===key)??fail();
 const upgrade=createConnectionUpgradeFlow({...ports,current,target,post:(operation,input)=>post({...ports,current:()=>!disposed&&ports.current()},operation,input)});
 const repair=createConnectionRepairFlow({...ports,current,target,post:(operation,input)=>post({...ports,current:()=>!disposed&&ports.current()},operation,input)});
 const reuse=createAppConnectionReattachmentFlow({...ports,current,target,post:(operation,input)=>post({...ports,current:()=>!disposed&&ports.current()},operation,input)});
 return {
  reviewRepair:(key:string)=>repair.review(key),beginRepair:(key:string)=>repair.begin(key),checkRepair:(key:string,cancel=false,closeUncertain=false)=>repair.check(key,cancel,closeUncertain),repairReview:(key:string)=>repair.reviewView(key),repairPending:(key:string)=>repair.unresolved(key),
  reviewUpgrade:(key:string)=>upgrade.review(key),beginUpgrade:(key:string)=>upgrade.begin(key),checkUpgrade:(key:string)=>upgrade.check(key),upgradeReview:(key:string)=>upgrade.reviewView(key),upgradePending:(key:string)=>upgrade.unresolved(key),
  reviewExisting:async(key:string)=>{current();if(busy)fail();const pending=readPending(ports),chosen=target(key);
   if(pending){
    // A fresh host nomination can replace only this exact expired, unconsumed
    // OAuth pointer. Unknown/consumed callbacks never become a reuse grant.
    if(!chosen.reattachment?.candidate||pending.phase!=='awaiting_callback'||pending.targetKey!==key
      ||pending.connectionSessionId!==chosen.session?.session_id||!equal(pending.scope,chosen.scope)
      ||pending.expiresAt!==chosen.session.expires_at||Date.parse(pending.expiresAt)>(ports.now?.()??Date.now()))fail();
    ports.storage.removeItem(APP_CONNECTION_SESSION_PENDING_KEY);
   }
   return reuse.review(key);},activateExisting:(key:string)=>reuse.activate(key),checkExisting:(key:string)=>reuse.check(key),existingReview:(key:string)=>reuse.reviewView(key),existingPending:(key:string)=>reuse.unresolved(key),
  dispose(){disposed=true;},
  async load(){current();const value=await context({...ports,current:()=>!disposed&&ports.current()});current();ctx=value;return value;},
  async begin(targetKey:string){current();if(busy)fail();const chosen=target(targetKey),pending=readPending(ports);
   if(pending||reuse.unresolved(targetKey)||repair.unresolved(targetKey)||chosen.upgrade&&upgrade.unresolved(targetKey)||!chosen.runtime_ready||chosen.session&&!['not_connected','disconnected'].includes(chosen.session.state)||appConsentDeadline(chosen.scope.consent_expires_at,chosen.scope.consent_lifetime)<=(ports.now?.()??Date.now()))fail();
   const intent:Pending={...ports.identity,schema_version:'deft.app_connection_pending.v1',targetKey,phase:'starting',connectionSessionId:null,scope:null,state:null,expiresAt:new Date((ports.now?.()??Date.now())+600_000).toISOString(),accountRef:null,...(chosen.upgrade?{protocol:'v2' as const}:{})};
   // A lost Begin acknowledgement remains fenced. Context discovers the host's
   // durable session; absence after an uncertain attempt is not retry consent.
   ports.storage.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify(intent));busy=true;
   try{const raw=await post(ports,chosen.upgrade?'v2/begin':'begin',{installation_id:ports.identity.installationId,target_key:targetKey});current();const begun=AppConnectionSessionBegunSchema.parse(raw);
    if(typeof begun.expires_at!=='string')fail();const view=sessionView({schema_version:begun.schema_version,session_id:begun.session_id,state:begun.state,scope:begun.scope,expires_at:begun.expires_at,account:begun.account},ports.identity,targetKey);
    const url=new URL(begun.authorization_url);if(!equal(begun.scope,chosen.scope)||url.origin!==chosen.profile.authorization_origin||url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==begun.callback_state||Date.parse(begun.expires_at)<=(ports.now?.()??Date.now()))fail();
    ports.storage.setItem(APP_CONNECTION_SESSION_PENDING_KEY,JSON.stringify({...intent,phase:'awaiting_callback',connectionSessionId:begun.session_id,scope:begun.scope,state:begun.callback_state,expiresAt:begun.expires_at}));chosen.session=view;return url.href;
   }finally{busy=false;}
  },
  async check(targetKey:string){current();if(busy||reuse.unresolved(targetKey)||repair.unresolved(targetKey)||target(targetKey).upgrade&&upgrade.unresolved(targetKey))fail();const chosen=target(targetKey);if(!chosen.session)fail();busy=true;
   try{const value=sessionView(await post(ports,'status',{session_id:chosen.session.session_id}),ports.identity,targetKey,chosen.session);current();chosen.session=value;
    const pending=readPending(ports);if(pending?.targetKey===targetKey&&pending.connectionSessionId===value.session_id&&['connected','not_connected','disconnected'].includes(value.state))ports.storage.removeItem(APP_CONNECTION_SESSION_PENDING_KEY);return value;
   }finally{busy=false;}
  },
  async disconnect(targetKey:string){current();if(busy||reuse.unresolved(targetKey)||repair.unresolved(targetKey)||target(targetKey).upgrade&&upgrade.unresolved(targetKey))fail();const chosen=target(targetKey);if(!chosen.session||!['connected','not_connected'].includes(chosen.session.state))fail();busy=true;
   try{const value=sessionView(await post(ports,'disconnect',{session_id:chosen.session.session_id}),ports.identity,targetKey,chosen.session);current();if(value.state!=='disconnected')fail();chosen.session=value;
    const pending=readPending(ports);if(pending?.targetKey===targetKey&&(!pending.connectionSessionId||pending.connectionSessionId===value.session_id))ports.storage.removeItem(APP_CONNECTION_SESSION_PENDING_KEY);return value;
   }finally{busy=false;}
  },
 };
}
