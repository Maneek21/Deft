import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {appConsentDeadline,appConsentExpiryValid} from '../../../../packages/app-kit/src/consent-lifetime';

const id='11111111-1111-4111-8111-111111111111',binding='22222222-2222-4222-8222-222222222222';
const identity={registrationId:id,resourceType:'message',projectionId:id};
const ref={schema_version:'deft.resource_ref.v2',provider:{kind:'app_runtime',provider_instance_id:id},resource_type:'message',resource_id:id};
const apiSource=ts.createSourceFile('private-read.ts',readFileSync(new URL('../../../api/src/lib/app-resource-private-read.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
// Execute the API's actual response constructors, not a duplicate wire fixture.
function response(kind:'reference'|'scope'|'page',expiry:Date|null,mode?:string){
 const objects:ts.ObjectLiteralExpression[]=[];const visit=(node:ts.Node)=>{if(ts.isObjectLiteralExpression(node)&&node.properties.some(p=>p.name?.getText(apiSource)==='consent_expires_at'))objects.push(node);ts.forEachChild(node,visit);};visit(apiSource);
 const object=objects.find(node=>node.properties.some(p=>p.name?.getText(apiSource)===(kind==='reference'?'search_href':kind==='scope'?'field_keys':'schema_version')));assert.ok(object);
 const authority={binding:{id:binding,consent_expires_at:expiry,...(mode?{consent_lifetime:mode}:{})},descriptor:{record_schema:{properties:{subject:{type:'string'}}},label_field:'subject'}};
 const code=ts.transpileModule('('+object.getText(apiSource)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return JSON.parse(JSON.stringify(runInNewContext(code,{authority,b:authority.binding,record:{ref,label:'Synthetic record',data:{subject:'Synthetic'}},items:[],scanned:0,complete:true,next_cursor:null})));
}
function page(name:string,reference:unknown,scope:unknown,searchPage:unknown){
 const effects:Array<()=>void|(()=>void)>=[],timers:number[]=[],updates:unknown[]=[];
 const request=async(path:string)=>({ok:true,json:async()=>path==='/api/members'?[]:path.endsWith('/search-scope')?scope:path.endsWith('/search')?searchPage:reference});
 const api={getAccessToken:()=> 'synthetic-current',get:request,fetch:request};
 const state={useState:(initial:unknown)=>[initial,(value:unknown)=>updates.push(value)],useRef:(current:unknown)=>({current}),useCallback:(fn:unknown)=>fn,useLayoutEffect:(fn:()=>void|(()=>void))=>effects.push(fn)};
 const jsx=(type:unknown,props:unknown)=>({type,props});const commonJsModule={exports:{}};
 const file=new URL('../components/apps/'+name+'.tsx',import.meta.url);
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 runInNewContext(code,{exports:commonJsModule.exports,module:commonJsModule,require:(name:string)=>name==='react'?state:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name.endsWith('consent-lifetime')?{appConsentDeadline,appConsentExpiryValid}:name==='@/lib/api'?{api,isSameWebSession:(a:unknown,b:unknown)=>a===b}:name==='@/lib/auth-context'?{useAuth:()=>({user:{role:'owner'},sessionCacheScope:'synthetic-scope'})}:name==='@/lib/apps'?{appApiError:async()=> 'Unavailable'}:{},document:{hidden:false,addEventListener(){},removeEventListener(){}},localStorage:{getItem:()=> 'synthetic-current'},TextEncoder,AbortController,setTimeout:(_fn:unknown,delay:number)=>{timers.push(delay);return 1;},clearTimeout(){},addEventListener(){},removeEventListener(){}});
 const exports=commonJsModule.exports as Record<string,(input:unknown)=>{type:(input:unknown)=>unknown;props:unknown}>;
 const component=exports[({'private-resource-reference':'PrivateResourceReference','private-resource-search':'PrivateResourceSearch','private-resource-sharing':'PrivateResourceShareReview','private-resource-mcp':'PrivateResourceMcpReview'} as Record<string,string>)[name]!];assert.ok(component);
 const child=component(name==='private-resource-search'?{bindingId:binding}:identity);child.type(child.props);
 const cleanups=effects.map(fn=>fn());return {updates,timers,cleanup:()=>cleanups.forEach(fn=>typeof fn==='function'&&fn())};
}
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
for(const name of ['private-resource-reference','private-resource-search','private-resource-sharing','private-resource-mcp']){
 test(name+' accepts the actual persistent API response without an expiry timer',async()=>{
  const r=page(name,response('reference',null,'until_revoked'),response('scope',null,'until_revoked'),response('page',null,'until_revoked'));await flush();
  try{assert.ok(!r.updates.some(v=>typeof v==='string'&&/unavailable|expired/i.test(v)),JSON.stringify(r.updates));assert.ok(r.updates.some(v=>name==='private-resource-reference'?typeof v==='object'&&v!==null&&'data'in v:name==='private-resource-search'?typeof v==='object'&&v!==null&&'field_keys'in v:Array.isArray(v)&&v.includes('subject')),'actual load publishes the approved resource/fields');assert.ok(!r.timers.includes(2147483647),'persistent permission has no artificial 24-day expiry');}finally{r.cleanup();}
 });
 test(name+' preserves finite responses and denies null or mismatched mode',async()=>{
  const future=new Date(Date.now()+60000);
  for(const [expiry,mode,accepted]of [[future,undefined,true],[null,undefined,false],[future,'until_revoked',false],[null,'other',false]] as const){
   const r=page(name,response('reference',expiry,mode),response('scope',expiry,mode),response('page',expiry,mode));await flush();
   try{assert.equal(r.updates.some(v=>typeof v==='string'&&/unavailable|expired/i.test(v)),!accepted,JSON.stringify({name,expiry,mode,updates:r.updates}));}finally{r.cleanup();}
  }
 });
}

// Search results have a separate parser after initial scope loading. Exercise it
// directly with the same actual API constructor, including lifetime preservation.
test('actual API search page retains the paired lifetime and fails malformed pairs',()=>{
 const source=ts.createSourceFile('search.tsx',readFileSync(new URL('../components/apps/private-resource-search.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
 const declarations=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&['object','pageValue'].includes(n.name?.text??''));assert.equal(declarations.length,2);
 const code=ts.transpileModule(declarations.map(n=>n.getText(source)).join('\n')+';pageValue',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const parse=runInNewContext(code,{appConsentExpiryValid,TextEncoder,invalid:()=>new Error('Invalid')}) as (v:unknown,fields:string[])=>{consent_expires_at:string|null;consent_lifetime?:string};
 const persistent=response('page',null,'until_revoked');assert.equal(parse(persistent,['subject']).consent_lifetime,'until_revoked');assert.equal(parse(persistent,['subject']).consent_expires_at,null);
 const finite=response('page',new Date(Date.now()+60000));assert.equal(parse(finite,['subject']).consent_expires_at,finite.consent_expires_at);assert.equal(Object.hasOwn(parse(finite,['subject']),'consent_lifetime'),false);
 for(const pair of [{consent_expires_at:null},{consent_expires_at:finite.consent_expires_at,consent_lifetime:'until_revoked'},{consent_expires_at:null,consent_lifetime:'other'},{consent_expires_at:undefined},{consent_expires_at:0}])assert.throws(()=>parse({...finite,...pair},['subject']));
});
