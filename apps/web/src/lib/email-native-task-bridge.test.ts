import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeEmailTaskSeed,prepareNativeEmailTask} from './email-native-task-bridge';
import type {NativeEmailMessage} from './email-native-search';
import {taskDescriptionWithSource} from './task-source-link';
const target={account_id:'account-a',logical_message_id:'mail_'+'a'.repeat(64)};
const message:NativeEmailMessage={...target,revision:'r1',received_at:null,folders:['inbox'],flags:{seen:true,flagged:false,answered:false},data:{subject:'Private subject\nline',body:'Never copy body',sender:'private@example.test'}};
test('default task shares only a guarded link, and subject copy is explicit',()=>{
 const seed=nativeEmailTaskSeed(target,message,false);assert.equal(seed.title,'Follow up on email');assert.match(seed.sourceLink.href,/\/email\?account=account-a&message=mail_/);assert.doesNotMatch(JSON.stringify(seed),/Private|Never copy|private@example/);
 assert.equal(nativeEmailTaskSeed(target,message,true).title,'Follow up: Private subject line');
 assert.throws(()=>nativeEmailTaskSeed({...target,account_id:'account-b'},message,true));
});
test('task rich description keeps a clickable local source and treats edited text as text',()=>{
 const seed=nativeEmailTaskSeed(target,message,false),html=taskDescriptionWithSource('<img src=x onerror=alert(1)>',seed.sourceLink);
 assert.match(html,/&lt;img/);assert.match(html,/<a href="\/email\?account=account-a&amp;message=mail_/);assert.doesNotMatch(html,/<img/);
 for(const href of ['javascript:alert(1)','//evil.test','/\\evil.test','/email\nfoo'])assert.throws(()=>taskDescriptionWithSource('',{href,label:'Email'}));
});
test('task preparation rejects late results after a session change',async()=>{
 let current=true;await assert.rejects(prepareNativeEmailTask(target,true,{current:()=>current,read:async()=>{current=false;return message;}}),/Account access changed/);
 let reads=0;await assert.rejects(prepareNativeEmailTask(target,false,{current:()=>false,read:async()=>{reads++;return message;}}));assert.equal(reads,0);
});
