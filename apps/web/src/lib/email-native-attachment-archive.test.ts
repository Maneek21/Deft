import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createNativeEmailReader,type NativeReaderState} from './email-native-reader';
import type {SourceFile} from './app-experience-source-view';

const account='personal/account',message='mail_'+'a'.repeat(64),digest='b'.repeat(64);
const files:SourceFile[]=Array.from({length:5},(_,n)=>({file_ref:String(n+1).repeat(64),filename:n<2?'résumé.pdf':`file${n}.bin`,media_type:'application/octet-stream',size_bytes:n===0?0:3,disposition:'attachment',preview:'unsupported'}));
const bytes=(file:SourceFile)=>file.size_bytes?new Uint8Array([0,255,files.findIndex(f=>f.file_ref===file.file_ref)]):new Uint8Array();
const binary=(file:SourceFile)=>new Response(new Uint8Array(bytes(file)),{headers:{'content-type':file.media_type,'content-length':String(file.size_bytes),'x-content-type-options':'nosniff','content-disposition':'attachment; filename="original"'}});
const raw=(listed=files,omitted=0)=>({schema_version:'deft.email_presentation.v1',account_id:account,provider:'gmail',logical_message_id:message,source_digest:digest,content_trust:'unsanitized',files:listed,omitted_file_count:omitted,
 presentation:{format:'plain',content:'Body',plain_text:'Body',truncated:false,images:[],headers:[{label:'Subject',value:'Quarterly / report'}],metadata:{account_id:account}}});
class Element{replaceChildren(){}replaceWith(){}}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(fetchFile:(file:SourceFile,init:RequestInit)=>Promise<Response>=async file=>binary(file),presentation=raw()){
 const states:NativeReaderState[]=[],calls:Array<{file:SourceFile;init:RequestInit;path:string}>=[],downloads:Array<{name:string;blob:Blob}>=[],blobs:Blob[]=[],revoked:string[]=[];
 let current=true;const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
 URL.createObjectURL=blob=>{assert.ok(blob instanceof Blob);blobs.push(blob);return `blob:archive-${blobs.length}`;};URL.revokeObjectURL=url=>{revoked.push(url);};
 const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:new Element() as unknown as HTMLElement,current:()=>current,change:state=>states.push(state),
  render:()=>new Element() as unknown as HTMLElement,download:(_url,name)=>downloads.push({name,blob:blobs.at(-1)!}),
  fetch:async(path,init)=>{if(path.endsWith('/presentation'))return Response.json(presentation);if(path.endsWith('/reading-preferences'))return Response.json({account_id:account,external_images:'ask',revision:1});
   assert.ok(path.endsWith('/file'));const body=JSON.parse(init.body as string);assert.deepEqual(Object.keys(body).sort(),['file_ref','source_digest']);assert.equal(body.source_digest,digest);
   const file=presentation.files.find(f=>f.file_ref===body.file_ref)!;assert.ok(file);assert.equal(init.cache,'no-store');assert.ok(init.signal);calls.push({file,init,path});return fetchFile(file,init);}});
 return {reader,states,calls,downloads,blobs,revoked,end:()=>{current=false;},restore:()=>{reader.dispose();URL.createObjectURL=create;URL.revokeObjectURL=revoke;}};
}
async function extract(blob:Blob){return JSON.parse(execFileSync(process.env.DEFT_ZIP_TEST_PYTHON??'python',['-c',
 'import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([{ "name":i.filename,"bytes":list(z.read(i))} for i in z.infolist()]))'],
 {input:Buffer.from(await blob.arrayBuffer())}).toString()) as Array<{name:string;bytes:number[]}>;}

