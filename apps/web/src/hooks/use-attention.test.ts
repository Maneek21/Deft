import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {sessionSWRKey,sessionSWRPath,sessionSWRScope,isActiveSessionCacheKey,setActiveSessionCacheScope} from '../lib/session-cache';
const source=readFileSync(new URL('./use-attention.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('attention.ts',source,ts.ScriptTarget.Latest,true);
function nodeNamed(name:string){let found:ts.Node|undefined;const visit=(n:ts.Node)=>{if((ts.isVariableDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.getText(tree)===name)found=n;ts.forEachChild(n,visit);};visit(tree);assert.ok(found);return found;}
function compile(code:string,context:Record<string,unknown>){return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);}
test('attention pagination keys never share one cache between verified sessions or logout',()=>{
 const node=nodeNamed('getKey') as ts.VariableDeclaration;
 const key=(scope:string|null)=>compile(`(${node.initializer!.getText(tree)})`,{baseQuery:'limit=12',sessionCacheScope:scope,URLSearchParams,sessionSWRKey})(0,null);
 assert.notEqual(key('org:owner:sid-a:1'),key('org:owner:sid-b:2'));
 assert.equal(key(null),null);
 assert.equal(sessionSWRPath(key('org:owner:sid-a:1')),'/api/attention?limit=12');
});
test('attention fetch rejects before I/O and after a held session transition',async()=>{
 const node=nodeNamed('fetchAttention'),scope='org:owner:sid-a:1',key=sessionSWRKey(scope,'/api/attention?limit=12')!;
 let calls=0,resolve!:(value:Response)=>void;
 const read=compile(`(${node.getText(tree)})`,{api:{get:async()=>{calls++;return new Promise<Response>(done=>{resolve=done;});}},sessionSWRPath,sessionSWRScope,isActiveSessionCacheKey});
 setActiveSessionCacheScope(null);await assert.rejects(read(key),/access changed/);assert.equal(calls,0);
 setActiveSessionCacheScope(scope);const held=read(key);setActiveSessionCacheScope('org:other:sid-b:2');resolve(Response.json({items:[{title:'Private old owner'}],counts:{},next_cursor:null}));await assert.rejects(held,/access changed/);
 setActiveSessionCacheScope(scope);const fresh=read(key);resolve(Response.json({items:[],counts:{},next_cursor:null}));assert.equal((await fresh).session_scope,scope);setActiveSessionCacheScope(null);
});
test('attention mutations reject an old session before request and before cache publication',async()=>{
 const scope='org:owner:sid-a:1';let calls=0,published=0,resolve!:(value:Response)=>void;
 const node=nodeNamed('transition') as ts.VariableDeclaration;
 const transition=compile(`(${node.initializer!.getText(tree)})`,{useCallback:(callback:unknown)=>callback,sessionCacheScope:scope,getActiveSessionCacheScope:()=>active,api:{post:async()=>{calls++;return new Promise<Response>(done=>{resolve=done;});}},mutate:async()=>{published++;}});
 let active:string|null=null;await assert.rejects(transition('id','seen'),/access changed/);assert.equal(calls,0);
 active=scope;const held=transition('id','seen');active='org:other:sid-b:2';resolve(Response.json({ok:true}));await assert.rejects(held,/access changed/);assert.equal(published,0);
 active=scope;const fresh=transition('id','seen');resolve(Response.json({ok:true}));await fresh;assert.equal(published,1);
});
