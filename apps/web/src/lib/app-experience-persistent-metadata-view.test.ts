import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {appConsentDeadline,appConsentExpiryValid} from '../../../../packages/app-kit/src/consent-lifetime';
import {attachmentParent,attachmentParentPage,attachmentId} from './app-attachment-view';

const id='11111111-1111-4111-8111-111111111111',future=new Date(Date.now()+60000);
const ref={schema_version:'deft.resource_ref.v2',provider:{kind:'app_runtime',provider_instance_id:id},resource_type:'message',resource_id:id};
const source=(url:URL)=>ts.createSourceFile(url.pathname,readFileSync(url,'utf8'),ts.ScriptTarget.Latest,true);
const evaluate=(code:string,globals:Record<string,unknown>)=>runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{appConsentDeadline,appConsentExpiryValid,TextEncoder,...globals});
function find(root:ts.Node,predicate:(n:ts.Node)=>boolean):ts.Node{let result:ts.Node|undefined;const visit=(n:ts.Node)=>{if(!result&&predicate(n))result=n;if(!result)ts.forEachChild(n,visit);};visit(root);assert.ok(result);return result;}
const settings=source(new URL('../app/(app)/settings/apps/private-resources/private-resources-client.tsx',import.meta.url));
const operator=source(new URL('../app/(app)/settings/apps/private-resources/operator-assignments.tsx',import.meta.url));
function helpers(file:ts.SourceFile){return file.statements.filter(n=>ts.isFunctionDeclaration(n)&&['bindingDeadline','assignmentDeadline'].includes(n.name?.text??'')).map(n=>n.getText(file)).join('\n');}
test('actual selected-binding expiry effect keeps explicit V3 persistence and denies V2/null',()=>{
 const effects:ts.CallExpression[]=[];const visit=(n:ts.Node)=>{if(ts.isCallExpression(n)&&n.expression.getText(settings)==='useEffect')effects.push(n);ts.forEachChild(n,visit);};visit(settings);
 const effect=effects.find(n=>n.arguments[0].getText(settings).includes('selected.binding.consent_expires_at')||n.arguments[0].getText(settings).includes('bindingDeadline(selected.binding)'));assert.ok(effect);
 for(const [binding,allowed]of [[{consent_expires_at:null,consent_lifetime:'until_revoked',channel:'attachment'},true],[{consent_expires_at:future.toISOString()},true],[{consent_expires_at:null},false],[{consent_expires_at:null,consent_lifetime:'until_revoked'},false],[{consent_expires_at:future.toISOString(),consent_lifetime:'until_revoked',channel:'attachment'},false]]as const){
  let cleared=0;const expired:boolean[]=[],timers:number[]=[];evaluate(helpers(settings)+';('+effect.arguments[0].getText(settings)+')()',{selected:{binding},clearContent:()=>cleared++,setConsentExpired:(value:boolean)=>expired.push(value),setTimeout:(_fn:unknown,delay:number)=>{timers.push(delay);return 1;},clearTimeout(){}});
  assert.equal(cleared,!allowed?1:0);if(allowed&&binding.consent_expires_at===null)assert.equal(timers.length,0);
 }
});
test('actual assignment filter retains explicit V3 persistence, not malformed or V2 null pairs',()=>{
 const filter=find(operator,n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='filter')as ts.CallExpression;
 const predicate=evaluate(helpers(operator)+';('+filter.arguments[0].getText(operator)+')',{})as(v:unknown)=>boolean;
 assert.equal(predicate({consent_expires_at:null,consent_lifetime:'until_revoked',attachment:true}),true);assert.equal(predicate({consent_expires_at:future.toISOString()}),true);
 for(const row of [{consent_expires_at:null},{consent_expires_at:null,consent_lifetime:'until_revoked'},{consent_expires_at:future.toISOString(),consent_lifetime:'until_revoked',attachment:true},{consent_expires_at:null,consent_lifetime:'other',attachment:true}])assert.equal(predicate(row),false);
});
// Actual API projection fields are evaluated with synthetic locked-authority inputs.
const owner=source(new URL('../../../api/src/lib/app-attachment-owner.ts',import.meta.url));
function parentResponse(page:boolean,expiry:Date|null,mode?:string){
 const literal=find(owner,n=>ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(owner)==='schema_version'&&p.getText(owner).includes(page?'deft.app_attachment_parent_page.v1':'deft.app_attachment_parent.v1')))as ts.ObjectLiteralExpression;
 const authority={binding:{consent_expires_at:expiry,...(mode?{consent_lifetime:mode}:{})},descriptor:{label_field:'subject'}};
 const code='new(class{#ref(){return ref} #label(v:unknown){return String(v)} value(){return '+literal.getText(owner)+'}})().value()';
 return JSON.parse(JSON.stringify(evaluate(code,{ref,authority,current:{authority,parent:{id},body:{data:{subject:'Synthetic'}},entries:[]},items:[],next_cursor:null})));
}
test('actual attachment API parent and page roundtrip explicit persistent and finite pairs',()=>{
 for(const page of [false,true]){
  const parse=(v:unknown)=>page?attachmentParentPage(v):attachmentParent(v,id);
  assert.equal(parse(parentResponse(page,null,'until_revoked')).consent_expires_at,null);
  assert.equal((parse(parentResponse(page,null,'until_revoked'))as{consent_lifetime?:string}).consent_lifetime,'until_revoked');
  assert.equal(Object.hasOwn(parse(parentResponse(page,future)),'consent_lifetime'),false);
  for(const [expiry,mode]of [[null,undefined],[future,'until_revoked'],[null,'other']]as const)assert.throws(()=>parse(parentResponse(page,expiry,mode)));
 }
});
test('actual attachment load caps persistent permission at the finite Web deadline',async()=>{
 const view=source(new URL('../components/apps/attachment-parent-view.tsx',import.meta.url));
 const declaration=find(view,n=>ts.isVariableDeclaration(n)&&n.name.getText(view)==='load')as ts.VariableDeclaration;assert.ok(declaration.initializer);
 const stamp={deadline:future.getTime(),controller:new AbortController(),generation:1};let result:unknown;
 const load=evaluate('('+declaration.initializer.getText(view)+')',{begin:()=>stamp,setBusy(){},setError(value:unknown){if(value)assert.fail(String(value));},setPage(){},setParent(value:unknown){result=value;},setProjects(){},setTask(){},attachmentId,attachmentParent,attachmentParentPage,bindingId:id,projectionId:id,base:'/synthetic',api:{fetch:async()=>({ok:true,json:async()=>parentResponse(false,null,'until_revoked')})},current:(s:typeof stamp)=>s.deadline>Date.now(),arm(s:typeof stamp){assert.equal(s.deadline,future.getTime());},disposed:{current:false},generation:{current:1}})as()=>Promise<void>;
 await load();assert.ok(result);assert.equal(stamp.deadline,future.getTime());
});
test('actual status DTO projects mode for persistence and omits finite null mode',()=>{
 const status=source(new URL('../../../api/src/lib/app-resource-sync-status.ts',import.meta.url));
 const fields=find(status,n=>ts.isVariableDeclaration(n)&&n.name.getText(status)==='bindingFields')as ts.VariableDeclaration;assert.ok(fields.initializer);
 const columns=new Proxy({},{get:(_target,key)=>key});const selected=evaluate('('+fields.initializer.getText(status)+')',{appResourceBindings:columns})as Record<string,string>;
 const declarations=status.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='statusBinding');
 const project=evaluate(declarations.map(n=>n.getText(status)).join('\n')+';typeof statusBinding==="function"?statusBinding:(row:unknown)=>row',{})as(row:unknown)=>Record<string,unknown>;
 for(const [expiry,mode]of [[null,'until_revoked'],[future.toISOString(),null]]as const){const stored={consent_expires_at:expiry,consent_lifetime:mode};const wire=JSON.parse(JSON.stringify(project(Object.fromEntries(Object.entries(selected).map(([key,column])=>[key,stored[column as keyof typeof stored]])))));if(mode)assert.equal(wire.consent_lifetime,mode);else assert.equal(Object.hasOwn(wire,'consent_lifetime'),false);}
});