test('actual reader archives only received attachments with exact bytes/order, safe subject filename and pinned internal identity',async()=>{
 const inline={...files[4],file_ref:'f'.repeat(64),disposition:'inline' as const};const f=fixture(undefined,raw([...files.slice(0,3),inline]));
 try{await f.reader.load();await f.reader.downloadAttachments();assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].name,'Quarterly _ report.zip');
  const entries=await extract(f.downloads[0].blob);assert.deepEqual(entries.map(e=>e.name),['résumé.pdf','résumé (2).pdf','file2.bin']);assert.deepEqual(entries.map(e=>e.bytes),files.slice(0,3).map(file=>[...bytes(file)]));
  assert.equal(entries.length,3);assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.path===`/api/email/accounts/${encodeURIComponent(account)}/messages/${message}/file`));
  assert.deepEqual(f.revoked,['blob:archive-1']);assert.match(f.states.at(-1)!.archive!.notice,/ZIP download started for 3 attachments/);
 }finally{f.restore();}
});
test('held fetches bound attachment concurrency to two; repeated start and competing downloads acquire no extra files',async()=>{
 const held=new Map<string,(response:Response)=>void>();let running=0,maxRunning=0;
 const f=fixture(async(file)=>{running++;maxRunning=Math.max(maxRunning,running);return new Promise<Response>(resolve=>held.set(file.file_ref,response=>{running--;resolve(response);}));});
 try{await f.reader.load();const pending=f.reader.downloadAttachments();await turn();assert.equal(f.calls.length,2);await f.reader.downloadAttachments();await f.reader.downloadFile(files[4].file_ref);await f.reader.downloadSource();assert.equal(f.calls.length,2);
  for(const file of files){while(!held.has(file.file_ref))await turn();held.get(file.file_ref)!(binary(file));await turn();}
  await pending;assert.equal(maxRunning,2);assert.equal(f.downloads.length,1);assert.equal(f.calls.length,5);
 }finally{f.restore();}
});
test('held denial after a successful file aborts peer reads, erases presentation and prevents ZIP/replay',async()=>{
 const held=new Map<string,(response:Response)=>void>();const f=fixture(async file=>new Promise(resolve=>held.set(file.file_ref,resolve)));
 try{await f.reader.load();const pending=f.reader.downloadAttachments();await turn();held.get(files[0].file_ref)!(binary(files[0]));await turn();assert.equal(f.calls.length,3);
  held.get(files[1].file_ref)!(new Response(null,{status:403}));await turn();assert.ok(f.calls[2].init.signal!.aborted);held.get(files[2].file_ref)!(binary(files[2]));await pending;
  assert.equal(f.calls.length,3);assert.equal(f.downloads.length,0);assert.equal(f.blobs.length,0);assert.equal(f.states.at(-1)!.value,null);assert.equal(f.states.at(-1)!.archive,null);assert.equal(f.states.at(-1)!.sourceAvailable,false);
  await f.reader.downloadAttachments();await f.reader.downloadFile(files[0].file_ref);await f.reader.downloadSource();assert.equal(f.calls.length,3);
 }finally{f.restore();}
});
test('optional file failure discards every byte, states incomplete rather than success, and leaves individual retry available',async()=>{
 let fail=true;const f=fixture(async file=>fail&&file.file_ref===files[1].file_ref?new Response(null,{status:503}):binary(file));
 try{await f.reader.load();await f.reader.downloadAttachments();assert.equal(f.downloads.length,0);assert.equal(f.blobs.length,0);assert.equal(f.states.at(-1)!.value?.account_id,account);
  assert.match(f.states.at(-1)!.archive!.notice,/1 of 5 attachments could not be downloaded.*No ZIP was saved.*individually/);assert.equal(f.states.at(-1)!.archive!.busy,false);
  fail=false;await f.reader.downloadFile(files[1].file_ref);assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].name,files[1].filename);await f.reader.downloadAttachments();assert.equal(f.downloads.length,2);
 }finally{f.restore();}
});
test('invalid binary MIME/size rejects whole ZIP and omitted nominations remain explicitly listed',async()=>{
 const f=fixture(async file=>new Response(new Uint8Array(bytes(file)),{headers:{'content-type':'text/html','x-content-type-options':'nosniff','content-disposition':'attachment;'}}),raw(files.slice(0,2),4));
 try{await f.reader.load();await f.reader.downloadAttachments();assert.equal(f.downloads.length,0);assert.match(f.states.at(-1)!.archive!.notice,/2 of 2 attachments/);}finally{f.restore();}
 const listed=fixture(undefined,raw(files.slice(0,2),4));try{await listed.reader.load();await listed.reader.downloadAttachments();assert.equal(listed.downloads.length,1);assert.match(listed.states.at(-1)!.archive!.notice,/ZIP download started for 2 listed attachments/);assert.equal(listed.states.at(-1)!.value!.omitted_file_count,4);}finally{listed.restore();}
});
test('cancel and session/dispose loss discard held late fetches and prevent publication or additional work',async()=>{
 for(const mode of ['cancel','session','dispose'] as const){const held:Array<(response:Response)=>void>=[],f=fixture(async()=>new Promise(resolve=>held.push(resolve)));
  try{await f.reader.load();const pending=f.reader.downloadAttachments();await turn();assert.equal(held.length,2);const before=f.states.length;
   if(mode==='cancel')f.reader.cancelArchive();else if(mode==='session')f.end();else f.reader.dispose();
   held[0](binary(files[0]));held[1](binary(files[1]));await pending;assert.equal(f.calls.length,2);assert.equal(f.blobs.length,0);assert.equal(f.downloads.length,0);
   if(mode==='cancel'){assert.ok(f.calls.every(call=>call.init.signal!.aborted));assert.match(f.states.at(-1)!.archive!.notice,/cancelled.*No ZIP/);}else assert.equal(f.states.length,before);
  }finally{f.restore();}
 }
});
test('cancel interrupts held response streams, zeros received chunks and suppresses late archive output',async()=>{
 let cancelCount=0;const chunk=new Uint8Array([1]),f=fixture(async file=>file.file_ref===files[0].file_ref?binary(file):new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(chunk);},cancel(){cancelCount++;}}),
  {headers:{'content-type':file.media_type,'x-content-type-options':'nosniff','content-disposition':'attachment;'}}),raw(files.slice(0,2)));
 try{await f.reader.load();const pending=f.reader.downloadAttachments();await turn();f.reader.cancelArchive();await pending;assert.equal(cancelCount,1);assert.deepEqual([...chunk],[0]);assert.equal(f.blobs.length,0);assert.equal(f.downloads.length,0);}finally{f.restore();}
});
test('60-second archive and 15-second file budgets cancel streams and never publish an incomplete ZIP',async()=>{
 for(const budget of [60_000,15_000]){
  let cancelled=0;const timers:Array<{milliseconds:number;controller:AbortController}>=[],timeout=AbortSignal.timeout;
  const f=fixture(async file=>file.file_ref===files[0].file_ref?binary(file):new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}}),
   {headers:{'content-type':file.media_type,'x-content-type-options':'nosniff','content-disposition':'attachment;'}}),raw(files.slice(0,2)));
  try{await f.reader.load();AbortSignal.timeout=milliseconds=>{const controller=new AbortController();timers.push({milliseconds,controller});return controller.signal;};
   const pending=f.reader.downloadAttachments();await turn();assert.equal(timers.filter(timer=>timer.milliseconds===60_000).length,1);
   // Each file has its own stream/fetch timeout; read() also retains its existing fetch budget.
   const target=budget===60_000?timers.find(timer=>timer.milliseconds===60_000)!:timers.filter(timer=>timer.milliseconds===15_000)[2];
   target.controller.abort(new DOMException('Timed out','TimeoutError'));await pending;assert.equal(cancelled,1);assert.equal(f.downloads.length,0);assert.equal(f.blobs.length,0);assert.equal(f.states.at(-1)!.archive!.busy,false);assert.match(f.states.at(-1)!.archive!.notice,/No ZIP was saved/);
  }finally{AbortSignal.timeout=timeout;f.restore();}
 }
});
test('oversized/unconfirmed manifest cannot start archive reads, and no-attachment source has no archive',async()=>{
 const oversized=fixture(undefined,raw([{...files[0],size_bytes:25*1024*1024},{...files[1],size_bytes:1}]));try{await oversized.reader.load();assert.ok(oversized.states.at(-1)!.value,'valid source inventory remains readable');await oversized.reader.downloadAttachments();assert.equal(oversized.calls.length,0);assert.equal(oversized.downloads.length,0);assert.match(oversized.states.at(-1)!.archive?.notice??'',/25 MiB ZIP limit/);}finally{oversized.restore();}
 const empty=fixture(undefined,raw([]));try{await empty.reader.load();await empty.reader.downloadAttachments();assert.equal(empty.calls.length,0);assert.equal(empty.downloads.length,0);}finally{empty.restore();}
});
