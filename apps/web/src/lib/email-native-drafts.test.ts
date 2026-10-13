import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDraftApi,createNativeDraftWriter,emptyNativeDraft,NativeDraftError,parseNativeDraftContent,type NativeDraft,type NativeDraftContent,type NativeDraftSaveState} from './email-native-drafts';

const draftId='00000000-0000-4000-8000-000000000001';
const row=(content:NativeDraftContent=emptyNativeDraft(),revision=1):NativeDraft=>({draft_id:draftId,revision,status:'draft',content,origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-04T00:00:00.000Z',updated_at:'2026-10-04T00:00:00.000Z'});
test('native recipient draft scalars enforce16384 UTF8 bytes while oversized local input remains correctable without a request',async()=>{
 const exact='é'.repeat(8192),over=exact+'a';assert.equal(parseNativeDraftContent({...emptyNativeDraft(),to:exact}).to,exact);assert.throws(()=>parseNativeDraftContent({...emptyNativeDraft(),to:over}));
 let calls=0;const client=createNativeDraftApi(async()=>{calls++;return Response.json(row());},()=>true);
 const writer=createNativeDraftWriter({accountId:'account',draftId,current:()=>true,change:()=>{},api:client});
 try{writer.edit({...emptyNativeDraft(),to:over,body:'Keep my body'});assert.equal(await writer.save(),false);assert.equal(calls,0);assert.equal(writer.snapshot().content.to,over);assert.equal(writer.snapshot().content.body,'Keep my body');assert.equal(writer.snapshot().dirty,true);assert.equal(writer.snapshot().state,'error');}finally{writer.dispose();client.dispose();}
});
test('actual host draft content revision is preserved for submitted status lookup, with bounded lifecycle invariants',async()=>{
 const client=createNativeDraftApi(async()=>Response.json({...row(emptyNativeDraft(),9),status:'submitted',content_revision:4}),()=>true);const saved=await client.read('account',draftId);assert.equal(saved.content_revision,4);assert.equal(saved.revision,9);client.dispose();
 for(const value of [{...row(),content_revision:2},{...row(),content_revision:0},{...row(),status:'submitted',content_revision:1}]){const invalid=createNativeDraftApi(async()=>Response.json(value),()=>true);await assert.rejects(invalid.read('account',draftId));invalid.dispose();}
});
test('draft API pins account and UUID, sends only content/CAS, and requires archive acknowledgement',async()=>{
 const calls:Array<{path:string;options:RequestInit}>=[];const client=createNativeDraftApi(async(path,options)=>{calls.push({path,options});return Response.json({...row(),status:path.endsWith('/archive')?'archived':'draft'});},()=>true);
 const content={...emptyNativeDraft(),to:'unfinished recipient',body:'Retained draft'};
 await client.save('account/one',draftId,0,content);assert.equal(calls[0].path,`/api/email/accounts/account%2Fone/drafts/${draftId}`);assert.equal(calls[0].options.method,'PUT');
 assert.deepEqual(JSON.parse(calls[0].options.body as string),{expected_revision:0,content});await client.archive('account/one',draftId,1);
 assert.deepEqual(JSON.parse(calls[1].options.body as string),{expected_revision:1});assert.equal(calls[1].options.method,'POST');client.dispose();
});
test('closed draft schema preserves incomplete recipients while rejecting provenance injection and control headers',()=>{
 assert.equal(parseNativeDraftContent({...emptyNativeDraft(),to:'incomplete@'}).to,'incomplete@');
 assert.throws(()=>parseNativeDraftContent({...emptyNativeDraft(),origin:{kind:'agent'}}));
 assert.throws(()=>parseNativeDraftContent({...emptyNativeDraft(),subject:'Subject\r\nBcc: injected'}));
 assert.throws(()=>parseNativeDraftContent({...emptyNativeDraft(),attachments:[{file_id:'x',filename:'../secret',media_type:'text/plain',size_bytes:1,sha256:'a'.repeat(64)}]}));
});
test('autosave serializes edits made during a held save without writing an old revision twice',async()=>{
 const calls:Array<{revision:number;content:NativeDraftContent}>=[],states:NativeDraftSaveState[]=[];let release:()=>void=()=>{};
 const writer=createNativeDraftWriter({accountId:'a',draftId,current:()=>true,change:state=>states.push(state),api:{read:async()=>row(),save:async(_a,_id,revision,content)=>{calls.push({revision,content});if(calls.length===1)await new Promise<void>(resolve=>{release=resolve;});return row(content,revision+1);}}});
 writer.edit({...emptyNativeDraft(),body:'First'});const save=writer.save();writer.edit({...emptyNativeDraft(),body:'Edited while saving'});assert.equal(writer.save(),save);release();assert.equal(await save,true);
 assert.deepEqual(calls.map(call=>[call.revision,call.content.body]),[[0,'First'],[1,'Edited while saving']]);assert.equal(states.at(-1)?.notice,'Saved');assert.equal(states.at(-1)?.dirty,false);writer.dispose();
});
test('CAS conflict keeps local content and stops subsequent autosaves',async()=>{
 let writes=0;const writer=createNativeDraftWriter({accountId:'a',draftId,initial:row(),current:()=>true,change:()=>{},api:{read:async()=>row(),save:async()=>{writes++;throw new NativeDraftError('conflict');}}});
 writer.edit({...emptyNativeDraft(),body:'My local edit'});assert.equal(await writer.save(),false);assert.equal(writer.snapshot().state,'conflict');assert.equal(writer.snapshot().content.body,'My local edit');
 writer.edit({...emptyNativeDraft(),body:'Continued local edit'});assert.equal(await writer.save(),false);assert.equal(writes,1);writer.dispose();
});
test('lost successful save is read and reconciled before retry, without duplicate revision advancement',async()=>{
 let saved:NativeDraft|null=null,writes=0,reads=0;const writer=createNativeDraftWriter({accountId:'a',draftId,current:()=>true,change:()=>{},api:{read:async()=>{reads++;return saved!;},save:async(_a,_id,revision,content)=>{writes++;saved=row(content,revision+1);throw Error('response lost');}}});
 writer.edit({...emptyNativeDraft(),subject:'Durable content'});assert.equal(await writer.save(),false);assert.equal(writer.snapshot().notice,'Saving could not be confirmed. Your edits are kept here.');
 assert.equal(await writer.save(),true);assert.equal(writes,1);assert.equal(reads,1);assert.equal(writer.snapshot().revision,1);assert.equal(writer.snapshot().dirty,false);writer.dispose();
});
test('uncertain save followed by another editor is a conflict, never a blind overwrite',async()=>{
 let writes=0;const writer=createNativeDraftWriter({accountId:'a',draftId,initial:row(),current:()=>true,change:()=>{},api:{read:async()=>row({...emptyNativeDraft(),body:'Other editor'},2),save:async()=>{writes++;throw Error('response lost');}}});
 writer.edit({...emptyNativeDraft(),body:'My edit'});await writer.save();assert.equal(await writer.save(),false);assert.equal(writer.snapshot().state,'conflict');assert.equal(writes,1);assert.equal(writer.snapshot().content.body,'My edit');writer.dispose();
});
test('held result is discarded after session/scope disposal and denied writes clear composer content',async()=>{
 let release:(value:NativeDraft)=>void=()=>{},current=true;const states:NativeDraftSaveState[]=[];
 const writer=createNativeDraftWriter({accountId:'a',draftId,current:()=>current,change:state=>states.push(state),api:{read:async()=>row(),save:async()=>new Promise(resolve=>{release=resolve;})}});
 writer.edit({...emptyNativeDraft(),body:'Private draft'});const save=writer.save(),count=states.length;current=false;writer.dispose();release(row({...emptyNativeDraft(),body:'Private draft'}));assert.equal(await save,false);assert.equal(states.length,count);assert.equal(writer.snapshot().content.body,'');
 const denied=createNativeDraftWriter({accountId:'a',draftId,current:()=>true,change:()=>{},api:{read:async()=>row(),save:async()=>{throw new NativeDraftError('denied');}}});denied.edit({...emptyNativeDraft(),body:'Private'});await denied.save();assert.equal(denied.snapshot().state,'denied');assert.equal(denied.snapshot().content.body,'');denied.dispose();
});
test('draft API rejects foreign draft identity, private metadata and late session results',async()=>{
 const wrong=createNativeDraftApi(async()=>Response.json({...row(),draft_id:'00000000-0000-4000-8000-000000000002'}),()=>true);await assert.rejects(wrong.read('a',draftId));wrong.dispose();
 const privateRow=createNativeDraftApi(async()=>Response.json({...row(),provider_locator:'private'}),()=>true);await assert.rejects(privateRow.read('a',draftId));privateRow.dispose();
 let current=true,release:(response:Response)=>void=()=>{};const client=createNativeDraftApi(async()=>new Promise(resolve=>{release=resolve;}),()=>current);const held=client.read('a',draftId);current=false;release(Response.json(row()));await assert.rejects(held,(error:unknown)=>error instanceof NativeDraftError&&error.kind==='denied');client.dispose();
});
test('oversized draft response is bounded and incomplete archive acknowledgement cannot remove a draft',async()=>{
 const oversized=createNativeDraftApi(async()=>new Response(' '.repeat(512*1024+1)),()=>true);await assert.rejects(oversized.read('a',draftId));oversized.dispose();
 const incomplete=createNativeDraftApi(async()=>Response.json(row()),()=>true);await assert.rejects(incomplete.archive('a',draftId,1));incomplete.dispose();
});
test('equivalent reordered JSON content acknowledges a save, and invalid edits remain recoverable',async()=>{
 const writer=createNativeDraftWriter({accountId:'a',draftId,current:()=>true,change:()=>{},api:{read:async()=>row(),save:async(_a,_id,revision,content)=>row(Object.fromEntries(Object.entries(content).reverse()) as NativeDraftContent,revision+1)}});
 writer.edit({...emptyNativeDraft(),subject:'Safe'});assert.equal(await writer.save(),true);assert.equal(writer.snapshot().dirty,false);
 writer.edit({...emptyNativeDraft(),subject:'Unsupported\nheader'});assert.equal(await writer.save(),false);assert.equal(writer.snapshot().content.subject,'Unsupported\nheader');assert.equal(writer.snapshot().dirty,true);
 writer.edit({...emptyNativeDraft(),subject:'Corrected'});assert.equal(await writer.save(),true);assert.equal(writer.snapshot().revision,2);writer.dispose();
});

test('save-and-close of an untouched blank compose makes no draft request, while a cleared existing draft saves',async()=>{
 let writes=0;
 const make=(initial?:NativeDraft)=>createNativeDraftWriter({accountId:'a',draftId,initial,current:()=>true,change:()=>{},api:{read:async()=>row(),save:async(_a,_id,revision,content)=>{writes++;return row(content,revision+1);}}});
 const blank=make();assert.equal(await blank.save(true),true);assert.equal(writes,0);assert.equal(blank.snapshot().revision,0);blank.dispose();
 const existing=make(row({...emptyNativeDraft(),body:'Delete this text'}));existing.edit(emptyNativeDraft());assert.equal(await existing.save(true),true);assert.equal(writes,1);assert.equal(existing.snapshot().revision,2);existing.dispose();
});

test('explicit blank Save still saves, and close waits for a held edited save instead of dropping it',async()=>{
 let writes=0,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const writer=createNativeDraftWriter({accountId:'a',draftId,current:()=>true,change:()=>{},api:{read:async()=>row(),save:async(_a,_id,revision,content)=>{writes++;if(writes===2)await held;return row(content,revision+1);}}});
 assert.equal(await writer.save(),true);assert.equal(writes,1);writer.edit({...emptyNativeDraft(),body:'Keep during save'});
 const save=writer.save(),close=writer.save(true);assert.equal(close,save);release();assert.equal(await close,true);assert.equal(writer.snapshot().content.body,'Keep during save');assert.equal(writer.snapshot().dirty,false);writer.dispose();
});
