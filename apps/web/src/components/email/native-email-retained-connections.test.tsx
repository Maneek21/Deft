import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeEmailRetainedConnectionList} from './native-email-retained-connections';
import {nativeEmailConnectionKey,type NativeEmailConnectionState} from '@/lib/email-native-connection-targets';
const state:NativeEmailConnectionState={state:'available',targets:[{provider:'gmail',primary_address:'work@example.com',display_label:'Work',native_email:{account_id:'private-account',resource_binding_id:'11111111-1111-4111-8111-111111111111',state:'available'}}],hasMore:false,unavailableCount:0,busy:false,working:null,uncertain:[],notice:''};
const render=(value=state)=>renderToStaticMarkup(createElement(NativeEmailRetainedConnectionList,{state:value,onRefresh:()=>{},onAdopt:()=>{}}));
test('native settings shows real retained account address and explicit adoption without credentials, OAuth or Exposure controls',()=>{
 const html=render();assert.match(html,/work@example.com/);assert.match(html,/Gmail/);assert.match(html,/Use in Deft/);assert.match(html,/Refresh connections/);assert.match(html,/keeps agent access separate/);assert.doesNotMatch(html,/private-account|11111111|password|OAuth|Exposure|25 fields|border-b/);
});
test('active setup has no duplicate enable button; uncertain/unavailable/partial discovery states are honest',()=>{
 const active={...state,targets:state.targets.map(target=>({...target,native_email:{...target.native_email,state:'active' as const}}))};assert.match(render(active),/Enabled in Deft/);assert.doesNotMatch(render(active),/Use in Deft/);
 const uncertain=render({...state,uncertain:[nativeEmailConnectionKey(state.targets[0]!)]});assert.match(uncertain,/Setup not confirmed/);assert.match(uncertain,/disabled=""/);
 const partial=render({...state,hasMore:true,unavailableCount:2});assert.match(partial,/More connections may exist/);assert.match(partial,/2 existing connections are unavailable/);
});
test('current active account catalogue overrides unavailable migration setup only for the exact account identity',()=>{
 const unavailable={...state,targets:state.targets.map(target=>({...target,native_email:{...target.native_email,state:'unavailable' as const}}))};
 const exact=renderToStaticMarkup(createElement(NativeEmailRetainedConnectionList,{state:unavailable,activeAccountIds:['private-account'],onRefresh:()=>{},onAdopt:()=>{}}));
 assert.match(exact,/Already in Email/);assert.doesNotMatch(exact,/Setup unavailable|Use in Deft/);
 const other=renderToStaticMarkup(createElement(NativeEmailRetainedConnectionList,{state:unavailable,activeAccountIds:['another-account'],onRefresh:()=>{},onAdopt:()=>{}}));assert.match(other,/Setup unavailable/);assert.doesNotMatch(other,/Already in Email/);
});
