import assert from 'node:assert/strict';import test from 'node:test';import {randomUUID,webcrypto} from 'node:crypto';import {renderToStaticMarkup} from 'react-dom/server';import {readFileSync} from 'node:fs';
import {APP_CONNECTION_UPGRADE_PENDING_KEY,completeConnectionUpgrade,parseConnectionUpgradeContext} from './app-connection-upgrade';
import {APP_CONNECTION_SESSION_PENDING_KEY,createAppConnectionSessionFlow,completeAppConnectionSession,appConnectionCallbackUsesGeneric} from './app-connection-session-flow';
import {ExperienceCapabilityUpgradeReview,ExperienceCapabilityUpgradeRecovery,ExperienceCapabilityUpgradeSettings} from '../components/apps/experience-capability-upgrade';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const identity={installationId:randomUUID(),orgId:randomUUID(),ownerId:randomUUID(),experienceKey:'main',sessionTag:'a'.repeat(64)},expiry=new Date(Date.now()+600000).toISOString(),nonce='n'.repeat(43),account={account_ref:randomUUID(),label:'Synthetic same account'};
const scope={org_id:identity.orgId,owner_user_id:identity.ownerId,installation_id:identity.installationId,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),package_digest:'sha256:'+'a'.repeat(64),grant_snapshot_digest:'sha256:'+'b'.repeat(64),lifecycle_epoch:2,grant_epoch:2,target_key:'sender',resource_key:'inbox',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:2,profile_digest:'sha256:'+'c'.repeat(64),consent_expires_at:expiry};
const profile={key:'gmail_v2',label:'Gmail',authorization_origin:'https://accounts.google.com'},sourceId=randomUUID();
const action=(key:string)=>{const id=randomUUID();return {action_key:key,action_binding_id:id,consent_id:id,authority_epoch:2,consent_digest:'sha256:'+'d'.repeat(64),expires_at:expiry};};
function fixture({fresh=false,sourceRevision=5,transform=(v:any)=>v}:{fresh?:boolean;sourceRevision?:number;transform?:(v:any)=>any}={}){
 const rows=new Map<string,string>(),calls:{path:string;body:any}[]=[];const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
 let phase='candidate',requestId='',live=true,loseBegin=false,loseCallback=false;let savedReview:any=null;
 const session=()=>phase==='candidate'?null:{schema_version:'deft.app_connection_session.v1',session_id:requestId,scope,state:phase==='awaiting'?'awaiting_callback':phase==='connected'?'connected':phase==='terminal'?'not_connected':'indeterminate',expires_at:expiry,account:phase==='connected'?account:null};
 const ctx=()=>({schema_version:'deft.app_connection_upgrade_context.v1',installation_id:identity.installationId,org_id:identity.orgId,owner_user_id:identity.ownerId,targets:[{target_key:'sender',scope,profile,runtime_ready:true,session:session(),upgrade:{candidate:phase==='candidate'&&!fresh?{source_session_id:sourceId,source_revision:sourceRevision,account}:null,pending:phase==='reviewed'?{session_id:requestId,state:'upgrade_reviewed',begin_consumed:false,callback_consumed:false,review:savedReview}:phase==='awaiting'?{session_id:requestId,state:'awaiting_callback',begin_consumed:true,callback_consumed:false,review:null}:null}}]});
 const empty={schema_version:'deft.app_connection_context.v1',installation_id:identity.installationId,org_id:identity.orgId,owner_user_id:identity.ownerId,targets:[]};
 const fetch=async(path:string,init:RequestInit)=>{const body=init.body?JSON.parse(String(init.body)):null;calls.push({path,body});
  if(path.endsWith('/upgrade-context'))return Response.json(ctx());if(path.endsWith('/context'))return Response.json(empty);
  if(path.endsWith('/upgrade/review')){assert.ok([...rows.values()].some(value=>JSON.parse(value).phase==='reviewing'));requestId=body.request_id;phase='reviewed';savedReview=transform({schema_version:'deft.app_connection_upgrade_review.v1',session_id:requestId,source_session_id:sourceId,source_revision:sourceRevision,scope,account,custody_generation:1,action_consents:[action('organize_messages')],review_digest:'sha256:'+'e'.repeat(64),expires_at:expiry});return Response.json(savedReview);}
  if(path.endsWith('/upgrade/begin')){assert.ok([...rows.values()].some(value=>JSON.parse(value).phase==='starting'));phase='awaiting';if(loseBegin)throw Error('Lost Begin');return Response.json({schema_version:'deft.app_connection_upgrade_session.v1',session_id:requestId,state:'awaiting_callback',scope,account:null,expires_at:expiry,callback_state:nonce,authorization_url:profile.authorization_origin+'/?state='+nonce});}
  if(path.endsWith('/v2/begin')){assert.equal(JSON.parse(storage.getItem(APP_CONNECTION_SESSION_PENDING_KEY)!).protocol,'v2');requestId=randomUUID();phase='awaiting';return Response.json({...session(),callback_state:nonce,authorization_url:profile.authorization_origin+'/?state='+nonce});}
  if(path.endsWith('/upgrade/callback')){assert.equal(JSON.parse(storage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY)!).phase,'consumed');phase='connected';if(loseCallback)throw Error('Lost callback');return Response.json(session());}
  if(path.endsWith('/v2/callback')){phase='connected';return Response.json(session());}
  if(path.endsWith('/upgrade/status'))return Response.json(phase==='reviewed'?savedReview:session());
  throw Error(path);
 };
 const ports={identity,storage,fetch,current:()=>live,includeUpgrades:true},flow=createAppConnectionSessionFlow(ports);
 return {rows,calls,storage,fetch,ports,flow,ctx,review:()=>savedReview,revoke:()=>live=false,loseBegin:()=>loseBegin=true,loseCallback:()=>loseCallback=true,terminal:()=>phase='terminal'};
}
test('separate current v2 catalog rejects foreign owner, duplicate targets and old scope; no v1 fallback',async()=>{
 const f=fixture();assert.equal((await f.flow.load()).targets.length,1);assert.ok(f.calls.some(row=>row.path.endsWith('/upgrade-context')));assert.ok(!f.calls.some(row=>row.body));
 for(const bad of [{...f.ctx(),owner_user_id:randomUUID()},{...f.ctx(),targets:[...f.ctx().targets,...f.ctx().targets]},{...f.ctx(),targets:[{...f.ctx().targets[0],scope:{...scope,grant_snapshot_id:randomUUID()},session:{schema_version:'deft.app_connection_session.v1',session_id:randomUUID(),state:'connected',scope,expires_at:expiry,account}}]}])assert.throws(()=>parseConnectionUpgradeContext(bad,identity));
});
test('same-account review precedes dedicated OAuth and saves exact intent before every dispatch',async()=>{
 const f=fixture();await f.flow.load();const review=await f.flow.reviewUpgrade('sender');assert.equal(review.schema_version,'deft.app_connection_upgrade_review.v1');
 assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,0);assert.equal(await f.flow.beginUpgrade('sender'),profile.authorization_origin+'/?state='+nonce);
 await assert.rejects(f.flow.beginUpgrade('sender'));assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,1);
 const completed=await completeConnectionUpgrade({...f.ports,search:'?state='+nonce+'&code=synthetic-once'});assert.equal(completed.state,'connected');assert.equal(completed.account?.account_ref,account.account_ref);assert.equal(f.storage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY),null);
 await f.flow.load();assert.equal(f.flow.upgradePending('sender'),false);
 assert.ok(![...f.rows.values()].join('').includes('synthetic-once'));assert.ok(![...f.rows.values()].join('').includes('authorization_url'));
});
test('lost Begin blocks repeated review/Begin and recovers only through original status',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewUpgrade('sender');f.loseBegin();await assert.rejects(f.flow.beginUpgrade('sender'));await f.flow.load();
 await assert.rejects(f.flow.beginUpgrade('sender'));await assert.rejects(f.flow.reviewUpgrade('sender'));assert.equal(f.flow.upgradeReview('sender'),null);await f.flow.checkUpgrade('sender');
 assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,1);assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/status')).length,1);
});
test('lost callback is consumed before exchange and resolves via status, never provider-code replay',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewUpgrade('sender');await f.flow.beginUpgrade('sender');f.loseCallback();
 await assert.rejects(completeConnectionUpgrade({...f.ports,search:'?state='+nonce+'&code=synthetic-once'}));
 const completed=await completeConnectionUpgrade({...f.ports,search:''});assert.equal(completed.state,'connected');
 assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/callback')).length,1);assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/status')).length,1);
});
test('different account/source/old scope review cannot begin OAuth; expired review status may safely close before new nomination',async()=>{
 for(const change of [(v:any)=>({...v,account:{...account,account_ref:randomUUID()}}),(v:any)=>({...v,source_session_id:randomUUID()}),(v:any)=>({...v,scope:{...scope,grant_epoch:1}})]){
  const f=fixture({transform:change});await f.flow.load();await assert.rejects(f.flow.reviewUpgrade('sender'));await assert.rejects(f.flow.beginUpgrade('sender'));assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,0);
 }
 const expired=fixture({transform:v=>({...v,expires_at:new Date(Date.now()-1).toISOString()})});await expired.flow.load();await expired.flow.reviewUpgrade('sender');await assert.rejects(expired.flow.beginUpgrade('sender'));expired.terminal();assert.equal((await expired.flow.checkUpgrade('sender') as any).state,'not_connected');assert.equal(expired.flow.upgradePending('sender'),false);
});
test('current owner/SID anchor, exact nonce and expiry deny callbacks before exchange',async()=>{
 for(const kind of ['nonce','owner','sid','expired','current'] as const){const f=fixture();await f.flow.load();await f.flow.reviewUpgrade('sender');await f.flow.beginUpgrade('sender');
  if(kind==='expired'){const pointer=JSON.parse(f.storage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY)!);pointer.expires_at=new Date(Date.now()-1).toISOString();f.storage.setItem(APP_CONNECTION_UPGRADE_PENDING_KEY,JSON.stringify(pointer));}
  if(kind==='current')f.revoke();
  await assert.rejects(completeConnectionUpgrade({...f.ports,identity:{...identity,...(kind==='owner'?{ownerId:randomUUID()}:{}) ,...(kind==='sid'?{sessionTag:'f'.repeat(64)}:{})},search:'?state='+(kind==='nonce'?'wrong':nonce)+'&code=synthetic-once'}));assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/callback')).length,0);
 }
});
test('fresh v2 account uses dedicated v2 Begin/callback and tagged pending, preserving ordinary v1 contract',async()=>{
 const f=fixture({fresh:true});await f.flow.load();await f.flow.begin('sender');const completed=await completeAppConnectionSession({...f.ports,search:'?state='+nonce+'&code=synthetic-once'});assert.equal(completed.state,'connected');
 assert.equal(f.calls.filter(row=>row.path.endsWith('/v2/begin')).length,1);assert.equal(f.calls.filter(row=>row.path.endsWith('/v2/callback')).length,1);assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,0);
});
test('actual review renders separate exact permissions without implying Send, and expired review offers only status',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewUpgrade('sender');const review=f.review(),props={review,disabled:false,onAllow:()=>{},onCheck:()=>{},onClose:()=>{}};
 const html=renderToStaticMarkup(<ExperienceCapabilityUpgradeReview {...props} now={Date.now()}/>);assert.match(html,/Synthetic same account/u);assert.match(html,/Read account records/u);assert.match(html,/organize messages/u);assert.ok(!html.includes('send message'));assert.match(html,/Allow and connect/u);assert.ok(!html.includes('type="checkbox"'));assert.match(html,/Closing leaves/u);
 const expired=renderToStaticMarkup(<ExperienceCapabilityUpgradeReview {...props} now={Date.parse(expiry)+1}/>);assert.match(expired,/Check status/u);assert.ok(!expired.includes('Allow and connect'));
});
test('callback protocol coexistence keeps own upgrade nonce strict while independent native/generic callbacks remain reachable',()=>{
 const stored=JSON.stringify({state:nonce});assert.equal(appConnectionCallbackUsesGeneric('?state='+nonce+'&code=x',stored,true,true),true);assert.equal(appConnectionCallbackUsesGeneric('?state=independent&code=x',stored,false,true),false);
 const callback=readFileSync(new URL('../app/(app)/apps/connections/callback/page.tsx',import.meta.url),'utf8');assert.match(callback,/completeConnectionUpgrade\(/);assert.doesNotMatch(callback,/completeDirectEmailConnection|email-connection/);assert.ok(callback.indexOf('completeConnectionUpgrade(')<callback.indexOf('const stored = sessionStorage.getItem(APP_CONNECTION_PENDING_KEY)'));assert.match(callback,/legacyMatches\|\|genericMatches/u);
});


test('browser journal failure prevents review dispatch; a concurrent review and changed current identity cannot release OAuth',async()=>{
 const denied=fixture();await denied.flow.load();denied.storage.setItem=()=>{throw Error('Storage unavailable');};await assert.rejects(denied.flow.reviewUpgrade('sender'));assert.equal(denied.calls.filter(row=>row.body).length,0);
 const f=fixture();let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve),ports={...f.ports,fetch:async(path:string,init:RequestInit)=>{const response=await f.fetch(path,init);if(path.endsWith('/upgrade/review'))await held;return response;}},flow=createAppConnectionSessionFlow(ports);
 await flow.load();const first=flow.reviewUpgrade('sender');await new Promise(resolve=>setImmediate(resolve));await assert.rejects(flow.reviewUpgrade('sender'));f.revoke();release();await assert.rejects(first);assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/review')).length,1);assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,0);
});

