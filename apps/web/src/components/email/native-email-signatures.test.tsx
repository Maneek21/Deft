import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeSignaturePreferencesView} from './native-email-signatures';
import {emptyNativeSignatureState,type NativeSignatureState} from '@/lib/email-native-signatures';
const entry={address:'owner@example.com',plain:'Owner signature',html:'',placement:'both' as const};
const old={address:'old@example.com',plain:'Former sender signature',html:'',placement:'reply' as const};
const ready:NativeSignatureState={status:'ready',saved:{account_id:'private-account',revision:2,preferences:{identities:[entry,old]},identity_availability:{available:[{address:entry.address,identity_key:'a'.repeat(64)}],saved:[{address:entry.address,identity_key:'a'.repeat(64),current:true},{address:old.address,identity_key:'b'.repeat(64),current:false}]}},entry,dirty:true,busy:false,uncertain:false,conflict:false,notice:''};
const render=(state=ready)=>renderToStaticMarkup(createElement(NativeSignaturePreferencesView,{state,primaryAddress:entry.address,onSelect:()=>{},onEdit:()=>{},onSave:()=>{},onReload:()=>{},onCheck:()=>{}}));
test('signature settings edit the primary sender and keep unavailable identities read-only with honest insertion status',()=>{
 const html=render();assert.match(html,/Signature text/);assert.match(html,/owner@example.com/);assert.match(html,/Save signature preferences/);assert.match(html,/Insertion preference/);assert.match(html,/new untouched drafts/);assert.match(html,/Existing drafts stay unchanged/);assert.match(html,/Former sender signature/);assert.match(html,/sender is currently unavailable/);assert.equal((html.match(/<textarea/g)??[]).length,1);assert.doesNotMatch(html,/private-account|aaaaaaaa|bbbbbbbb|dangerously|border-b/);
});
test('uncertain save displays read-only status checking and explicitly labelled discard, with further save disabled',()=>{
 const html=render({...ready,uncertain:true,notice:'The saved signature could not be confirmed.'});assert.match(html,/Check saved signature/);assert.match(html,/Reload and discard signature edits/);assert.match(html,/disabled=""[^>]*>Save signature preferences/);assert.match(html,/role="status"/);
});
test('missing primary identity and denied states have no editable signature or hidden retained content',()=>{
 const unknown=render({...ready,entry:null});assert.match(unknown,/primary sender address could not be verified/);assert.match(unknown,/Former sender signature/);assert.doesNotMatch(unknown,/<textarea/);
 const denied=render({...emptyNativeSignatureState(),status:'denied',notice:'Signature access changed.'});assert.doesNotMatch(denied,/Owner signature|Former sender|owner@example.com|old@example.com/);assert.match(denied,/Signature access changed/);
});
test('signature sender selector contains only current verified addresses and cannot discard dirty edits by switching identity',()=>{
 const alias={address:'alias@example.com',identity_key:'c'.repeat(64)},state={...ready,saved:{...ready.saved!,identity_availability:{...ready.saved!.identity_availability,available:[...ready.saved!.identity_availability.available!,alias]}}};const html=render(state);assert.match(html,/aria-label="Signature sender address"[^>]*disabled=""/);assert.match(html,/<option value="alias@example.com">/);assert.doesNotMatch(html,/<option value="old@example.com">/);assert.match(html,/old@example.com/);
});
