import test from 'node:test';
import assert from 'node:assert/strict';
import {Children,createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {NativeEmailActions,NativeEmailSecondaryActions,nativeEmailModificationNotice,nativeEmailRecoveryActions} from './native-email-actions';
import {NativeEmailActionStatus} from './native-email-action-status';
import type {NativeEmailMessage} from '@/lib/email-native-search';
const message=(account='a'):NativeEmailMessage=>({account_id:account,logical_message_id:'mail_'+'a'.repeat(64),revision:'revision',received_at:null,folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Mail'}});

test('M23 contextual Spam and Restore controls appear only in More with truthful recovery names',()=>{
 const accounts=[{account_id:'a',provider:'gmail',capabilities:['read','modify']}];
 for(const [folder,label] of [['inbox','Move to Spam'],['spam','Not spam — move to Inbox'],['trash','Restore from Trash']] as const){const messages=[{...message(),folders:[folder]}],props={accounts,messages,busy:false,onAction:()=>{},onMove:()=>{}};
  const html=renderToStaticMarkup(createElement(NativeEmailActions,props));assert.ok(html.includes(`aria-label="${label}"`),folder+'/'+label);assert.doesNotMatch(html,/Report spam|permanent|Restore to Inbox/);
  const primary=renderToStaticMarkup(createElement(NativeEmailActions,{...props,primaryOnly:true}));assert.doesNotMatch(primary,/Move to Spam|Not spam|Restore from Trash/);
 }
});
test('M23 context follows every actual row, Trash precedence and current supported modify accounts',()=>{
 const accounts=[{account_id:'a',provider:'gmail',capabilities:['modify']},{account_id:'b',provider:'microsoft',capabilities:['modify']}],row=(account:string,folders:string[])=>({...message(account),folders});
 for(const folders of [['inbox'],['sent'],['label:opaque'],['folder:unknown']])assert.deepEqual(nativeEmailRecoveryActions(accounts,[row('a',folders),row('b',folders)]),['spam']);
 assert.deepEqual(nativeEmailRecoveryActions(accounts,[row('a',['spam','trash']),row('b',['trash'])]),['restore']);
 assert.deepEqual(nativeEmailRecoveryActions(accounts,[row('a',['spam']),row('b',['spam'])]),['not_spam']);
 for(const folders of [['inbox'],['trash']])assert.deepEqual(nativeEmailRecoveryActions(accounts,[row('a',['spam']),row('b',folders)]),[]);
 for(const unsupported of [{account_id:'a',provider:'imap_smtp',capabilities:['modify']},{account_id:'a',provider:'gmail',capabilities:['read']},{account_id:'other',provider:'gmail',capabilities:['modify']}])assert.deepEqual(nativeEmailRecoveryActions([unsupported],[message()]),[]);
 assert.deepEqual(nativeEmailRecoveryActions(accounts,[]),[]);
 const gmail=renderToStaticMarkup(createElement(NativeEmailSecondaryActions,{accounts,messages:[row('a',['trash'])],busy:false,onMove:()=>{},onAction:()=>{}}));assert.match(gmail,/Gmail may restore them outside Inbox/);assert.doesNotMatch(gmail,/Move message to Trash/);
 const graph=renderToStaticMarkup(createElement(NativeEmailSecondaryActions,{accounts,messages:[row('b',['trash'])],busy:false,onMove:()=>{},onAction:()=>{}}));assert.match(graph,/Move messages from Trash to Inbox/);
});
test('M23 deliberate contextual callbacks close More once and cannot run when busy, denied or stale capability',()=>{
 const accounts=[{account_id:'a',provider:'gmail',capabilities:['modify']}],chosen:string[]=[],closed:string[]=[];
 for(const [folder,kind] of [['inbox','spam'],['spam','not_spam'],['trash','restore']] as const)for(const blocked of ['none','busy','denied','revoked']){
  const messages=[{...message(),folders:[folder]}],tree=NativeEmailSecondaryActions({accounts,messages,busy:blocked==='busy',unavailableReason:blocked==='denied'?'Reconnect':undefined,onAction:kind=>chosen.push(kind),onMove:()=>{}}),button=Children.toArray(tree.props.children).find((node:any)=>['Move to Spam','Not spam — move to Inbox','Restore from Trash'].includes(node.props?.['aria-label'])) as any;
  if(blocked==='revoked')accounts[0].capabilities=[];
  button.props.onClick({currentTarget:{closest:()=>({removeAttribute:()=>closed.push(kind)})}});accounts[0].capabilities=['modify'];
 }
 assert.deepEqual(chosen,['spam','not_spam','restore']);assert.deepEqual(closed,chosen);
});
test('actual action controls are accessible, compact, and cross-account Move stays disabled',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailActions,{messages:[message(),message('b')],busy:false,onAction:()=>{},onMove:()=>{}}));
 for(const label of ['Mark read','Star','Archive','More message actions'])assert.match(html,new RegExp(`aria-label="${label}"`));
 assert.match(html,/disabled=""[^>]*>.*?Move to…<\/button>/);assert.match(html,/Choose messages from one account to move/);assert.doesNotMatch(html,/border-b/);
 const primary=renderToStaticMarkup(createElement(NativeEmailActions,{messages:[{...message(),flags:{seen:true,flagged:true,answered:false}}],busy:false,primaryOnly:true,onAction:()=>{},onMove:()=>{}}));assert.match(primary,/aria-label="Mark unread"/);assert.match(primary,/aria-label="Remove star"/);assert.doesNotMatch(primary,/More message actions/);
});
test('uncertain status offers status-only recovery and no Undo/retry mutation button',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailActionStatus,{state:{busy:false,summary:'1 unconfirmed',groups:[{accountId:'a',operationId:'opaque-op',kind:'archive',ids:[message().logical_message_id],state:'uncertain',notice:'The result is unconfirmed.',result:null}]},accounts:[{account_id:'a',primary_address:'owner@example.test'}],refreshing:false,onCheck:()=>{},onUndo:()=>{}}));
 assert.match(html,/Check status/);assert.match(html,/owner@example.test/);assert.doesNotMatch(html,/opaque-op|>Undo<\/button>|Retry action/);
});
test('capability gaps disable every mutation with a reconnect explanation, including mixed account selection',()=>{
 const accounts=[{account_id:'a',capabilities:['read','modify']},{account_id:'b',capabilities:['read']}];
 assert.equal(nativeEmailModificationNotice(accounts,[message()]),undefined);
 const reason=nativeEmailModificationNotice(accounts,[message(),message('b')]);assert.match(reason!,/Reconnect/);
 assert.ok(nativeEmailModificationNotice([{account_id:'a'}],[message()]));
 const html=renderToStaticMarkup(createElement(NativeEmailActions,{messages:[message()],busy:false,unavailableReason:reason,onAction:()=>{},onMove:()=>{}}));
 assert.equal((html.match(/disabled=""/g)??[]).length,5);assert.match(html,/Reconnect the selected account/);
});
test('host uses exact account folder filters, explicit selection and retained native refresh after verified action',()=>{
 const source=readFileSync(new URL('../../app/(app)/email/page.tsx',import.meta.url),'utf8');assert.match(source,/scopeAccounts=folderScope\?mailboxAccounts.filter/);assert.match(source,/type="checkbox"/);const hook=source.match(/afterActionRefresh\.current=([^;]+);/);assert.ok(hook);const calls:unknown[][]=[];const refresh=new Function('refreshMailbox','return ('+hook[1]+');')((...args:unknown[])=>{calls.push(args);});
 refresh(['a']);assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),[true,['a']],'confirmed actions must retain their affected account scope');assert.equal(calls[0][2],undefined);
 const targets=[{account_id:'a',logical_message_id:message().logical_message_id}];refresh(['a'],targets);assert.equal(calls.length,2);assert.deepEqual(calls[1].slice(0,2),[true,['a']]);assert.equal(calls[1][2],targets,'exact affected messages must reach the retained refresh');
 const reader=readFileSync(new URL('./native-email-reader.tsx',import.meta.url),'utf8');assert.match(reader,/\[accountId,logicalMessageId,sessionScope,revision\]/);assert.doesNotMatch(reader,/\[accountId,logicalMessageId,sessionScope,revision,actions/);
});
test('native Gmail offers a named Labels action only in More actions',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailActions,{messages:[message()],busy:false,onAction:()=>{},onMove:()=>{},onLabels:()=>{}}));
 assert.match(html,/aria-label="Change Gmail labels"/);assert.match(html,/>Labels…<\/button>/);
 const primary=renderToStaticMarkup(createElement(NativeEmailActions,{messages:[message()],busy:false,primaryOnly:true,onAction:()=>{},onMove:()=>{},onLabels:()=>{}}));assert.doesNotMatch(primary,/Change Gmail labels/);
 const unavailable=renderToStaticMarkup(createElement(NativeEmailActions,{messages:[message()],busy:false,onAction:()=>{},onMove:()=>{}}));assert.doesNotMatch(unavailable,/Change Gmail labels/);
 let chosen=0,closed=0;for(const [messages,busy,reason] of [[[message()],false,undefined],[[message(),message('b')],false,undefined],[[message()],true,undefined],[[message()],false,'Reconnect']] as const){
  const tree=NativeEmailSecondaryActions({messages,busy,unavailableReason:reason,onAction:()=>{},onMove:()=>{},onLabels:()=>{chosen++;}}),button=Children.toArray(tree.props.children).find((node:any)=>node.props?.['aria-label']==='Change Gmail labels') as any;
  button.props.onClick({currentTarget:{closest:()=>({removeAttribute:()=>{closed++;}})}});
 }
 assert.equal(chosen,1);assert.equal(closed,1);
});
