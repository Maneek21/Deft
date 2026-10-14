import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {Hono} from 'hono';
const source=ts.createSourceFile('routes.ts',readFileSync(process.env.DEFT_RETIRED_HANDOFF_ROUTE_SOURCE??new URL('../src/routes/app-integration-tools.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createAppIntegrationToolRoutes')!;
const code=ts.transpileModule('('+declaration.getText(source).replace('export ','')+')',{compilerOptions:{target:ts.ScriptTarget.ES2015}}).outputText;
test('enabled integration router cannot dispatch retired Email-specific Defty handoff',async()=>{let called=0;const limit=()=>async(_context:unknown,next:()=>Promise<void>)=>next();const create=vm.runInNewContext(code,{Hono,Promise,process:{env:{DEFT_APPS_ENABLED:'true'}},isAppOwnerConnectionsEnabled:()=>true,createAppResourceSyncLimits:limit,createAppResourcePrivateReadLimits:limit,caller:async()=>{called++;throw Error('Denied');},appHttpFailure:(context:any)=>context.json({code:'FORBIDDEN'},403)});const routes=create();const response=await routes.request('http://fixture.invalid/defty-context',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,404);assert.equal(called,0);});


test('runtime authority uses the declared integration authority without a recipient-specific override',async()=>{
 let called=0;const raw={tool_key:'lookup_person',store_key:'contacts',input_digest:'digest'},limit=()=>async(_context:unknown,next:()=>Promise<void>)=>next();
 const create=vm.runInNewContext(code,{Hono,Promise,process:{env:{DEFT_APPS_ENABLED:'true'}},isAppOwnerConnectionsEnabled:()=>true,createAppResourceSyncLimits:limit,createAppResourcePrivateReadLimits:limit,
  body:async()=>raw,integrationToolAuthority:async(input:unknown,authorization:unknown)=>{called++;assert.equal(input,raw);assert.equal(authorization,'Bearer fixture');return {allowed:true,tool_key:raw.tool_key,store_key:raw.store_key};},
  maybeAppIntegrationHumanReadAuthority:async()=>{throw Error('Retired recipient path reached');},appHttpFailure:(context:any)=>context.json({code:'FORBIDDEN'},403)});
 const response=await create().request('http://fixture.invalid/runtime/authority',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:'{}'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{allowed:true,tool_key:'lookup_person',store_key:'contacts'});assert.equal(called,1);
});


test('actual App integration mount graph leaves retired recipient search absent without private dispatch',async()=>{
 const entry=ts.createSourceFile('index.ts',readFileSync(process.env.DEFT_RETIRED_RECIPIENT_INDEX_SOURCE??new URL('../src/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
 const paths:string[]=[];const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(entry)==='app'&&node.expression.name.text==='route'&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text.startsWith('/api/app-integrations'))paths.push(node.arguments[0].text);ts.forEachChild(node,visit);};visit(entry);
 let privateCalls=0;const app=new Hono();for(const path of paths){const mounted=new Hono();mounted.all('*',c=>{privateCalls++;return c.json({private_result:true});});app.route(path,mounted);}
 const response=await app.request('http://fixture.invalid/api/app-integrations/recipients/00000000-0000-4000-8000-000000000001/search',{method:'POST',headers:{'content-type':'application/json'},body:'{"query":"Synthetic","limit":1}'});
 assert.equal(response.status,404);assert.equal(privateCalls,0);
});
