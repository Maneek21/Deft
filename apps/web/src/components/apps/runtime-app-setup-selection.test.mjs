import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {AppDataRequestSchema} from '../../../../../packages/app-kit/src/app-data.ts';
const errorsText=readFileSync(new URL('../../lib/app-request-error.ts',import.meta.url),'utf8');
const errorsContext={exports:{},Response,TextDecoder,Uint8Array,Error,TypeError,require:specifier=>{assert.equal(specifier,'../../../../packages/app-kit/src/app-data');return {AppDataRequestSchema};}};
vm.runInNewContext(ts.transpileModule(errorsText,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,errorsContext);
const {AppRequestError,readAppRequestError,appRequestFailureMessage}=errorsContext.exports;
const text=readFileSync(new URL('./runtime-app-setup.tsx',import.meta.url),'utf8'),tree=ts.createSourceFile('setup.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const targetWorkspace=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TargetWorkspace');
const code=ts.transpileModule(targetWorkspace.getText(tree)+';globalThis.render=TargetWorkspace;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
test('normal owner target selection remounts review workspace and sequences catalog before context',()=>{
 const one={resource_binding_id:'one',target_key:'first',resource_key:'inbox'},two={resource_binding_id:'two',target_key:'fresh_mailbox',resource_key:'inbox'};
 const values=[[one,two],one,false,null,0];let index=0;const Workspace=()=>null;
 const ctx={globalThis:{},Workspace,useState:initial=>{const i=index++;return [values[i]??initial,value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},useEffect:()=>{},React:{Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})}};vm.runInNewContext(code,ctx);
 const flatten=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children??[]).flat(Infinity).flatMap(flatten)];
 const render=()=>{index=0;return flatten(ctx.globalThis.render({app:{id:'app',version_id:'version'},operatorId:'owner'}));};
 let nodes=render();assert.equal(nodes.find(n=>n.type===Workspace).props.key,'one');
 const account=nodes.find(n=>n.type==='select');assert.equal(account.props['aria-label'],'Account for these actions');assert.match(account.props.className,/w-full/u);assert.ok(nodes.some(n=>n.type==='option'&&n.props.children.includes('Default account')));
 nodes.find(n=>n.type==='select').props.onChange({target:{value:'two'}});nodes=render();const selected=nodes.find(n=>n.type===Workspace);assert.equal(selected.props.key,'two');assert.equal(selected.props.target.target_key,'fresh_mailbox');
 values[2]=true;nodes=render();assert.equal(nodes.some(n=>n.type===Workspace),false);
 values[2]=false;values[3]='Account targets unavailable';nodes=render();assert.equal(nodes.some(n=>n.type===Workspace),false);assert.ok(nodes.some(n=>n.props?.role==='alert'));
});

async function failedCatalog(request){
 const values=[],effects=[];let index=0;
 const ctx={globalThis:{},AbortController,Error,TypeError,setTimeout,clearTimeout,encodeURIComponent,AppRequestError,appRequestFailureMessage,
  api:{getAccessToken:()=> 'same-session',fetch:request},
  json:async response=>{if(!response.ok)throw await readAppRequestError(response,'Runtime setup is unavailable.');return response.json();},
  parseRuntimeSetupTargets:()=>null,isSameWebSession:(before,after)=>before===after,
  useState:initial=>{const i=index++;values[i]=initial;return [initial,value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},
  useEffect:effect=>effects.push(effect),React:{Fragment:'fragment',createElement:()=>null}};
 vm.runInNewContext(code,ctx);ctx.globalThis.render({app:{id:'app',version_id:'version'},operatorId:'owner'});
 const cleanup=effects[0]();
 try{await new Promise(resolve=>setImmediate(resolve));return {error:values[3],loading:values[2],targets:values[0]};}finally{cleanup();}
}

test('account target alert retains the actual public Host failure reason',async()=>{
 const reason='App access is busy. Please try again.';
 const state=await failedCatalog(async()=>Response.json({error:reason,code:'APP_EXPERIENCE_BUSY',retryable:true},{status:503}));
 assert.equal(state.error,reason+' (APP_EXPERIENCE_BUSY)');assert.equal(state.loading,false);assert.equal(state.targets.length,0);
});

test('account target alert distinguishes bounded timeout, network, and invalid catalog failures',async()=>{
 const timeout=Object.assign(new Error('private timeout diagnostic'),{name:'AbortError'});
 assert.match((await failedCatalog(async()=>{throw timeout;})).error,/timed out/i);
 assert.match((await failedCatalog(async()=>{throw new TypeError('private transport diagnostic');})).error,/reach Deft/i);
 assert.equal((await failedCatalog(async()=>Response.json({unexpected:true}))).error,'Account target list changed. Reload targets. (APP_TARGET_CATALOG_CHANGED)');
 const long='Public Host reason. '+ 'a'.repeat(1000);
 assert.equal((await failedCatalog(async()=>Response.json({error:long,code:'APP_STALE'},{status:409}))).error,'Runtime setup is unavailable. (APP_HTTP_409)');
});