test('callback denial rejects foreign account and malformed retained-account states after one consumed exchange',async()=>{
 for(const kind of ['foreign','malformed'] as const){const f=fixture();await f.flow.load();await f.flow.reviewUpgrade('sender');await f.flow.beginUpgrade('sender');
  const fetch=async(path:string,init:RequestInit)=>{const response=await f.fetch(path,init);if(!path.endsWith('/upgrade/callback'))return response;const result=await response.json();return Response.json({...result,...(kind==='foreign'?{account:{...account,account_ref:randomUUID()}}:{state:'not_connected'})});};
  await assert.rejects(completeConnectionUpgrade({...f.ports,fetch,search:'?state='+nonce+'&code=synthetic-once'}));assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/callback')).length,1);assert.equal(JSON.parse(f.storage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY)!).phase,'consumed');
 }
});


test('zero source revision is an exact nomination pin, never an omitted comparison',async()=>{
 const bad=fixture({sourceRevision:0,transform:review=>({...review,source_revision:1})});await bad.flow.load();await assert.rejects(bad.flow.reviewUpgrade('sender'));await assert.rejects(bad.flow.beginUpgrade('sender'));assert.equal(bad.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,0);
});

test('browser resolves a consumed Begin only from exact expired closure and keeps uncertain callbacks fenced',async()=>{
 for(const kind of ['valid','plain','foreign','future','consumed'] as const){
  const f=fixture(),ports={...f.ports,fetch:async(path:string,init:RequestInit)=>{
   const response=await f.fetch(path,init);if(!path.endsWith('/upgrade/status'))return response;
   const value=await response.json();return Response.json(kind==='plain'?{...value,state:'not_connected'}:{...value,
    schema_version:'deft.app_connection_upgrade_closed.v1',state:'not_connected',source_session_id:kind==='foreign'?randomUUID():sourceId,
    source_revision:5,account_ref:account.account_ref,review_expires_at:new Date(Date.now()+(kind==='future'?60000:-1)).toISOString(),
    closure:{reason:'callback_expired',custody_generation:2,receipt_digest:'sha256:'+'f'.repeat(64)}});
  }},flow=createAppConnectionSessionFlow(ports);
  await flow.load();await flow.reviewUpgrade('sender');await flow.beginUpgrade('sender');
  if(kind==='consumed')for(const [key,row]of f.rows){const value=JSON.parse(row);if(value.phase==='awaiting')f.storage.setItem(key,JSON.stringify({...value,phase:'consumed'}));}
  if(kind==='valid'||kind==='consumed'){assert.equal((await flow.checkUpgrade('sender') as any).state,'not_connected');assert.equal(flow.upgradePending('sender'),false);assert.equal(f.storage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY),null);}
  else{await assert.rejects(flow.checkUpgrade('sender'));assert.equal(flow.upgradePending('sender'),true);assert.ok(f.storage.getItem(APP_CONNECTION_UPGRADE_PENDING_KEY));}
  assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/begin')).length,1);assert.equal(f.calls.filter(row=>row.path.endsWith('/upgrade/callback')).length,0);
 }
});

