import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEmailSend,parseNativeSendResult,type NativeSendState} from './email-native-send';
import {createNativeDraftWriter,emptyNativeDraft,type NativeDraft,type NativeDraftSaveState} from './email-native-drafts';
const draftId='00000000-0000-4000-8000-000000000001',operationId='00000000-0000-4000-8000-000000000002';
const result=(state:'reserved'|'unknown'|'accepted'='accepted',draftRevision=7)=>({operation_id:operationId,draft_id:draftId,draft_revision:draftRevision,state});
const saved=(rev=7):NativeDraftSaveState=>({revision:rev,content:{...emptyNativeDraft(),to:'one@example.test'},dirty:false,state:'saved',notice:'Saved'});
const create=(overrides:Partial<Parameters<typeof createNativeEmailSend>[0]>={})=>createNativeEmailSend({accountId:'account/one',draftId,current:()=>true,fetch:async()=>Response.json(result()),writer:()=>({save:async()=>true,snapshot:()=>saved()}),change:()=>{},denied:()=>{},accepted:()=>{},...overrides});

test('Send freezes immediately, waits for the exact saved revision, and sends no client content or attachment bytes',async()=>{
 let release!:(v:boolean)=>void,requests=0,accepted=0;const states:NativeSendState[]=[],calls:{path:string;init:RequestInit}[]=[];
 const sender=create({writer:()=>({save:()=>new Promise(resolve=>{release=resolve;}),snapshot:()=>saved(9)}),change:state=>states.push(state),accepted:()=>accepted++,fetch:async(path,init)=>{requests++;calls.push({path,init});return Response.json(result('accepted',9));}});
 const pending=sender.send();assert.equal(sender.snapshot().state,'flushing');assert.equal(sender.snapshot().locked,true);assert.equal(requests,0);await sender.send();release(true);await pending;
 assert.equal(requests,1);assert.equal(calls[0].path,`/api/email/accounts/account%2Fone/drafts/${draftId}/send`);assert.deepEqual(JSON.parse(String(calls[0].init.body)),{expected_revision:9});assert.equal(calls[0].init.method,'POST');assert.equal(sender.snapshot().state,'accepted');assert.match(sender.snapshot().notice,/Delivery is not yet confirmed/);assert.equal(accepted,1);await sender.send();assert.equal(requests,1);sender.dispose();
});
test('a lost response permits only GET of the same draft revision; pending and unknown never resend',async()=>{
 const calls:{path:string;method:string}[]=[];let accepted=0,state:'reserved'|'unknown'|'accepted'='reserved';
 const sender=create({accepted:()=>accepted++,fetch:async(path,init)=>{calls.push({path,method:String(init.method)});if(init.method==='POST')throw Error('lost acknowledgement');return Response.json({operation:result(state)});}});
 await sender.send();assert.equal(sender.snapshot().state,'unknown');await sender.send();assert.equal(calls.length,1);await sender.check();assert.equal(sender.snapshot().state,'reserved');state='unknown';await sender.check();assert.equal(sender.snapshot().state,'unknown');state='accepted';await sender.check();await sender.check();assert.equal(accepted,1);assert.equal(calls.filter(row=>row.method==='POST').length,1);assert.ok(calls.slice(1).every(row=>row.path.endsWith('/send/7')));sender.dispose();
});
test('null status after an uncertain POST remains locked; a fresh ordinary saved draft with null status is editable',async()=>{
 let requests=0;const sender=create({fetch:async(_path,init)=>{requests++;return init.method==='POST'?Response.json({code:'EMAIL_SEND_UNKNOWN'},{status:409}):Response.json({operation:null});}});
 await sender.send();await sender.check();await sender.send();assert.equal(requests,2);assert.equal(sender.snapshot().locked,true);sender.dispose();
 const ordinary=create({fetch:async()=>Response.json({operation:null})});await ordinary.inspect(7);assert.equal(ordinary.snapshot().state,'idle');assert.equal(ordinary.snapshot().locked,false);ordinary.dispose();
 const submitted=create({fetch:async()=>Response.json({operation:null})});await submitted.inspect(7,true);assert.equal(submitted.snapshot().state,'unknown');assert.equal(submitted.snapshot().locked,true);submitted.dispose();
 let failed=true;const statusOnly=create({fetch:async()=>{if(failed)throw Error('status temporarily unavailable');return Response.json({operation:null});}});await statusOnly.inspect(7);assert.equal(statusOnly.snapshot().locked,true);failed=false;await statusOnly.check();assert.equal(statusOnly.snapshot().state,'idle');assert.equal(statusOnly.snapshot().locked,false);statusOnly.dispose();
});
test('provider limit and verified preparation errors retain editable draft; server errors cannot unlock or automatically retry',async()=>{
 let posts=0;const sender=create({fetch:async()=>{posts++;return Response.json({code:'EMAIL_SEND_LIMIT_EXCEEDED'},{status:422});}});await sender.send();assert.equal(posts,1);assert.equal(sender.snapshot().state,'blocked');assert.equal(sender.snapshot().locked,false);assert.match(sender.snapshot().notice,/Nothing was sent/);sender.dispose();
 const unsafe=create({fetch:async()=>Response.json({code:'EMAIL_SEND_LIMIT_EXCEEDED'},{status:503})});await unsafe.send();assert.equal(unsafe.snapshot().state,'unknown');assert.equal(unsafe.snapshot().locked,true);unsafe.dispose();
});
test('submitted draft recovery is read-only and pins original revision; scope changes discard held results',async()=>{
 let release!:(v:Response)=>void,current=true,accepted=0;const states:NativeSendState[]=[],calls:string[]=[];
 const sender=create({current:()=>current,accepted:()=>accepted++,change:state=>states.push(state),fetch:(path,init)=>{assert.equal(init.method,'GET');calls.push(path);return new Promise(resolve=>{release=resolve;});}});
 const held=sender.inspect(7,true);const count=states.length;current=false;sender.dispose();release(Response.json({operation:result()}));await held;assert.equal(accepted,0);assert.equal(states.length,count);assert.ok(calls[0].endsWith('/send/7'));
});
test('permission changes halt Send and clear writer via denial callback',async()=>{
 let denied=0,posts=0;const sender=create({denied:()=>denied++,fetch:async()=>{posts++;return Response.json({code:'EMAIL_SEND_ACCESS_DENIED'},{status:403});}});
 await sender.send();await sender.send();assert.equal(posts,1);assert.equal(denied,1);assert.equal(sender.snapshot().state,'denied');assert.equal(sender.snapshot().locked,true);sender.dispose();
});
test('closed result pins exact draft, revision and operation; invalid/private responses cannot report success',async()=>{
 for(const raw of [{...result(),provider_message_id:'private'}, {...result(),draft_id:operationId}, {...result(),draft_revision:6}, {...result(),state:'delivered'}])assert.throws(()=>parseNativeSendResult(raw,draftId,7));
 let accepted=0;const malformed=create({accepted:()=>accepted++,fetch:async()=>Response.json({...result(),provider_locator:'secret'})});await malformed.send();assert.equal(accepted,0);assert.equal(malformed.snapshot().state,'unknown');malformed.dispose();
 const huge=create({fetch:async()=>new Response('x'.repeat(8193))});await huge.send();assert.equal(huge.snapshot().state,'unknown');huge.dispose();
});
test('saved scalar text and attachments join before Send, through the actual serialized draft writer',async()=>{
 const file={file_id:operationId,filename:'note.txt',media_type:'text/plain',size_bytes:4,sha256:'a'.repeat(64)};
 const row=(content=emptyNativeDraft(),revision=1):NativeDraft=>({draft_id:draftId,revision,status:'draft',content,origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-04T00:00:00Z',updated_at:'2026-10-04T00:00:00Z'});
 let stored=row({...emptyNativeDraft(),to:'one@example.test',attachments:[file]}),posts=0;
 const writer=createNativeDraftWriter({accountId:'account/one',draftId,initial:stored,current:()=>true,change:()=>{},api:{read:async()=>stored,save:async(_account,_draft,revision,content)=>{stored=row(content,revision+1);return stored;}}});
 writer.edit({...writer.snapshot().content,body:'Final text'});
 const sender=create({writer:()=>writer,fetch:async(_path,init)=>{posts++;assert.equal(stored.content.body,'Final text');assert.deepEqual(stored.content.attachments,[file]);assert.equal(JSON.parse(String(init.body)).expected_revision,stored.revision);return Response.json(result('accepted',stored.revision));}});
 await sender.send();assert.equal(posts,1);assert.equal(sender.snapshot().state,'accepted');writer.dispose();sender.dispose();
});
test('failed flush or unresolved attachment prevents any provider attempt, and accepted wake failure cannot invite resend',async()=>{
 let posts=0;const flush=create({writer:()=>({save:async()=>false,snapshot:()=>saved()}),fetch:async()=>{posts++;return Response.json(result());}});await flush.send();assert.equal(posts,0);assert.equal(flush.snapshot().state,'blocked');flush.dispose();
 const pending=create({writer:()=>({save:async()=>true,snapshot:()=>({...saved(),fileMutation:{kind:'upload',fileId:operationId,filename:'file',uncertain:true}})}),fetch:async()=>{posts++;return Response.json(result());}});await pending.send();assert.equal(posts,0);pending.dispose();
 const accepted=create({accepted:()=>{throw Error('cache unavailable');},fetch:async()=>{posts++;return Response.json(result());}});await accepted.send();await accepted.send();assert.equal(posts,1);assert.equal(accepted.snapshot().state,'accepted');accepted.dispose();
});
