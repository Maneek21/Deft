import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {NativeEmailAccountPreferences} from './native-email-account-preferences';
import {createEmailConnectedClient,EmailConnectedError,parseEmailAgentAccess,parseEmailKnowledgeSettings} from '@/lib/email-native-connected';
import {emailReadingPreferenceRequest} from '@/lib/email-reading-preferences';

const noop=()=>{},tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function declaration(path:URL,name:string){const source=ts.createSourceFile(name,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node);return node.getText(source).replace(/^export\s+/u,'');}
/** Execute the actual function/hook with deterministic state/effect slots.
 * This is a local lifecycle fixture, not a browser renderer or latency test. */
function runtime(source:string,context:Record<string,unknown>={}){
 const slots:Array<{value:any;deps?:readonly unknown[];cleanup?:()=>void}>=[];let index=0,disposed=false,lateWrites=0;const queue:Array<()=>void>=[];
 const slot=(initial:any)=>{const position=index++;return slots[position]??(slots[position]={value:typeof initial==='function'?initial():initial});};
 const useState=(initial:any)=>{const owned=slot(initial);return [owned.value,(next:any)=>{if(disposed)lateWrites++;owned.value=typeof next==='function'?next(owned.value):next;}];};
 const useRef=(initial:any)=>slot({current:initial}).value;
 const useEffect=(fn:()=>void|(()=>void),deps?:readonly unknown[])=>{const owned=slot(null),changed=!owned.deps||!deps||deps.length!==owned.deps.length||deps.some((value,n)=>!Object.is(value,owned.deps![n]));if(changed){owned.deps=deps;queue.push(()=>{owned.cleanup?.();const cleanup=fn();owned.cleanup=typeof cleanup==='function'?cleanup:undefined;});}};
 const useCallback=(fn:any)=>{slot(null);return fn;},useId=()=>slot('reading-choice').value;
 const fn=runInNewContext(ts.transpileModule('('+source+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,{React,AbortController,Error,useState,useRef,useEffect,useCallback,useId,...context});
 return {last:null as any,get lateWrites(){return lateWrites;},render(...args:any[]){assert.equal(disposed,false);index=0;const result=fn(...args);while(queue.length)queue.shift()!();this.last=result;return result;},dispose(){for(const owned of slots)owned.cleanup?.();disposed=true;}};
}
const wrapperSource=declaration(new URL('./native-email-account-preferences.tsx',import.meta.url),'NativeEmailAccountPreferences');
const resourceSource=declaration(new URL('./use-email-connected-resource.ts',import.meta.url),'useEmailConnectedResource');
const readingSource=declaration(new URL('../apps/email-reading-settings.tsx',import.meta.url),'EmailReadingSettings');
function find(node:any,predicate:(node:any)=>boolean):any{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
function fixture(){
 let sessionScope='scope-1',token='token-1',hold=false,denySave=false,conflictReading=false,activeKey='';
 const calls:Array<{path:string;init:RequestInit}>=[],held:Array<{path:string;resolve:(response:Response)=>void}>=[],listeners=new Set<()=>void>(),counts=new Map<string,number>(),wrappers=new Map<string,ReturnType<typeof runtime>>(),children=new Map<string,ReturnType<typeof runtime>>();
 const data=(path:string)=>{const account_id=path.split('/')[4];if(path.endsWith('/reading-preferences'))return {account_id,external_images:'ask',revision:1};if(path.endsWith('/knowledge-settings'))return {account_id,enabled:false,destination:{scope:'user',space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[],revision:1,progress:{processed:0,captured:0,skipped:0,last_error_code:null}};return {account_id,defty_principal_id:'defty',grants:[],personal_tokens:[]};};
 const json=(path:string,status=200)=>new Response(JSON.stringify(data(path)),{status,headers:{'Content-Type':'application/json'}});
 const api={getAccessToken:()=>token,fetch:async(path:string,init:RequestInit)=>{calls.push({path,init});if(hold&&(!init.method||init.method==='GET'))return new Promise<Response>(resolve=>held.push({path,resolve}));if(init.method==='PUT'&&denySave)return json(path,403);if(init.method==='PATCH'&&conflictReading)return json(path,409);return json(path);}};
 const context={api,createEmailConnectedClient,EmailConnectedError,emailReadingPreferenceRequest,getActiveSessionCacheScope:()=>sessionScope,isSameWebSession:(before:string,after:string)=>before===after,document:{hidden:false},addEventListener:(_name:string,fn:()=>void)=>listeners.add(fn),removeEventListener:(_name:string,fn:()=>void)=>listeners.delete(fn)};
 const resource=(accountId:string,scope:string,suffix:string)=>{const key=JSON.stringify([scope,accountId,suffix]);let child=children.get(key);if(!child){child=runtime(resourceSource,context);children.set(key,child);}return child.render(accountId,scope,suffix,suffix==='/knowledge-settings'?parseEmailKnowledgeSettings:parseEmailAgentAccess);};
 const names=['EmailReadingSettings','NativeEmailKnowledgeSettings','NativeEmailAgentAccess','NativeEmailDraftSyncSettings','NativeEmailSentCopySettings','NativeEmailTemplates','NativeEmailSignatures','NativeEmailRules'];
 const probes=Object.fromEntries(names.map(name=>[name,(props:{accountId:string;sessionScope:string})=>{counts.set(props.accountId+'/'+name,(counts.get(props.accountId+'/'+name)??0)+1);if(name==='EmailReadingSettings'){const key=JSON.stringify([sessionScope,props.accountId,'reading']);let child=children.get(key);if(!child){child=runtime(readingSource,context);children.set(key,child);}return child.render(props);}if(name==='NativeEmailKnowledgeSettings'||name==='NativeEmailAgentAccess')resource(props.accountId,props.sessionScope,name==='NativeEmailKnowledgeSettings'?'/knowledge-settings':'/agent-access');return null;}]));
 const page=ts.createSourceFile('page.tsx',readFileSync(new URL('../../app/(app)/email/page.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let host:ts.JsxElement|undefined,management:ts.JsxSelfClosingElement|undefined;const visit=(node:ts.Node)=>{if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(page)==='NativeEmailAccountPreferences')host=node;if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(page)==='NativeEmailAccountManagement')management=node;ts.forEachChild(node,visit);};visit(page);assert.ok(host);assert.ok(management);
 const hostContext={React,...probes,NativeEmailAccountPreferences:(props:{accountLabel:string;children:React.ReactNode})=>{let wrapper=wrappers.get(activeKey);if(!wrapper){wrapper=runtime(wrapperSource);wrappers.set(activeKey,wrapper);}return wrapper.render(props);},sessionScope,ignoreBusy:noop,denied:noop,afterActionRefresh:{current:noop}};
 const hostFn=runInNewContext(ts.transpileModule('(row=>('+host.getText(page)+'))',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,hostContext);
 const row=(accountId:string,provider='gmail')=>({account_id:accountId,provider,primary_address:accountId+'@example.test'});
 const element=(accountId:string,provider='gmail')=>{hostContext.sessionScope=sessionScope;return hostFn(row(accountId,provider));};
 return {calls,counts,wrappers,children,listeners,resource,get managementOutside(){return !host!.getText(page).includes(management!.getText(page));},element,render(accountId:string,provider='gmail'){const view=element(accountId,provider);activeKey=String(view.key);return renderToStaticMarkup(view);},toggle(accountId:string,open:boolean){wrappers.get(String(element(accountId).key))!.last.props.onToggle({currentTarget:{open}});},reading(accountId:string){return children.get(JSON.stringify([sessionScope,accountId,'reading']))!;},setConflict(){conflictReading=true;},setDenySave(){denySave=true;},hold(){hold=true;},release(){hold=false;for(const item of held.splice(0))item.resolve(json(item.path));},changeScope(){sessionScope='scope-2';token='token-2';},dispose(accountId?:string){for(const [key,child]of children)if(!accountId||JSON.parse(key)[1]===accountId)child.dispose();for(const [key,wrapper]of wrappers)if(!accountId||key.endsWith('/'+accountId))wrapper.dispose();}};
}
test('closed preference disclosure renders its account label without mounting children',()=>{
 let invoked=0;const Probe=()=>{invoked++;return <p>Loaded preferences</p>;};const html=renderToStaticMarkup(<NativeEmailAccountPreferences accountLabel="owner@example.test"><Probe/></NativeEmailAccountPreferences>);assert.match(html,/<summary[^>]*>owner@example.test<\/summary>/);assert.doesNotMatch(html,/<details[^>]*open|Loaded preferences/);assert.equal(invoked,0);
});
test('actual host mounts only explicitly opened account and keeps account health outside',async()=>{
 const f=fixture();f.render('a');f.render('b');assert.equal(f.counts.size,0);assert.equal(f.calls.length,0);assert.equal(f.managementOutside,true);
 f.toggle('a',false);f.render('a');assert.equal(f.calls.length,0);f.toggle('a',true);f.render('a');await tick();assert.equal([...f.counts.keys()].filter(key=>key.startsWith('a/')).length,7);assert.ok([...f.counts.keys()].every(key=>key.startsWith('a/')));assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.path.startsWith('/api/email/accounts/a/')));
 f.toggle('a',false);f.render('a');f.toggle('a',true);f.render('a');assert.equal(f.calls.length,3);f.render('b');assert.equal(f.calls.length,3);f.dispose();
});
test('actual reading choice and conflict survive collapse/reopen without another read',async()=>{
 const f=fixture();f.render('a');f.toggle('a',true);f.render('a');await tick();f.render('a');let reading=f.reading('a').last;
 find(reading,node=>node.type==='select').props.onChange({target:{value:'always'}});f.render('a');assert.equal(find(f.reading('a').last,node=>node.type==='select').props.value,'always');
 f.setConflict();find(f.reading('a').last,node=>node.type==='button'&&node.props.children==='Save reading choice').props.onClick();await tick();f.render('a');assert.match(renderToStaticMarkup(f.reading('a').last),/changed in another view/);const calls=f.calls.length;
 f.toggle('a',false);f.render('a');f.toggle('a',true);f.render('a');reading=f.reading('a').last;assert.equal(find(reading,node=>node.type==='select').props.value,'always');assert.match(renderToStaticMarkup(reading),/changed in another view/);assert.equal(f.calls.length,calls);f.dispose();
});
test('session/account unmount disposes actual held reading/resource hooks and suppresses late publication',async()=>{
 const f=fixture();f.hold();f.render('a');const oldKey=f.element('a').key;f.toggle('a',true);f.render('a');assert.equal(f.calls.length,3);const oldChildren=[...f.children.values()];f.dispose('a');assert.ok(f.calls.every(call=>call.init.signal?.aborted));assert.equal(f.listeners.size,0);f.changeScope();assert.notEqual(f.element('a').key,oldKey);f.render('a');assert.equal(f.calls.length,3);f.release();await tick();assert.ok(oldChildren.every(child=>child.lateWrites===0));f.dispose();
});
test('authority-denied resource keeps denial through collapse/reopen and does not replay a save',async()=>{
 const f=fixture();f.render('a');f.toggle('a',true);f.render('a');await tick();f.render('a');const before=f.resource('a','scope-1','/knowledge-settings');assert.ok(before.value);f.setDenySave();await before.save({enabled:true});let result=f.resource('a','scope-1','/knowledge-settings');assert.equal(result.value,null);assert.equal(result.uncertain,true);const calls=f.calls.length;
 f.toggle('a',false);f.render('a');f.toggle('a',true);f.render('a');result=f.resource('a','scope-1','/knowledge-settings');assert.equal(result.value,null);assert.equal(result.uncertain,true);assert.match(result.notice,/access changed/i);await result.save({enabled:true});assert.equal(f.calls.length,calls);f.dispose();
});
test('IMAP nomination remains conditional and scope keys include exact session/account identity',async()=>{
 const f=fixture();assert.equal(f.element('a').key,'scope-1/a');assert.equal(f.element('b').key,'scope-1/b');f.render('imap','imap_smtp');f.toggle('imap',true);f.render('imap','imap_smtp');await tick();assert.equal([...f.counts.keys()].filter(key=>key.startsWith('imap/')).length,8);f.dispose();
});