test('actual assignment expiry effect schedules only the earliest finite permission',()=>{
 const effect=find(operator,n=>ts.isCallExpression(n)&&n.expression.getText(operator)==='useEffect'&&n.arguments[0].getText(operator).includes('earliest'))as ts.CallExpression;
 const persistent={consent_expires_at:null,consent_lifetime:'until_revoked',attachment:true};
 for(const assignments of [[persistent],[persistent,{consent_expires_at:future.toISOString()}]]){const timers:number[]=[];evaluate(helpers(operator)+';('+effect.arguments[0].getText(operator)+')()',{assignments,load(){},setTimeout:(_fn:unknown,delay:number)=>{timers.push(delay);return 1;},clearTimeout(){}});assert.equal(timers.length,assignments.length===1?0:1);if(timers.length)assert.ok(timers[0]<=60000);}
});
test('actual status captions say Until revoked without formatting null as a date',()=>{
 const attachment=source(new URL('../components/apps/attachment-parent-view.tsx',import.meta.url));
 for(const [file,rowName,row]of [[settings,'binding',{consent_expires_at:null,consent_lifetime:'until_revoked',channel:'attachment'}],[operator,'item',{consent_expires_at:null,consent_lifetime:'until_revoked',attachment:true}],[attachment,'visibleParent',{consent_expires_at:null,consent_lifetime:'until_revoked'}]]as const){
  const expression=find(file,n=>ts.isConditionalExpression(n)&&n.getText(file).includes("'Until revoked'"));
  assert.equal(evaluate(helpers(file)+';('+expression.getText(file)+')',{[rowName]:row}),'Until revoked');
 }
});
