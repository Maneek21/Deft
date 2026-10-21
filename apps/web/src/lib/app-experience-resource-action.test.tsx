import assert from 'node:assert/strict';import test from 'node:test';import {webcrypto} from 'node:crypto';import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data';
import {AppResourceActionReviewSchema} from '../../../../packages/app-kit/src/app-resource-action';
import {parseExperienceResourceAction,createExperienceResourceAction} from './app-experience-resource-action';
import {ExperienceResourceActionPreview} from '../components/apps/experience-resource-action';
import {composerInputDigest} from './app-experience-compose-files';
import {experienceActionDialogKeys} from './app-experience-action-confirmation';
import {parseExperienceView,createExperienceBridge,type ExperiencePin,type ExperiencePort} from './app-experience-bridge';
import {createDeftExperienceSdk} from '../../../../packages/app-kit/src/experience-core';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),digest='sha256:'+'a'.repeat(64);
const request={action_key:'change_records',store_key:'drafts',resource_key:'mail',operation_key:'archive',sources:[{resource_key:'mail',record_id:id(1),content_digest:digest}]};
const admitted={actions:['change_records'],stores:['drafts'],resources:['mail']},pins={sessionId:id(2),connectionSessionId:id(3),accountRef:id(4),targetKey:'sender'};
async function review(sources=request.sources){const sourceDigest='sha256:'+Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalAppDataJson(sources)))).toString('hex');
 const input={snapshot_id:id(5),account_ref:pins.accountRef,operation_key:'archive',source_manifest_digest:sourceDigest,item_count:sources.length,plan_digest:digest};
 const prepared={schema_version:'deft.app_prepared_resource_action.v1',snapshot_id:id(5),snapshot_digest:digest,account_ref:pins.accountRef,action_key:'change_records',operation_key:'archive',resource_key:'mail',source_manifest_digest:sourceDigest,item_count:sources.length,input,
  preview:{title:'Archive selected records',count:sources.length,items:sources.map(source=>({record_id:source.record_id,label:'Synthetic record '+source.record_id.slice(-2),before:'Inbox',after:'Archive'}))},expires_at:new Date(Date.now()+60000).toISOString()};
 const released={...input,resource_action_version:prepared.schema_version,resource_store_key:'drafts',connection_session_id:pins.connectionSessionId,connection_revision:1,data_consent_id:id(6),data_consent_digest:digest,prepared_digest:digest};
 return {schema_version:'deft.app_resource_action_review.v1',prepared,input:released,ticket:'sealed',input_digest:await composerInputDigest(released),expires_at:prepared.expires_at};
}
async function fixture(transform=(v:any)=>v){const calls:{path:string;body?:any}[]=[];let live=true,unknown=false;const prepared=await review();
 const model=createExperienceResourceAction({request,...pins,uuid:()=>id(7),current:()=>live,call:async(path,body)=>{calls.push({path,body});if(path.endsWith('/prepare'))return transform(structuredClone(prepared));if(path.endsWith('/confirm')&&unknown)throw Error('Lost response');return {run:{id:id(8),state:'queued',secret:'must not cross Worker'}};}});
 return {model,calls,prepared,revoke:()=>live=false,lose:()=>unknown=true};
}
test('closed admitted dialog input denies arbitrary options, foreign resources/actions and duplicate/oversized selections',()=>{
 assert.deepEqual(parseExperienceResourceAction(request,admitted),request);
 for(const input of [{...request,options:{}},{...request,operation_key:'../archive'},{...request,action_key:'other'},{...request,store_key:'other'},{...request,sources:[{...request.sources[0],resource_key:'other'}]},{...request,sources:[request.sources[0],request.sources[0]]},{...request,sources:Array.from({length:26},(_,n)=>({...request.sources[0],record_id:id(n+100)}))}])assert.throws(()=>parseExperienceResourceAction(input,admitted));
});
test('exact authoritative preview is reviewed once; confirm emits only sealed ticket and returns bounded Run metadata',async()=>{
 const f=await fixture();await f.model.load();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{connection_session_id:pins.connectionSessionId,store_key:'drafts',resource_key:'mail',operation_key:'archive',sources:request.sources,idempotency_key:id(7)});
 assert.match(f.calls[0].path,/resource-actions\/change_records\/prepare$/u);
 assert.deepEqual(await f.model.confirm(),{id:id(8),state:'queued'});assert.deepEqual(f.calls[1].body,{ticket:'sealed',expected_input_digest:f.prepared.input_digest});
 await assert.rejects(f.model.confirm());await assert.rejects(f.model.load());assert.equal(f.calls.length,2);
});
test('lost confirmation has status-only recovery with original UUID; no activation replay or auto retry',async()=>{
 const f=await fixture();await f.model.load();f.lose();await assert.rejects(f.model.confirm());assert.equal(f.model.dispatched,true);
 await assert.rejects(f.model.confirm());assert.deepEqual(await f.model.status(),{id:id(8),state:'queued'});
 assert.match(f.calls[2].path,new RegExp('/submissions/'+id(7)+'$'));assert.equal(f.calls.filter(c=>c.path.endsWith('/confirm')).length,1);
});
test('foreign account/source selection/operation/current connection/input digest and expired reviews deny before confirmation',async()=>{
 const variants=[(v:any)=>{v.prepared.account_ref=id(99);v.prepared.input.account_ref=id(99);v.input.account_ref=id(99);},
  (v:any)=>{v.prepared.preview.items[0].record_id=id(99);},
  (v:any)=>{v.prepared.operation_key='trash';v.prepared.input.operation_key='trash';v.input.operation_key='trash';},
  (v:any)=>{v.input.connection_session_id=id(99);},
  (v:any)=>{v.prepared.source_manifest_digest='sha256:'+'b'.repeat(64);v.prepared.input.source_manifest_digest=v.prepared.source_manifest_digest;v.input.source_manifest_digest=v.prepared.source_manifest_digest;},
  (v:any)=>{v.input_digest='sha256:'+'b'.repeat(64);},
  (v:any)=>{v.expires_at=new Date(Date.now()-1).toISOString();}];
 for(const change of variants){const f=await fixture(v=>{change(v);return v;});await assert.rejects(f.model.load());await assert.rejects(f.model.confirm());assert.equal(f.calls.length,1);}
 const revoked=await fixture();await revoked.model.load();revoked.revoke();await assert.rejects(revoked.model.confirm());assert.equal(revoked.calls.length,1);
});
test('late preparation after changed scope is never disclosed and expired loaded review cannot dispatch',async()=>{
 let live=true,release!:(v:unknown)=>void;const value=await review();const model=createExperienceResourceAction({request,...pins,current:()=>live,call:()=>new Promise(resolve=>release=resolve)});
 const load=model.load();live=false;release(value);await assert.rejects(load);
 let clock=Date.now(),count=0;const timed=createExperienceResourceAction({request,...pins,current:()=>true,now:()=>clock,call:async()=>{count++;return value;}});
 await timed.load();clock=Date.parse(value.expires_at)+1;await assert.rejects(timed.confirm());assert.equal(count,1);
});
test('actual trusted preview renders all 25 authoritative labels and before/after without internal pins',async()=>{
 const value=AppResourceActionReviewSchema.parse(await review(Array.from({length:25},(_,n)=>({...request.sources[0],record_id:id(n+100)}))));
 const html=renderToStaticMarkup(<ExperienceResourceActionPreview review={value}/>);
 assert.match(html,/25 selected records/u);assert.equal((html.match(/Synthetic record/gu)??[]).length,25);assert.match(html,/>Before</u);assert.match(html,/>After</u);
 for(const secret of ['sealed',pins.connectionSessionId,digest,'snapshot_id','operation_key'])assert.ok(!html.includes(secret));
});
class Port implements ExperiencePort{onmessage:((event:MessageEvent)=>void)|null=null;other!:Port;postMessage(value:unknown){queueMicrotask(()=>this.other.onmessage?.({data:structuredClone(value)} as MessageEvent));}close(){}}
test('real public SDK and host bridge admit resource review dialog; full prepared plan stays host-only',async()=>{
 const author=new Port(),host=new Port();author.other=host;host.other=author;const pin:ExperiencePin={org_id:'org',user_id:'owner',app_installation_id:'install',app_version_id:'version',grant_snapshot_id:'grant',lifecycle_epoch:1,grant_epoch:1,session_id:'session_test',session_epoch:1};
 let calls=0;const bridge=createExperienceBridge({port:host,pin,resourceKeys:['mail'],actionKeys:['change_records'],dialogKeys:experienceActionDialogKeys('7'),broker:{isLive:()=>true,dialog:async(_pin,key,input)=>{calls++;assert.equal(key,'review_resource_action');const intent=parseExperienceResourceAction(input,admitted);assert.deepEqual(intent,request);const f=await fixture();await f.model.load();return {run:await f.model.confirm()};}},onView:()=>undefined});
 const sdk=createDeftExperienceSdk(author,'session_test');const result=await sdk.request('dialog','review_resource_action',request);assert.deepEqual(result,{run:{id:id(8),state:'queued'}});assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('Synthetic'));bridge.revoke();sdk.close();
});
test('installed host wires exact current account/catalog and excludes full prepared resource from Worker projection',()=>{
 const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
 for(const token of ["key==='review_resource_action'",'target.resource_key!==intent.resource_key','accountRef:target.account.account_ref','prepared_resource:_preparedResource','ensureAuthority:live'])assert.ok(source.includes(token));
});

 test('new icon vocabulary remains closed at the actual author view parser',()=>{for(const icon of ['select','check','more'])assert.ok(parseExperienceView({root:{kind:'button',id:'selection',label:'Select',icon}}));assert.equal(parseExperienceView({root:{kind:'button',id:'selection',label:'Select',icon:'<svg onload=bad>'}}),null);});