test('consumed account update offers explicit original-attempt recovery with no new exchange control',()=>{
 const html=renderToStaticMarkup(<ExperienceCapabilityUpgradeRecovery consumed disabled={false} onCheck={()=>{}}/>);
 assert.match(html,/Recover account setup/);assert.match(html,/original account update/);assert.match(html,/operator confirms setup never started/);
 assert.doesNotMatch(html,/Allow and connect|Connect a new account|Re-establish background access/);
});

test('connected upgrade surface offers background installer, while uncertain account does not',async()=>{
 const f=fixture();await f.flow.load();await f.flow.reviewUpgrade('sender');await f.flow.beginUpgrade('sender');
 await completeConnectionUpgrade({...f.ports,search:'?state='+nonce+'&code=synthetic-once'});const target=(await f.flow.load()).targets[0]!;
 const props={target,client:f.flow,disabled:false,onBusy:()=>{},onContext:()=>{},onNavigate:()=>{},onConnect:()=>{},onStatus:()=>{},onDisconnect:()=>{},ownerId:identity.ownerId,orgId:identity.orgId,appOwnedRecords:true};
 const connected=renderToStaticMarkup(<ExperienceCapabilityUpgradeSettings {...props}/>);
 assert.match(connected,/Re-establish background access/);assert.match(connected,/Trusted compatible updates keep your existing approvals/);
 const uncertain={...target,session:{...target.session!,state:'indeterminate' as const,account:null}};
 assert.doesNotMatch(renderToStaticMarkup(<ExperienceCapabilityUpgradeSettings {...props} target={uncertain}/>),/Re-establish background access/);
});
