import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeOutboxApi,createNativeOutboxSend,mergeNativeOutboxRows,parseNativeOutboxRow,NativeOutboxError,type NativeOutboxRow} from './email-native-outbox';
import {createNativeDraftWriter,emptyNativeDraft,type NativeDraft,type NativeDraftSaveState} from './email-native-drafts';
const draft='11111111-1111-4111-8111-111111111111',outbox='22222222-2222-4222-8222-222222222222',operation='33333333-3333-4333-8333-333333333333';
export const row:NativeOutboxRow={outbox_id:outbox,operation_id:operation,draft_id:draft,draft_revision:4,revision:1,state:'queued',account_id:'account',from_address:'owner@example.com',subject:'Hello',to:'friend@example.com',cc:'',bcc:'',earliest_dispatch_at:'2026-10-04T00:00:10.000Z',undo_until:'2026-10-04T00:00:10.000Z',schedule:null,reason:null,delivery_status:'unknown',created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z'};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function fixture(fetch:(path:string,init:RequestInit)=>Promise<Response>){let active=true,queued=0,accepted=0,cancelled=0,legacy=0,denied=0;const state:NativeDraftSaveState={revision:4,dirty:false,state:'idle',notice:'',content:{...emptyNativeDraft(),to:'friend@example.com'}};const writer={save:async()=>true,snapshot:()=>state};
 const client=createNativeOutboxSend({accountId:'account',draftId:draft,current:()=>active,fetch,writer:()=>writer,change:()=>{},rowChanged:()=>{},denied:()=>denied++,queued:()=>queued++,accepted:()=>accepted++,cancelled:()=>cancelled++,legacyInspect:async()=>{legacy++;return {state:'idle',locked:false,busy:false,revision:null,notice:''};}});
 return {client,writer,state,stop:()=>{active=false;},counts:()=>({queued,accepted,cancelled,legacy,denied})};}
