import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEmailConversation,parseNativeConversationPage,type NativeConversationState} from './email-native-conversation';
const anchor='mail_'+'a'.repeat(64),sibling='mail_'+'b'.repeat(64);
const message=(logical=anchor,revision='one',time='2026-10-04T00:00:00Z')=>({logical_message_id:logical,revision,received_at:time,folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{from:'owner@example.test',subject:'Thread'}});
const page=(items=[message()],next:string|null=null,complete=next===null)=>({account_id:'a',anchor_logical_message_id:anchor,items,next_cursor:next,has_more:next!==null,observed_at:'2026-10-04T00:00:00Z',source:'provider',consistency:'weak',complete,coverage:complete?'complete':'partial',failure_count:0,count:{returned:items.length,exact_total:null}});
const create=(overrides:Partial<Parameters<typeof createNativeEmailConversation>[0]>={})=>createNativeEmailConversation({accountId:'a',anchorId:anchor,current:()=>true,fetch:async()=>Response.json(page()),change:()=>{},denied:()=>{},...overrides});

test('conversation does not fetch until explicit start; paging stays attached to exact original account/anchor',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];const states:NativeConversationState[]=[];
 const reader=create({fetch:async(path,init)=>{calls.push({path,init});return Response.json(calls.length===1?page([message()], 'sealed_cursor'):page([message(sibling)]));},change:state=>states.push(state)});
 assert.equal(calls.length,0);await reader.start();assert.equal(calls.length,1);assert.equal(reader.snapshot().complete,false);await reader.more();
 assert.equal(calls.length,2);assert.ok(calls.every(row=>row.path===`/api/email/accounts/a/messages/${anchor}/conversation`));assert.deepEqual(calls.map(row=>JSON.parse(String(row.init.body))),[{cursor:null,limit:50},{cursor:'sealed_cursor',limit:50}]);assert.equal(reader.snapshot().items.length,2);assert.equal(reader.snapshot().complete,true);await reader.start();assert.equal(calls.length,2);reader.dispose();
});
test('pages merge only exact same-account logical IDs and chronology is stable without fabricated counts',async()=>{
 let index=0;const reader=create({fetch:async()=>Response.json(index++===0?page([message(sibling,'old','2026-10-05T00:00:00Z')],'next'):page([message(anchor,'one','2026-10-04T00:00:00Z'),message(sibling,'new','2026-10-05T00:00:00Z')]))});await reader.start();await reader.more();assert.deepEqual(reader.snapshot().items.map(row=>[row.account_id,row.logical_message_id,row.revision]),[['a',anchor,'one'],['a',sibling,'new']]);reader.dispose();
});
test('partial/failure results remain partial through final page; unknown exact_total cannot become an exact count',async()=>{
 const partial={...page(),complete:false,coverage:'partial',failure_count:2};const reader=create({fetch:async()=>Response.json(partial)});await reader.start();assert.equal(reader.snapshot().complete,false);assert.equal(reader.snapshot().failureCount,2);assert.match(reader.snapshot().notice,/Some related messages/);reader.dispose();
 assert.throws(()=>parseNativeConversationPage({...page(),count:{returned:1,exact_total:1}},'a',anchor));assert.throws(()=>parseNativeConversationPage({...page(),complete:true,failure_count:1},'a',anchor));
});
test('closed response rejects foreign anchor/account, provider locators, duplicate rows and contradictory pagination',()=>{
 for(const raw of [{...page(),account_id:'other'},{...page(),anchor_logical_message_id:sibling},{...page(),provider_locator:'secret'},{...page(),items:[{...message(),provider_source:{locator:'secret'}}]},{...page([message(),message()])},{...page(),next_cursor:'sealed',has_more:false},{...page(),consistency:'snapshot'}])assert.throws(()=>parseNativeConversationPage(raw,'a',anchor));
});
test('expired or cyclic paging retains summaries but prevents using stale continuations; reload resets history',async()=>{
 let index=0;const reader=create({fetch:async()=>{index++;if(index===2)return Response.json({code:'EMAIL_CONVERSATION_CURSOR_INVALID'},{status:409});return Response.json(page([message()],'next'));}});
 await reader.start();await reader.more();assert.equal(reader.snapshot().state,'failed');assert.equal(reader.snapshot().items.length,1);assert.equal(reader.snapshot().nextCursor,null);assert.match(reader.snapshot().notice,/expired or changed/);await reader.reload();assert.equal(reader.snapshot().state,'available');await reader.more();assert.equal(reader.snapshot().state,'failed');assert.match(reader.snapshot().notice,/could not continue/);reader.dispose();
});
test('denial clears related rows and scope change cannot publish a held provider result',async()=>{
 let index=0,denied=0;const reader=create({denied:()=>denied++,fetch:async()=>Response.json(index++===0?page([message()],'next'):{code:'EMAIL_ACCESS_DENIED'},{status:index===1?200:403})});await reader.start();await reader.more();assert.equal(denied,1);assert.equal(reader.snapshot().state,'denied');assert.deepEqual(reader.snapshot().items,[]);reader.dispose();
 let current=true,release!:(r:Response)=>void;const states:NativeConversationState[]=[];const held=create({current:()=>current,change:state=>states.push(state),fetch:()=>new Promise(resolve=>{release=resolve;})});const pending=held.start(),count=states.length;current=false;held.dispose();release(Response.json(page()));await pending;assert.equal(states.length,count);assert.deepEqual(held.snapshot().items,[]);
});
test('explicit pages are bounded even with empty results and enormous responses are rejected',async()=>{
 let calls=0;const reader=create({fetch:async()=>Response.json(page([],`cursor_${++calls}`))});await reader.start();for(let count=0;count<20;count++)await reader.more();assert.equal(calls,10);assert.equal(reader.snapshot().limited,true);assert.equal(reader.snapshot().complete,false);assert.match(reader.snapshot().notice,/More messages may exist/);reader.dispose();
 const huge=create({fetch:async()=>new Response('x'.repeat(4*1024*1024+1))});await huge.start();assert.equal(huge.snapshot().state,'failed');assert.deepEqual(huge.snapshot().items,[]);huge.dispose();
});
test('IMAP header relationships remain partial after final page and require honest bounded metadata',async()=>{
 const related={...page(),complete:false,coverage:'partial',thread_basis:'message_headers',limitations:['Header relationships can omit older messages.']};assert.equal(parseNativeConversationPage(related,'a',anchor,true).thread_basis,'message_headers');
 const reader=create({headerRelated:true,fetch:async()=>Response.json(related)});await reader.start();assert.equal(reader.snapshot().complete,false);assert.equal(reader.snapshot().threadBasis,'message_headers');assert.deepEqual(reader.snapshot().limitations,related.limitations);assert.equal(reader.snapshot().nextCursor,null);reader.dispose();
 for(const raw of [page(),{...related,complete:true,coverage:'complete'},{...related,thread_basis:'provider_thread'},{...related,limitations:[]},{...related,limitations:Array(33).fill('Too many')},{...related,limitations:['x'.repeat(129)]},{...related,limitations:['bad\ncontrol']},{...related,private_header_id:'private'}])assert.throws(()=>parseNativeConversationPage(raw,'a',anchor,true));
});
