import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';import ts from 'typescript';
import {NativeAccountLifecycleView} from './native-email-account-lifecycle';
import type {NativeAccountLifecycle,NativeLifecycleState} from '@/lib/email-native-account-lifecycle';
const value:NativeAccountLifecycle={schema_version:'deft.email_account_lifecycle.v1',account_id:'technical-account-hidden',provider:'gmail',authority_mode:'standalone',state:'active',revision:1,native_revision:2,credential_revision:3,capabilities:['read','send'],available_capabilities:['read','modify','send'],adoption_available:false,connection_available:true};
const render=(patch:Partial<NativeAccountLifecycle>={},state:Partial<NativeLifecycleState>={},confirm:'disconnect'|'revoke'|null=null)=>renderToStaticMarkup(<NativeAccountLifecycleView state={{value:{...value,...patch},busy:false,needsReload:false,denied:false,notice:'',...state}} selected={['read','send']} confirm={confirm} onSelect={()=>{}} onApply={()=>{}} onConfirm={()=>{}} onReload={()=>{}}/>);
test('compact lifecycle settings show account-scoped access and ordinary actions without technical IDs or agent grants',()=>{
 const html=render();assert.match(html,/Read mail/);assert.match(html,/Organize mail/);assert.match(html,/Send mail/);assert.match(html,/Pause account/);assert.match(html,/Disconnect account/);assert.doesNotMatch(html,/technical-account-hidden|credential_revision|provider_locator|native|standalone|operation records/);
 const legacy=render({authority_mode:'legacy',revision:0,adoption_available:true});assert.match(legacy,/Enable Email/);assert.match(legacy,/Ready to enable/);assert.match(legacy,/separate from agent access/);assert.doesNotMatch(legacy,/Pause account|native|adopted/);
});
test('paused account reconnect remains discoverable; revoked accounts are status-only with no erased-mail claim',()=>{
 const paused=render({state:'paused'});assert.match(paused,/Reconnect account/);assert.doesNotMatch(paused,/Pause account/);
 const revoked=render({state:'revoked'});assert.match(revoked,/were not deleted/);assert.doesNotMatch(revoked,/Reconnect account|Confirm revoke|checkbox/);
});
test('destructive access transition has a scoped review and uncertain mutation disables changes until GET',()=>{
 const review=render({}, {},'revoke');assert.match(review,/Revoke this account/);assert.match(review,/Saved mail, drafts, and sending history are kept/);assert.match(review,/Confirm revoke access/);assert.match(review,/Keep account/);
 const uncertain=render({}, {needsReload:true});assert.match(uncertain,/Check current account settings/);assert.match(uncertain,/disabled=""[^>]*>Pause account/);
 const page=readFileSync(new URL('../../app/(app)/email/page.tsx',import.meta.url),'utf8');assert.match(page,/NativeEmailAccountManagement/);assert.match(page,/if\(value\.state!=='active'\)\{denied\(value\.account_id\)/);
});

test('actual lifecycle surface reconnect uses freshly loaded exact consent and rejects held callbacks after owner disposal',()=>{
 const source=readFileSync(new URL('./native-email-account-lifecycle.tsx',import.meta.url),'utf8'),javascript=ts.transpileModule(source+'\nexport {NativeAccountLifecycleSurface,NativeManagedAccount};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const states:unknown[]=[],refs:Array<{current:unknown}>=[],cleanups:Array<()=>void>=[],nominations:unknown[]=[];let index=0,refIndex=0,effects=true,current=true,port:Record<string,unknown>|undefined;
 const exports:Record<string,unknown>={};runInNewContext(javascript,{exports,require:(name:string)=>name==='react'?{useState:(initial:unknown)=>{const slot=index++;if(!(slot in states))states[slot]=initial;return [states[slot],(next:unknown)=>{states[slot]=next;}];},useRef:(initial:unknown)=>{const slot=refIndex++;return refs[slot]??(refs[slot]={current:initial});},useEffect:(effect:()=>void|(()=>void))=>{if(effects){const cleanup=effect();if(cleanup)cleanups.push(cleanup);}}}:name==='react/jsx-runtime'?{jsx:(type:unknown,props:unknown)=>({type,props}),jsxs:(type:unknown,props:unknown)=>({type,props})}:name==='@/lib/api'?{api:{getAccessToken:()=> 'token'},isSameWebSession:()=>current}:name==='@/lib/session-cache'?{getActiveSessionCacheScope:()=> 'scope'}:name==='@/lib/email-native-account-lifecycle'?{createNativeAccountLifecycle:(options:Record<string,unknown>)=>{port=options;return {load:()=>{},dispose:()=>{}};}}:{} });
 const surface=exports.NativeAccountLifecycleSurface as (props:Record<string,unknown>)=>{props:Record<string,unknown>};
 const render=()=>{index=0;refIndex=0;const tree=surface({accountId:value.account_id,sessionScope:'scope',onChanged:()=>{},onDenied:()=>{},onProviderReconnect:(caps:unknown)=>nominations.push(caps)});effects=false;return tree.props;};
 render();assert.ok(port);(port.change as (next:NativeLifecycleState)=>void)({value:{...value,connection_available:false},busy:false,denied:false,needsReload:false,notice:''});let props=render();(props.onProviderReconnect as ()=>void)();assert.deepEqual(Array.from(nominations[0] as string[]),['read','send']);
 (port.change as (next:NativeLifecycleState)=>void)({value:{...value,capabilities:['read'],connection_available:false},busy:false,denied:false,needsReload:false,notice:''});props=render();(props.onProviderReconnect as ()=>void)();assert.deepEqual(Array.from(nominations[1] as string[]),['read']);const held=props.onProviderReconnect as ()=>void;
 (port.change as (next:NativeLifecycleState)=>void)({value:{...value,connection_available:false},busy:true,denied:false,needsReload:false,notice:''});held();assert.equal(nominations.length,2,'a held fresh settings reload must not nominate older access');
 current=false;held();assert.equal(nominations.length,2);current=true;cleanups.forEach(cleanup=>cleanup());held();assert.equal(nominations.length,2);
 const managed=exports.NativeManagedAccount as (props:Record<string,unknown>)=>{props:Record<string,unknown>};states.splice(0);refs.splice(0);const complete:Record<string,unknown>[]=[];
 const managedRender=()=>{index=0;refIndex=0;return managed({account:{account_id:value.account_id,provider:'gmail',state:'active',authority_mode:'standalone',revision:1,native_revision:2},sessionScope:'scope',onChanged:()=>{},onDenied:()=>{},onProviderReconnect:(next:Record<string,unknown>)=>complete.push(next)}).props;};
 let details=managedRender();(details.onToggle as (event:unknown)=>void)({currentTarget:{open:true}});details=managedRender();const child=(details.children as Array<{props:Record<string,unknown>}|false>)[1];assert.ok(child);(child.props.onProviderReconnect as (caps:string[])=>void)(['read','send']);assert.equal(complete[0].account_id,value.account_id);assert.deepEqual(Array.from(complete[0].capabilities as string[]),['read','send'],'the parent must carry exact fresh consent into the setup nomination');
});
