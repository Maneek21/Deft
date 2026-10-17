import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {appConsentDeadline} from '@deft/app-kit';
import {canonicalCapabilityJson} from '@deft/shared';
import {ACCESS_LIMITS,HumanAccessAccept,HumanAccessSnapshot,accessUnavailable} from '../src/lib/app-resource-access-contract.js';

const now=new Date('2026-10-15T17:00:00Z'),future=new Date(now.getTime()+60000),past=new Date(now.getTime()-1);
const id='11111111-1111-4111-8111-111111111111',agent='22222222-2222-4222-8222-222222222222';
const digest=(v:unknown)=>'sha256:'+createHash('sha256').update(canonicalCapabilityJson(JSON.parse(JSON.stringify(v)))).digest('hex');
const sql=()=>'',eq=()=>'',and=()=>'';
const serviceSource=ts.createSourceFile('access.ts',readFileSync(new URL('../src/lib/app-resource-access-service.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declaration=serviceSource.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='AppResourceAccessService') as ts.ClassDeclaration;
const methods=declaration.members.filter(n=>ts.isMethodDeclaration(n)&&['accept','read'].includes(n.name.getText(serviceSource)));
const TestService=runInNewContext(ts.transpileModule('class ActualMethods {'+methods.map(n=>n.getText(serviceSource)).join('\n')+'};ActualMethods',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,
 {ACCESS_LIMITS,HumanAccessAccept,HumanAccessSnapshot,accessUnavailable,PrivateResourceAccessError:Error,appConsentDeadline,digest,Date,sql,eq,and,grants:{},Buffer}) as new()=>Record<string,unknown>;
function sharing(expiry:Date|null,mode?:string,grantExpiry=future,reviewExpiry=future){
 const pins={...Object.fromEntries(['app_installation_id','app_version_id','grant_snapshot_id','registration_id','operator_user_id','resource_binding_id','checkpoint_id'].map(k=>[k,id])),lifecycle_epoch:2,grant_epoch:2,runtime_epoch:1,generation:1,descriptor_digest:'sha256:'+'1'.repeat(64),revision_digest:'sha256:'+'2'.repeat(64),content_digest:'sha256:'+'3'.repeat(64)};
 const s=HumanAccessSnapshot.parse({schema_version:'deft.app_resource_access_snapshot.v1',purpose:'human_view',org_id:id,owner_user_id:id,recipient_user_id:id,...pins,ref:{schema_version:'deft.resource_ref.v2',provider:{kind:'app_runtime',provider_instance_id:id},resource_type:'message',resource_id:id},operations:['read'],field_keys:['subject'],app_label:'Synthetic',recipient_label:'Synthetic',expires_at:grantExpiry.toISOString(),review_expires_at:reviewExpiry.toISOString()});
 const g={id,org_id:id,owner_user_id:id,recipient_user_id:id,expires_at:grantExpiry,review_digest:digest(s),snapshot:s,revoked_at:null};
 const query=()=>Object.assign(Promise.resolve([g]),{limit:async()=>[g]});
 const tx={select:()=>({from:()=>({where:query})}),execute:async()=>undefined};
 const live={authority:{binding:{consent_expires_at:expiry,consent_lifetime:mode},descriptor:{label_field:'subject'}},record:{data:{subject:'Synthetic'}},participants:[id]};
 const service=new TestService();Object.assign(service,{open:()=>s,stored:()=>s,pins:()=>pins,run:async(_signal:unknown,work:(v:unknown)=>Promise<unknown>)=>work(tx),live:async()=>live,current:()=>now,final:async(_tx:unknown,_c:unknown,_ids:unknown,deadline:Date)=>{assert.ok(Number.isFinite(deadline.getTime()),'derived authority must stay finite');if(deadline<=now)throw accessUnavailable();}});
 const c={org_id:id,user_id:id};const call=(name:string,...args:unknown[])=>(service[name] as (...v:unknown[])=>Promise<unknown>).apply(service,args);
 return {accept:()=>call('accept',c,{review_token:'synthetic',review_digest:digest(s),accept_access:true}),read:()=>call('read',c,id)};
}
for(const method of ['accept','read'] as const){
 test('actual sharing '+method+' permits explicit persistent parent and preserves finite/invalid fences',async()=>{
  await sharing(null,'until_revoked')[method]();await sharing(future)[method]();
  for(const [expiry,mode]of [[null,undefined],[future,'until_revoked'],[past,undefined],[null,'other']] as const)await assert.rejects(sharing(expiry,mode)[method]());
  await assert.rejects(sharing(null,'until_revoked',past)[method]());
  if(method==='accept')await assert.rejects(sharing(null,'until_revoked',future,past)[method]());
 });
}

const deftySource=ts.createSourceFile('defty.ts',readFileSync(new URL('../src/lib/app-private-defty-authority.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const finalDeclaration=deftySource.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='finalPrivateDefty');assert.ok(finalDeclaration);
async function defty(expiry:Date|null,mode?:string,grantExpiry=future,webExpiry=future,member=true,audience=true){
 let queries=0,guarded=0,broker=0;
 const actual=runInNewContext(ts.transpileModule(finalDeclaration.getText(deftySource).replace('export ','')+';finalPrivateDefty',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{appConsentDeadline,accessUnavailable,sql,privateDeftyEnabled:()=>true,canonicalPrivateDefty:async()=>({id:agent,employee_id:agent}),assertAttachmentBrokerEnabled:()=>broker++}) as (...args:unknown[])=>Promise<void>;
 const tx={execute:async()=>({rows:queries++===0?[{user_id:id,is_active:member,role:'owner',kind:'human'},{user_id:agent,is_active:true,role:'member',kind:'agent'}]:audience?[{user_id:id},{user_id:agent}]:[{user_id:id}]})};
 const guard=Object.assign(async()=>{guarded++;},{current_web_session_expires_at:()=>webExpiry});
 const context={parent:{authority:{version:{protocol_version:'7'},registration:{operator_user_id:id},binding:{consent_expires_at:expiry,consent_lifetime:mode}}},defty:{id:agent,employee_id:agent},spaceId:id};
 await actual(tx,{org_id:id,user_id:id,guard},context,grantExpiry,()=>now);assert.equal(guarded,1);assert.equal(broker,1);
}
test('actual Defty final fence accepts only explicit persistent or current finite parent',async()=>{
 await defty(null,'until_revoked');await defty(future);
 for(const [expiry,mode]of [[null,undefined],[future,'until_revoked'],[past,undefined],[null,'other']]as const)await assert.rejects(defty(expiry,mode));
});
test('persistent parent never bypasses finite Defty grant/Web expiry or membership/audience',async()=>{
 await assert.rejects(defty(null,'until_revoked',past));await assert.rejects(defty(null,'until_revoked',future,past));
 await assert.rejects(defty(null,'until_revoked',future,future,false));await assert.rejects(defty(null,'until_revoked',future,future,true,false));
});