test('closed Outbox DTO pins account and hides provider locators/false delivery claims',()=>{
 assert.deepEqual(parseNativeOutboxRow(row,'account'),row);for(const value of [{...row,account_id:'other'},{...row,provider_message_id:'private'},{...row,delivery_status:'delivered'},{...row,revision:129},{...row,schedule:{wall_time:'2026-10-04T02:30',zone:'UTC',ambiguity:'reject',missed_policy:'pause_if_late'}}])assert.throws(()=>parseNativeOutboxRow(value,'account'));
});
test('late older pages cannot regress confirmed status and host list remains bounded',()=>{
 const accepted={...row,state:'accepted' as const,revision:3};assert.equal(mergeNativeOutboxRows([accepted],[row])[0]!.state,'accepted');assert.throws(()=>mergeNativeOutboxRows([row],[{...row,operation_id:outbox}]));assert.throws(()=>mergeNativeOutboxRows([],Array.from({length:501},(_,index)=>({...row,account_id:String(index)}))),/Only 500/);
});
test('queueing freezes immediately, flushes exact scalar/file revision and sends stable request nomination with default Undo',async()=>{
 let resolve!:()=>void;const calls:RequestInit[]=[];const f=fixture(async(_path,init)=>{calls.push(init);return response(row,202);});f.writer.save=()=>new Promise<boolean>(done=>{resolve=()=>{f.state.revision=4;done(true);};});const held=f.client.send();assert.equal(f.client.snapshot().locked,true);assert.equal(calls.length,0);await f.client.send();resolve();await held;assert.equal(calls.length,1);const body=JSON.parse(calls[0]!.body as string);assert.deepEqual(Object.keys(body).sort(),['draft_id','expected_revision','request_id','undo_delay_seconds']);assert.equal(body.undo_delay_seconds,10);assert.equal(body.expected_revision,4);assert.match(body.request_id,/^[a-f0-9-]{36}$/);assert.equal(f.client.snapshot().state,'reserved');assert.equal(f.counts().accepted,0);assert.equal(f.counts().queued,1);await f.client.send();assert.equal(calls.length,1);f.client.dispose();
});
test('lost enqueue ACK permits only exact request GET, even null; no new request or direct send fallback',async()=>{
 const paths:string[]=[],writes:string[]=[];const f=fixture(async(path,init)=>{paths.push(path);if(init.method==='POST'){writes.push(init.body as string);throw Error('lost');}return response({operation:null});});await f.client.send();await f.client.check();await f.client.send();assert.equal(writes.length,1);assert.match(paths[1]!,/\/outbox\/requests\/[a-f0-9-]+$/);assert.equal(f.client.snapshot().locked,true);assert.equal(f.client.snapshot().state,'unknown');assert.equal(f.counts().legacy,0);f.client.dispose();
});
test('submitted reopening queries exact draft revision; direct receipt fallback only follows proven null',async()=>{
 const paths:string[]=[];const f=fixture(async(path)=>{paths.push(path);return response({operation:row});});await f.client.inspect(4,true);assert.match(paths[0]!,/\/drafts\/11111111-1111-4111-8111-111111111111\/outbox\/4$/);assert.equal(f.counts().legacy,0);assert.equal(f.client.snapshot().state,'reserved');f.client.dispose();
 const legacy=fixture(async()=>response({operation:null}));await legacy.client.inspect(4,false);assert.equal(legacy.counts().legacy,1);assert.equal(legacy.client.snapshot().locked,false);legacy.client.dispose();
 const failed=fixture(async()=>response({},503));await failed.client.inspect(4,true);assert.equal(failed.counts().legacy,0);assert.equal(failed.client.snapshot().locked,true);failed.client.dispose();
});
test('Cancel/Undo only targets queued CAS; lost cancel ACK only checks original outcome and confirmed cancel restores draft',async()=>{
 let posts=0,lookup={...row};const f=fixture(async(_path,init)=>{if(init.method==='POST'){posts++;if(posts===1)return response(row,202);throw Error('lost cancel');}return response({operation:lookup});});await f.client.send();await f.client.cancel();await f.client.cancel();assert.equal(posts,2);lookup={...row,state:'cancelled',revision:2};await f.client.check();assert.equal(f.counts().cancelled,1);assert.equal(f.client.snapshot().locked,true);assert.match(f.client.snapshot().notice,/back in Deft Drafts/);f.client.dispose();
 const sending=fixture(async()=>response({operation:{...row,state:'submitting',revision:2}}));await sending.client.inspect(4,true);await sending.client.cancel();assert.equal(sending.counts().cancelled,0);sending.client.dispose();
});
test('DST validation preserves editable saved draft and exposes useful error; ambiguous failures remain locked',async()=>{
 const f=fixture(async()=>response({code:'EMAIL_OUTBOX_SCHEDULE_GAP'},422));await f.client.send({wall_time:'2026-03-08T02:30',zone:'America/New_York',ambiguity:'reject',missed_policy:'pause_if_late'});assert.equal(f.client.snapshot().locked,false);assert.match(f.client.snapshot().notice,/does not exist/);f.client.dispose();
 const uncertain=fixture(async()=>response({code:'EMAIL_OUTBOX_UNAVAILABLE'},503));await uncertain.client.send();assert.equal(uncertain.client.snapshot().locked,true);uncertain.client.dispose();
});
test('held scope change discards queued receipt; denial clears writer and false ack cannot publish queue success',async()=>{
 let resolve!:(value:Response)=>void;const f=fixture(()=>new Promise(done=>{resolve=done;}));const pending=f.client.send();await new Promise(done=>setTimeout(done,0));f.stop();resolve(response(row,202));await pending;assert.equal(f.counts().queued,0);f.client.dispose();
 const denied=fixture(async()=>response({code:'EMAIL_ACCESS_DENIED'},403));await denied.client.send();assert.equal(denied.counts().denied,1);assert.equal(denied.client.snapshot().state,'denied');denied.client.dispose();
 const foreign=fixture(async()=>response({...row,draft_id:outbox},202));await foreign.client.send();assert.equal(foreign.counts().queued,0);assert.equal(foreign.client.snapshot().locked,true);foreign.client.dispose();
});
test('paginated API and reschedule accept only scoped opaque cursor and exact changed CAS schedule',async()=>{
 const schedule={wall_time:'2026-10-05T14:30',zone:'Asia/Kolkata',ambiguity:'reject' as const,missed_policy:'pause_if_late' as const};let path='',body:unknown;
 const api=createNativeOutboxApi({current:()=>true,fetch:async(url,init)=>{path=url;body=init.body?JSON.parse(init.body as string):null;return init.method==='POST'?response({...row,revision:2,schedule:{...schedule,instant:'2026-10-05T09:00:00.000Z',rules_version:'tzdb'}}):response({items:[row],next_cursor:'sealed_cursor',has_more:true});}});
 assert.equal((await api.list('account','opaque')).items.length,1);assert.match(path,/cursor=opaque$/);const next=await api.reschedule(row,schedule);assert.equal(next.revision,2);assert.deepEqual(body,{expected_revision:1,schedule});api.dispose();
 const bounded=createNativeOutboxApi({current:()=>true,fetch:async()=>new Response('x'.repeat(65537))});await assert.rejects(bounded.read('account',outbox),NativeOutboxError);bounded.dispose();
});
test('actual serialized draft writer joins final text and saved attachment metadata before immutable Outbox enqueue',async()=>{
 const file={file_id:operation,filename:'note.txt',media_type:'text/plain',size_bytes:4,sha256:'a'.repeat(64)};
 const draftRow=(content=emptyNativeDraft(),revision=1):NativeDraft=>({draft_id:draft,revision,content_revision:revision,status:'draft',content,origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'});
 let stored=draftRow({...emptyNativeDraft(),to:'friend@example.com',attachments:[file]}),posts=0;
 const writer=createNativeDraftWriter({accountId:'account',draftId:draft,initial:stored,current:()=>true,change:()=>{},api:{read:async()=>stored,save:async(_account,_draft,revision,content)=>{stored=draftRow(content,revision+1);return stored;}}});writer.edit({...writer.snapshot().content,body:'Final text'});
 const sender=createNativeOutboxSend({accountId:'account',draftId:draft,current:()=>true,writer:()=>writer,change:()=>{},rowChanged:()=>{},denied:()=>{},queued:()=>{},accepted:()=>{},cancelled:()=>{},legacyInspect:async()=>({state:'idle',locked:false,busy:false,revision:null,notice:''}),undoDelaySeconds:()=>30,fetch:async(_path,init)=>{posts++;assert.equal(stored.content.body,'Final text');assert.deepEqual(stored.content.attachments,[file]);const body=JSON.parse(init.body as string);assert.equal(body.expected_revision,stored.revision);assert.equal(body.undo_delay_seconds,30);assert.equal(body.mime_bytes,undefined);return response({...row,draft_revision:stored.revision},202);}});
 await sender.send();assert.equal(posts,1);assert.equal(sender.snapshot().state,'reserved');sender.dispose();writer.dispose();
});
test('unknown preparation cannot repeat send, but confirmed CAS cancellation revokes its queued intent',async()=>{
 const paused={...row,state:'paused' as const,reason:'preparation_unknown' as const};assert.equal(parseNativeOutboxRow(paused,'account').reason,'preparation_unknown');assert.equal(parseNativeOutboxRow({...paused,reason:'preparation_conflict'},'account').reason,'preparation_conflict');let posts=0;
 const f=fixture(async(_path,init)=>{if(init.method==='POST'){posts++;return response({...paused,state:'cancelled',revision:2});}return response({operation:paused});});await f.client.inspect(4,true);await f.client.send();await f.client.check();assert.equal(posts,0);assert.equal(f.counts().accepted,0);assert.match(f.client.snapshot().notice,/Preparing this message could not be confirmed/);await f.client.cancel();assert.equal(posts,1);assert.equal(f.counts().cancelled,1);f.client.dispose();
});
test('queued Undo stays reserved and enabled while read-only status polling is held',async()=>{
 let release!:(value:Response)=>void;const f=fixture(async(_path,init)=>init.method==='POST'?response(row,202):new Promise(done=>{release=done;}));await f.client.send();const poll=f.client.check();
 try{assert.equal(f.client.snapshot().state,'reserved');assert.equal(f.client.snapshot().busy,false);assert.match(f.client.snapshot().notice,/undo before dispatch/);}finally{release(response({operation:row}));await poll;f.client.dispose();}
});
test('Undo supersedes a held GET, sends exact cancellation CAS and fences a late accepted status response',async()=>{
 let release!:(value:Response)=>void,posts=0;const cancelled={...row,state:'cancelled' as const,revision:2};
 const f=fixture(async(path,init)=>{if(init.method==='POST'){posts++;if(path.endsWith('/cancel')){assert.deepEqual(JSON.parse(init.body as string),{expected_revision:1});return response(cancelled);}return response(row,202);}return new Promise(done=>{release=done;});});
 await f.client.send();const poll=f.client.check();try{await f.client.cancel();assert.equal(posts,2);assert.equal(f.counts().cancelled,1);assert.match(f.client.snapshot().notice,/cancelled/);}finally{release(response({operation:{...row,state:'accepted',revision:2}}));await poll;}
 assert.equal(f.counts().accepted,0);assert.match(f.client.snapshot().notice,/cancelled/);f.client.dispose();
});
test('read-only polling failure keeps last authoritative Undo available; denial or confirmed dispatch removes it',async()=>{
 for(const result of [response({},503),response({operation:null})]){const f=fixture(async(path,init)=>init.method==='POST'?(path.endsWith('/cancel')?response({...row,state:'cancelled',revision:2}):response(row,202)):result);await f.client.send();await f.client.check();assert.equal(f.client.snapshot().state,'reserved');assert.equal(f.client.snapshot().busy,false);assert.match(f.client.snapshot().notice,/Last known/);await f.client.cancel();assert.equal(f.counts().cancelled,1);f.client.dispose();}
 const dispatched=fixture(async(_p,init)=>init.method==='POST'?response(row,202):response({operation:{...row,state:'submitting',revision:2}}));await dispatched.client.send();await dispatched.client.check();await dispatched.client.cancel();assert.match(dispatched.client.snapshot().notice,/no longer be cancelled/);assert.equal(dispatched.counts().cancelled,0);dispatched.client.dispose();
 const denied=fixture(async(_p,init)=>init.method==='POST'?response(row,202):response({},403));await denied.client.send();await denied.client.check();assert.equal(denied.client.snapshot().state,'denied');assert.equal(denied.counts().denied,1);denied.client.dispose();
});
