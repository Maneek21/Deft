import assert from 'node:assert/strict';import test from 'node:test';
import {createNativeMessageLinkResolver,createNativeMessageSummary,nativeMessageUrl,parseNativeMessageLink,NativeSummaryError,readNativeTimerSummaries,readNativeAffectedSummaries} from './email-native-message-links';
import type {NativeEmailMessage} from './email-native-search';
const id='mail_'+'a'.repeat(64),other='mail_'+'b'.repeat(64),target={account_id:'account/one',logical_message_id:id};
const row=(logical_message_id=id):NativeEmailMessage=>({...target,logical_message_id,revision:'r1',received_at:null,folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Subject',from:'Ada@example.test'}});
test('message URL round-trips exact opaque account/logical identity and rejects duplicate or malformed nominations',()=>{
 assert.deepEqual(parseNativeMessageLink(nativeMessageUrl(target).split('?')[1]!),target);assert.equal(parseNativeMessageLink(''),null);
 for(const query of ['account=one','message='+id,'account=one&account=two&message='+id,'account=one&message=provider-id'])assert.throws(()=>parseNativeMessageLink(query));
});
test('back/forward changes exact target and clears old content; late held results cannot replace current message',async()=>{
 const pending:{target:typeof target;signal:AbortSignal;done:(r:NativeEmailMessage)=>void}[]=[],changes:(NativeEmailMessage|null)[]=[];
 const resolver=createNativeMessageLinkResolver({current:()=>true,change:value=>changes.push(value),read:async(t,signal)=>new Promise(done=>pending.push({target:t,signal,done}))});
 const first=resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id],true),second=resolver.load(nativeMessageUrl({...target,logical_message_id:other}).split('?')[1]!,[target.account_id],true);assert.equal(pending[0]!.signal.aborted,true);assert.deepEqual([...changes],[null,null]);pending[1]!.done(row(other));await second;pending[0]!.done(row());await first;assert.equal(changes.at(-1)?.logical_message_id,other);
 const back=resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id],true);assert.equal(changes.at(-1),null);pending[2]!.done(row());await back;assert.equal(changes.at(-1)?.logical_message_id,id);await resolver.load('',[target.account_id],true);assert.equal(changes.at(-1),null);resolver.dispose();
});
test('already selected exact current account/message stays mounted during fresh guarded summary lookup',async()=>{
 let selected:NativeEmailMessage|null=row(),resolve!:(value:NativeEmailMessage)=>void,reads=0;const changes:(NativeEmailMessage|null)[]=[];
 const options={current:()=>true,selected:()=>selected,change:(value:NativeEmailMessage|null)=>{selected=value;changes.push(value);},read:async()=>{reads++;return new Promise<NativeEmailMessage>(done=>{resolve=done;});}};
 const resolver=createNativeMessageLinkResolver(options),lookup=resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id],true);
 assert.equal(reads,1,'retention never skips current server authority lookup');assert.equal(selected?.logical_message_id,id);assert.equal(changes.length,0,'same target must not publish null and unmount the reader');
 resolve({...row(),revision:'r2'});await lookup;assert.equal(selected?.revision,'r2');assert.equal(changes.includes(null),false);resolver.dispose();
});
test('same logical ID from another account, missing current account or discovery wait never retain selected content',async()=>{
 const notices:(NativeEmailMessage|null)[]=[];let selected:NativeEmailMessage|null={...row(),account_id:'other-account'},reads=0;
 const resolver=createNativeMessageLinkResolver({current:()=>true,selected:()=>selected,change:value=>{selected=value;notices.push(value);},read:async()=>{reads++;return row();}});
 await resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id,'other-account'],true);assert.equal(notices[0],null);assert.equal(reads,1);
 selected=row();notices.length=0;await resolver.load(nativeMessageUrl(target).split('?')[1]!,['other-account'],true);assert.equal(notices[0],null);assert.equal(reads,1);
 selected=row();notices.length=0;await resolver.load(nativeMessageUrl(target).split('?')[1]!,[],false);assert.equal(notices[0],null);assert.equal(reads,1);resolver.dispose();
});
test('retained exact message clears on failed fresh authority/metadata and cannot survive late superseded lookup',async()=>{
 for(const failure of [new NativeSummaryError(403),new NativeSummaryError(404),Error('Message details could not be confirmed.')]){
  let selected:NativeEmailMessage|null=row(),denied=0;const changes:(NativeEmailMessage|null)[]=[];const resolver=createNativeMessageLinkResolver({current:()=>true,selected:()=>selected,change:value=>{selected=value;changes.push(value);},denied:()=>{denied++;},read:async()=>{throw failure;}});await resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id],true);assert.deepEqual(changes,[null]);assert.equal(denied,failure instanceof NativeSummaryError&&failure.status===403?1:0);resolver.dispose();
 }
 let selected:NativeEmailMessage|null=row(),live=true;const held:{done:(value:NativeEmailMessage)=>void;signal:AbortSignal}[]=[];const changes:(NativeEmailMessage|null)[]=[];
 const resolver=createNativeMessageLinkResolver({current:()=>live,selected:()=>selected,change:value=>{selected=value;changes.push(value);},read:async(_target,signal)=>new Promise(done=>held.push({done,signal}))});
 const first=resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id],true),second=resolver.load(nativeMessageUrl({...target,logical_message_id:other}).split('?')[1]!,[target.account_id],true);assert.equal(held[0].signal.aborted,true);assert.deepEqual(changes,[null]);held[1].done(row(other));await second;held[0].done(row());await first;assert.equal(selected?.logical_message_id,other);
 const pending=resolver.load(nativeMessageUrl({...target,logical_message_id:other}).split('?')[1]!,[target.account_id],true);const before=changes.length;live=false;resolver.dispose();held[2].done(row(other));await pending;assert.equal(changes.length,before);
});
test('unknown account or revoked exact message shows unavailable and never falls back to another account',async()=>{
 let reads=0,notice='',denied='';const resolver=createNativeMessageLinkResolver({current:()=>true,change:(_row,text)=>{notice=text;},denied:id=>{denied=id;},read:async()=>{reads++;throw new NativeSummaryError(403);}});
 const query=nativeMessageUrl(target).split('?')[1]!;await resolver.load(query,['other-account'],true);assert.equal(reads,0);assert.match(notice,/unavailable/);await resolver.load(query,[target.account_id],true);assert.equal(denied,target.account_id);assert.equal(reads,1);resolver.dispose();
});
test('account discovery waits, mismatched summary is rejected, and session disposal suppresses late lookup',async()=>{
 let reads=0,live=true;const values:(NativeEmailMessage|null)[]=[];const resolver=createNativeMessageLinkResolver({current:()=>live,change:value=>values.push(value),read:async()=>{reads++;return {...row(),account_id:'foreign'};}});
 await resolver.load(nativeMessageUrl(target).split('?')[1]!,[],false);assert.equal(reads,0);await resolver.load(nativeMessageUrl(target).split('?')[1]!,[target.account_id],true);assert.equal(values.some(Boolean),false);live=false;resolver.dispose();
});
test('summary client calls cached exact endpoint and rejects private fields or mismatched identities',async()=>{
 let result:unknown=row();const client=createNativeMessageSummary({current:()=>true,fetch:async(path,init)=>{assert.equal(path,`/api/email/accounts/account%2Fone/messages/${id}/summary`);assert.equal(init.cache,'no-store');return Response.json(result);}});assert.equal((await client.read(target)).data.subject,'Subject');result={...row(),provider_source:{private_locator:'no'}};await assert.rejects(client.read(target));result={...row(),logical_message_id:other};await assert.rejects(client.read(target));client.dispose();
});
test('timer metadata reads bound concurrency to two, dedupe logical IDs, and leave missing messages unavailable',async()=>{
 let held=0,max=0;const result=await readNativeTimerSummaries(target.account_id,[id,other,id],async t=>{held++;max=Math.max(max,held);await Promise.resolve();held--;if(t.logical_message_id===other)throw new NativeSummaryError(404);return row();},()=>true);assert.equal(max,2);assert.equal(Object.keys(result).length,2);assert.equal(result[other],null);assert.equal(result[id]?.data.subject,'Subject');
 await assert.rejects(readNativeTimerSummaries(target.account_id,Array(501).fill(id),async()=>row(),()=>true),/too large/);
});
test('affected summaries bound two readers, dedupe exact targets and preserve other successful rows on optional failure',async()=>{
 let active=0,max=0,calls=0;const signal=new AbortController().signal;
 const result=await readNativeAffectedSummaries([target,{...target,logical_message_id:other},target],{signal,current:()=>true,denied:()=>{},read:async t=>{
   calls++;active++;max=Math.max(max,active);await Promise.resolve();active--;if(t.logical_message_id===other)throw new NativeSummaryError(404);return row();}});
 assert.equal(calls,2);assert.equal(max,2);assert.deepEqual(result.items,[row()]);assert.equal(result.incomplete,true);
 await assert.rejects(readNativeAffectedSummaries(Array(101).fill(target),{signal,current:()=>true,denied:()=>{},read:async()=>row()}),/Too many/);
 await assert.rejects(readNativeAffectedSummaries([{...target,logical_message_id:'provider-id'}],{signal,current:()=>true,denied:()=>{},read:async()=>row()}),/unavailable/);
});
test('affected denial cancels that account and removes prior/late rows while another account completes',async()=>{
 const targets=[target,{...target,logical_message_id:other},{account_id:'b',logical_message_id:id}],denied:string[]=[];let accountSignal:AbortSignal|undefined;
 const result=await readNativeAffectedSummaries(targets,{signal:new AbortController().signal,current:()=>true,denied:account=>denied.push(account),read:async(t,signal)=>{
   if(t.account_id==='b')return {...row(),account_id:'b'};
   if(t.logical_message_id===other)throw new NativeSummaryError(403);
   accountSignal=signal;await Promise.resolve();return row();}});
 assert.equal(accountSignal!.aborted,true);assert.deepEqual(denied,[target.account_id]);assert.deepEqual(result.deniedAccounts,[target.account_id]);assert.deepEqual(result.items,[{...row(),account_id:'b'}]);
});
test('affected scope abort and foreign late summary never publish an authoritative update',async()=>{
 const controller=new AbortController();let release!:(r:NativeEmailMessage)=>void;
 const pending=readNativeAffectedSummaries([target],{signal:controller.signal,current:()=>true,denied:()=>assert.fail('aborted work cannot deny'),read:async()=>new Promise(resolve=>{release=resolve;})});
 controller.abort();release(row());const result=await pending;assert.deepEqual(result.items,[]);assert.equal(result.incomplete,true);
 const foreign=await readNativeAffectedSummaries([target],{signal:new AbortController().signal,current:()=>true,denied:()=>{},read:async()=>({...row(),account_id:'foreign'})});
 assert.deepEqual(foreign.items,[]);assert.equal(foreign.incomplete,true);
});
