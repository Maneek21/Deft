import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import {runInNewContext} from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
const file=ts.createSourceFile('service.ts',readFileSync(new URL('../src/lib/app-owner-connection-service.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let method;function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(file)==='context')method=n;ts.forEachChild(n,visit);}visit(file);assert.ok(method);
const script=ts.transpileModule('('+method.getText(file).replace('async context(','async function context(')+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({changed=false,denied=false}={}){
 const table=name=>Object.fromEntries(['org_id','id','app_installation_id','state','app_version_id','grant_snapshot_id','active_version_id','active_grant_snapshot_id','owner_user_id','owner_connection_admission_id','runtime_registration_id'].map(key=>[key,{table:name,key}]));
 const admissionsTable=table('admissions'),installations=table('installations'),users=table('users'),resources=table('resources'),registrations=table('registrations'),bindings=table('bindings');
 const installation={org_id:'org',id:'install',active_version_id:'current',active_grant_snapshot_id:'grant'};
 const current={id:'current-admission',org_id:'org',app_installation_id:'install',state:'active',app_version_id:'current',grant_snapshot_id:'grant',policy_key:'mail',operator_user_id:'operator',review_digest:'digest'};
 const rows=[...Array.from({length:20},(_,i)=>({...current,id:'historical-'+i,app_version_id:'old-'+i})),{...current,id:'foreign-org',org_id:'other'},{...current,id:'wrong-grant',grant_snapshot_id:'old-grant'},current];
 const value=(column,context)=>column?.table?context[column.table]?.[column.key]:column;
 const eq=(a,b)=>context=>value(a,context)===value(b,context),and=(...checks)=>context=>checks.every(check=>check(context));
 const calls=[];const db={select:()=>{let where=()=>true,join=()=>true;return {from:()=>{const query={innerJoin:(_table,predicate)=>{join=predicate;return query;},where:predicate=>{where=predicate;return query;},limit:async n=>rows.filter(admission=>{const context={admissions:admission,installations:installation};return join(context)&&where(context);}).slice(0,n)};return query;}};},transaction:async use=>use(tx)};
 const tx={select:()=>{let rows=[];const query={from:table=>{rows=table===users?[{name:'Operator'}]:[];return query;},innerJoin:()=>query,where:()=>query,limit:async()=>rows,then:(resolve,reject)=>Promise.resolve(rows).then(resolve,reject)};return query;}};
 const policy={key:'mail',resource_key:'inbox',max_consent_seconds:86400};
 const context=runInNewContext(script,{db,eq,and,inArray:()=>()=>true,getTableColumns:t=>t,appInstallations:installations,appOwnerConnectionAdmissions:admissionsTable,appResourceBindings:resources,appRuntimeRegistrations:registrations,appRuntimeBindings:bindings,users,human:()=>{},z:{string:()=>({uuid:()=>({parse:v=>v})})},members:async(_tx,_org,ids)=>calls.push(['members',ids]),assertOwnerConnectionMember:async()=>calls.push(['member']),loadReviewedAttachmentApp:async()=>{calls.push(['reviewed']);return {version:{id:changed?'newer':'current'},grant:{id:'grant'},manifest:{owner_connections:[policy],sync_descriptors:[{key:'inbox',attachments:{}}]}};},samplePrivateAccessClock:async()=>({issuance:()=>new Date(0),current:()=>0}),loadOwnerConnectionAdmission:async(_tx,_org,ref)=>{calls.push(['admission',ref.admission_id]);if(denied)throw Error('revoked');assert.equal(ref.admission_id,current.id);return {row:current,reference:ref,snapshot:{limits:{}}};},isAppOwnerConnectionsEnabled:()=>true,Date,Math});
 const guard=Object.assign(async()=>calls.push(['guard']),{current_web_session_expires_at:()=>9999999999999});
 return {calls,read:()=>context.call({now:()=>new Date(0)},{org_id:'org',actor_id:'owner'},'install',guard)};
}
test('more than16 historical admissions cannot hide the current reviewed grant',async()=>{
 const f=fixture(),result=await f.read();assert.equal(result.policies[0].status,'admitted');assert.equal(result.policies[0].admission.admission_id,'current-admission');
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),['members',['owner','operator']]);assert.ok(f.calls.findIndex(row=>row[0]==='member')<f.calls.findIndex(row=>row[0]==='reviewed'));
});
test('concurrent version replacement cannot return the previously nominated admission',async()=>{
 const f=fixture({changed:true}),result=await f.read();assert.equal(result.policies[0].status,'deployment_review_required');assert.equal(f.calls.some(row=>row[0]==='admission'),false);
});
test('current admission revocation still rejects instead of admitting from history',async()=>{
 await assert.rejects(fixture({denied:true}).read(),/revoked/);
});
