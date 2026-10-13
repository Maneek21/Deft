import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createNativeEmailReader,nativeAttachmentPreviewKind,parseNativeEmailPresentation,readNativeEmailBinary,throwNativeEmailSourceBusy,NativeEmailSourceBusyError,type NativeReaderState} from './email-native-reader';
import {createSessionCacheScope} from './session-cache';
import {nativeReceivedFileLimit,nativeReceivedSourceLimit} from './email-native-received-limits';

const account='personal/account',message='mail_'+'a'.repeat(64),sourceDigest='b'.repeat(64),remote='c'.repeat(64),cid='d'.repeat(64),fileRef='e'.repeat(64);
const presentation=(images:unknown[]=[],files:unknown[]=[])=>({schema_version:'deft.email_presentation.v1',account_id:account,provider:'gmail',logical_message_id:message,
  source_digest:sourceDigest,content_trust:'unsanitized',files,presentation:{format:'plain',content:'Hello <script>source text</script>',plain_text:'Hello',truncated:false,images,
    headers:[{label:'Subject',value:'A message'},{label:'From',value:'Sender <sender@example.test>'}],metadata:{account_id:account}}});
class Element{children:Element[]=[];parent:Element|null=null;style:Record<string,string>={};className='';textContent='';
  replaceChildren(...children:Element[]){for(const child of this.children)child.parent=null;this.children=children;for(const child of children)child.parent=this;}
  replaceWith(child:Element){const parent=this.parent;if(parent){const index=parent.children.indexOf(this);parent.children[index]=child;child.parent=parent;this.parent=null;}}
  querySelectorAll(){return [];}}
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let bit=0;bit<8;bit++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function pngChunk(type:string,data:Buffer){const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);let crc=0xffffffff;for(const byte of out.subarray(4,-4))crc=crcTable[(crc^byte)&255]^(crc>>>8);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;}
const rasterCache=new Map<string,Buffer>();
function raster(size=12,width=1,height=1,nonce=0){
 const key=width+':'+height;let base=rasterCache.get(key);if(!base){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  base=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),pngChunk('IEND',Buffer.alloc(0))]);rasterCache.set(key,base);}
 const padding=Buffer.alloc(Math.max(4,size-base.length-12));padding.writeUInt32BE(nonce);return Buffer.concat([base.subarray(0,-12),pngChunk('deFt',padding),base.subarray(-12)]);
}
const binary=(size=12,type='image/png',nonce=0)=>new Response(type==='image/png'?new Uint8Array(raster(size,1,1,nonce)):new Uint8Array(size),{headers:{'content-type':type,'x-content-type-options':'nosniff','content-disposition':type.startsWith('image/')?'inline':'attachment; filename="attachment"'}});
test('actual busy response gives retry-later for all native reading actions without denial, automatic replay or body loss',async()=>{
 for(const mode of ['presentation','source','file','preview','zip','image']){
  const file={file_ref:fileRef,filename:'tiny.txt',media_type:'text/plain',size_bytes:5,disposition:'attachment',preview:'text'},raw=presentation(mode==='image'?[{image_ref:remote,kind:'remote',index:0,alt:'Remote'}]:[],[file]),states:NativeReaderState[]=[];let busyCalls=0,downloads=0;
  const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:new Element() as unknown as HTMLElement,current:()=>true,render:()=>new Element() as unknown as HTMLElement,change:state=>states.push(state),download:()=>{downloads++;},fetch:async path=>{if(path.endsWith('/reading-preferences'))return Response.json({account_id:account,external_images:'ask',revision:1});if(path.endsWith('/presentation')&&mode!=='presentation')return Response.json(raw);busyCalls++;return Response.json({code:'EMAIL_SOURCE_BUSY'},{status:503,headers:{'Retry-After':'2'}});}});
  await reader.load();if(mode==='source')await reader.downloadSource();else if(mode==='file')await reader.downloadFile(fileRef);else if(mode==='preview')await reader.previewFile(fileRef);else if(mode==='zip')await reader.downloadAttachments();else if(mode==='image')await reader.loadExternalImages();
  const state=states.at(-1)!,notice=mode==='preview'?state.preview?.error:mode==='zip'?state.archive?.notice:mode==='image'?state.externalStatus:state.notice;assert.match(notice??'',/Message loading is busy\. Try again shortly\./);assert.doesNotMatch(notice??'',/access|MiB|unavailable/i);assert.equal(state.sourceAvailable,true);if(mode!=='presentation')assert.equal(state.value?.presentation.plain_text,'Hello');assert.equal(busyCalls,1);assert.equal(downloads,0);if(mode==='zip')assert.match(notice??'',/No ZIP was saved/);reader.dispose();
 }
});
test('busy parsing is bounded/status-specific and suppresses held error bytes after disposal; true403 still denies',async()=>{
 for(const response of [Response.json({code:'OTHER'},{status:503}),Response.json({code:'EMAIL_SOURCE_BUSY'},{status:200}),Response.json({code:'EMAIL_SOURCE_BUSY',extra:'x'},{status:503}),new Response('x'.repeat(1025),{status:503,headers:{'Content-Type':'application/json'}})])await throwNativeEmailSourceBusy(response,()=>true);
 await assert.rejects(throwNativeEmailSourceBusy(Response.json({code:'EMAIL_SOURCE_BUSY'},{status:503}),()=>true),NativeEmailSourceBusyError);
 let current=true,stream:ReadableStreamDefaultController<Uint8Array>|undefined;const held=throwNativeEmailSourceBusy(new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;}}),{status:503,headers:{'Content-Type':'application/json'}}),()=>current);current=false;stream!.enqueue(new TextEncoder().encode('{"code":"EMAIL_SOURCE_BUSY"}'));stream!.close();await assert.rejects(held,error=>!(error instanceof NativeEmailSourceBusyError));
 const states:NativeReaderState[]=[],reader=createNativeEmailReader({accountId:account,messageId:message,wrap:new Element() as unknown as HTMLElement,current:()=>true,change:state=>states.push(state),fetch:async()=>Response.json({code:'EMAIL_SOURCE_BUSY'},{status:403})});await reader.load();assert.equal(states.at(-1)!.sourceAvailable,false);assert.equal(states.at(-1)!.value,null);assert.match(states.at(-1)!.notice,/Account access ended/);reader.dispose();
});
test('native inventory retains oversized source-only metadata and body within35 MiB; forged per-file/aggregate excess fails',()=>{
 const f={file_ref:fileRef,filename:'large.dat',media_type:'application/octet-stream',size_bytes:nativeReceivedSourceLimit,disposition:'attachment',preview:'unsupported'};
 const value=parseNativeEmailPresentation(presentation([], [f]),account,message);assert.equal(value.files[0].size_bytes,nativeReceivedSourceLimit);assert.equal(value.presentation.plain_text,'Hello');assert.equal(nativeAttachmentPreviewKind(value.files[0]),null);
 assert.throws(()=>parseNativeEmailPresentation(presentation([], [{...f,size_bytes:nativeReceivedSourceLimit+1}]),account,message));
 assert.throws(()=>parseNativeEmailPresentation(presentation([], [{...f,size_bytes:nativeReceivedSourceLimit},{...f,file_ref:'f'.repeat(64),size_bytes:1}]),account,message));
});
test('actual native source35 MiB and individual25 MiB downloads preserve exact streamed bytes; oversized metadata requests no file',async()=>{
 const file={file_ref:fileRef,filename:'large.dat',media_type:'application/octet-stream',size_bytes:nativeReceivedFileLimit,disposition:'attachment',preview:'unsupported'},raw=presentation([], [file]);
 const states:NativeReaderState[]=[],requests:string[]=[],downloads:Array<{name:string;size:number;hash:string}>=[];let published:Blob|null=null;
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{assert.ok(blob instanceof Blob);published=blob;return 'blob:bounded';};URL.revokeObjectURL=()=>{};
 const expected=(size:number)=>{const hash=createHash('sha256'),chunk=Buffer.alloc(65536,37);for(let offset=0;offset<size;offset+=chunk.length)hash.update(chunk.subarray(0,Math.min(chunk.length,size-offset)));return hash.digest('hex');};
 const stream=(size:number,type:string)=>{let sent=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){const n=Math.min(65536,size-sent);if(!n){controller.close();return;}sent+=n;controller.enqueue(new Uint8Array(n).fill(37));}}),{headers:{'Content-Type':type,'Content-Length':String(size),'Content-Disposition':'attachment; filename="source"','X-Content-Type-Options':'nosniff'}});};
 const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:new Element() as unknown as HTMLElement,current:()=>true,render:()=>new Element() as unknown as HTMLElement,change:state=>states.push(state),download:(_url,name)=>{assert.ok(published);downloads.push({name,size:published.size,hash:''});},fetch:async(path,init)=>{requests.push(path);if(path.endsWith('/presentation'))return Response.json(raw);if(path.endsWith('/reading-preferences'))return Response.json({account_id:account,external_images:'ask',revision:1});if(path.endsWith('/file'))assert.deepEqual(JSON.parse(init.body as string),{source_digest:sourceDigest,file_ref:fileRef});return stream(path.endsWith('/source')?nativeReceivedSourceLimit:nativeReceivedFileLimit,path.endsWith('/source')?'message/rfc822':'application/octet-stream');}});
 try{await reader.load();assert.ok(states.at(-1)!.value);await reader.downloadSource();assert.ok(published);downloads[0].hash=createHash('sha256').update(Buffer.from(await (published as Blob).arrayBuffer())).digest('hex');assert.deepEqual(downloads[0],{name:'message.eml',size:nativeReceivedSourceLimit,hash:expected(nativeReceivedSourceLimit)});published=null;
  await reader.downloadFile(fileRef);assert.ok(published);downloads[1].hash=createHash('sha256').update(Buffer.from(await (published as Blob).arrayBuffer())).digest('hex');assert.deepEqual(downloads[1],{name:'large.dat',size:nativeReceivedFileLimit,hash:expected(nativeReceivedFileLimit)});
 }finally{reader.dispose();URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
 const oversized=fixture(presentation([], [{...file,size_bytes:nativeReceivedFileLimit+1}]));await oversized.reader.load();const before=oversized.calls.length;await oversized.reader.downloadFile(fileRef);assert.equal(oversized.calls.length,before);assert.equal(oversized.downloads.length,0);assert.ok(oversized.states.at(-1)!.value);assert.match(oversized.states.at(-1)!.notice,/25 MiB.*original/);oversized.reader.dispose();
});
test('native binary length/stream one-byte excess and scoped cancellation never return oversized private data',async()=>{
 const response=(size:number,length=size)=>new Response(new Uint8Array(size),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment;','X-Content-Type-Options':'nosniff','Content-Length':String(length)}});
 await assert.rejects(readNativeEmailBinary(response(nativeReceivedFileLimit+1),()=>true,{maxBytes:nativeReceivedFileLimit}));
 await assert.rejects(readNativeEmailBinary(response(17,16),()=>true,{maxBytes:nativeReceivedFileLimit,size:16}));
 let cancelled=0;const abort=new AbortController(),held=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(65536));},cancel(){cancelled++;}}),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment;','X-Content-Type-Options':'nosniff'}});
 const pending=readNativeEmailBinary(held,()=>!abort.signal.aborted,{maxBytes:nativeReceivedFileLimit,signal:abort.signal});await new Promise<void>(resolve=>setImmediate(resolve));abort.abort();await assert.rejects(pending);assert.equal(cancelled,1);
});
test('disposing actual large individual download cancels held stream and publishes no Blob; file denial removes source access',async()=>{
 for(const status of [200,403]){
  let cancelled=0,downloads=0,entered=()=>{};const ready=new Promise<void>(resolve=>entered=resolve),states:NativeReaderState[]=[];
  const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:new Element() as unknown as HTMLElement,current:()=>true,render:()=>new Element() as unknown as HTMLElement,change:state=>states.push(state),download:()=>{downloads++;},fetch:async path=>{
   if(path.endsWith('/presentation'))return Response.json(presentation([], [{file_ref:fileRef,filename:'large.dat',media_type:'application/octet-stream',size_bytes:nativeReceivedFileLimit,disposition:'attachment',preview:'unsupported'}]));
   if(path.endsWith('/reading-preferences'))return Response.json({account_id:account,external_images:'ask',revision:1});entered();if(status===403)return new Response(null,{status});
   return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(65536));},cancel(){cancelled++;}}),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment;','X-Content-Type-Options':'nosniff','Content-Length':String(nativeReceivedFileLimit)}});
  }});
  await reader.load();const pending=reader.downloadFile(fileRef);await ready;await new Promise<void>(resolve=>setImmediate(resolve));if(status===200)reader.dispose();await pending;assert.equal(downloads,0);
  if(status===200)assert.equal(cancelled,1);else{assert.equal(states.at(-1)!.value,null);assert.equal(states.at(-1)!.sourceAvailable,false);await reader.downloadSource();assert.equal(downloads,0);}reader.dispose();
 }
});
function fixture(raw=presentation(),choice:'ask'|'always'='ask',imageResponse:()=>Promise<Response>=async()=>binary(),preferenceResponse?:()=>Promise<Response>){
  const wrap=new Element(),states:NativeReaderState[]=[],calls:Array<{path:string;init:RequestInit}>=[];let current=true,prints=0;
  const downloads:string[]=[],renders:Array<unknown>=[];
  const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>current,
    fetch:async(path,init)=>{calls.push({path,init});if(path.endsWith('/presentation'))return Response.json(raw);
      if(path.endsWith('/reading-preferences'))return preferenceResponse?preferenceResponse():Response.json({account_id:account,external_images:choice,revision:2});
      if(path.endsWith('/image'))return imageResponse();return binary(12,path.endsWith('/source')?'message/rfc822':'application/octet-stream');},
    render:(value,images,urls,states)=>{renders.push({value,images,urls:new Map(urls),states:new Map(states)});return new Element() as unknown as HTMLElement;},
    change:state=>states.push(state),print:()=>{prints++;},download:(_url,name)=>downloads.push(name)});
  return {reader,wrap,states,calls,renders,downloads,get prints(){return prints;},end:()=>{current=false;}};
}

test('native presentation parser pins account/logical/digest and rejects locators, duplicate refs and malicious header controls',()=>{
  assert.equal(parseNativeEmailPresentation(presentation(),account,message).source_digest,sourceDigest);
  const mutations=[{...presentation(),account_id:'foreign'},{...presentation(),logical_message_id:'mail_'+'f'.repeat(64)},
    {...presentation(),provider_locator:'private'}, {...presentation(),content_trust:'sanitized'}, {...presentation(),provider:['gmail']},
    {...presentation(),presentation:{...presentation().presentation,headers:[{label:'Subject',value:'bad\nheader'}]}},
    {...presentation(),presentation:{...presentation().presentation,metadata:{account_id:account,provider_locator:'private'}}},
    presentation([{image_ref:remote,kind:'remote',index:0,alt:'a'},{image_ref:remote,kind:'remote',index:1,alt:'b'}]),
    {...presentation(),presentation:{...presentation().presentation,content:'😀'.repeat(70000)}}];
  for(const raw of mutations)assert.throws(()=>parseNativeEmailPresentation(raw,account,message));
});

test('plain native source enters the actual safe document primitive as text, with no raw HTML insertion',async()=>{
  const original=globalThis.document;
  Object.assign(globalThis,{document:{createElement:()=>new Element()}});
  try{
    const wrap=new Element(),reader=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>true,change:()=>{},
      fetch:async(path)=>Response.json(path.endsWith('/presentation')?presentation():{account_id:account,external_images:'ask',revision:1})});
    await reader.load();assert.equal(wrap.children[0].textContent,'Hello <script>source text</script>');
    assert.equal(wrap.children[0].className,'ex-safe-document');reader.dispose();assert.equal(wrap.children.length,0);
  }finally{Object.assign(globalThis,{document:original});}
});

test('ordinary same-selection refresh and hidden tabs retain the loaded native body without duplicate reads',async()=>{
  const f=fixture();await f.reader.load();const body=f.wrap.children[0],before=f.calls.length;
  const original=globalThis.document;Object.assign(globalThis,{document:{hidden:true}});
  try{await f.reader.load();assert.equal(f.calls.length,before);assert.equal(f.wrap.children[0],body);}
  finally{Object.assign(globalThis,{document:original});}
  const source=readFileSync(new URL('../components/email/native-email-reader.tsx',import.meta.url),'utf8');
  assert.ok(!source.includes('document.hidden')&&!source.includes('visibilitychange')&&!source.includes('expires_at'));
  assert.match(source,/key=\{JSON.stringify\(\[props.accountId,props.logicalMessageId,props.sessionScope,props.revision,retry\]\)\}/);
  f.reader.dispose();assert.equal(f.wrap.children.length,0);
});

test('canonical human session identity stays stable through same-SID token rotation',()=>{
  const token=(exp:number)=>'header.'+Buffer.from(JSON.stringify({id:'human',org_id:'org',sid:'same-session',exp})).toString('base64url')+'.signature';
  const input={authenticatedUserId:'human',authenticatedOrgId:'org',authEpoch:1};
  assert.equal(createSessionCacheScope({...input,accessToken:token(1)}),createSessionCacheScope({...input,accessToken:token(2)}));
});

test('CID images use digest-bound native requests; remote Ask waits for explicit choice and print acquires nothing',async()=>{
  const f=fixture(presentation([{image_ref:cid,kind:'cid',index:0,alt:'logo'},{image_ref:remote,kind:'remote',index:1,alt:'photo'}]));
  await f.reader.load();assert.equal(f.calls.filter(c=>c.path.endsWith('/image')).length,1);
  assert.deepEqual(JSON.parse(f.calls.find(c=>c.path.endsWith('/image'))!.init.body as string),{source_digest:sourceDigest,image_ref:cid});
  assert.equal(f.states.at(-1)!.externalAvailable,true);const before=f.calls.length;f.reader.print();assert.equal(f.prints,1);assert.equal(f.calls.length,before);
  await f.reader.loadExternalImages();assert.equal(f.calls.filter(c=>c.path.endsWith('/image')).length,2);
  assert.equal(f.states.at(-1)!.externalAvailable,false);f.reader.dispose();
});

test('only verified saved Always loads remote images automatically; unavailable preferences retain Ask',async()=>{
  const raw=presentation([{image_ref:remote,kind:'remote',index:0,alt:'photo'}]);
  const f=fixture(raw,'always');await f.reader.load();assert.equal(f.calls.filter(c=>c.path.endsWith('/image')).length,1);f.reader.dispose();
  const fallback=fixture(raw,'always',async()=>binary(),async()=>new Response(null,{status:503}));await fallback.reader.load();
  assert.equal(fallback.calls.filter(c=>c.path.endsWith('/image')).length,0);assert.equal(fallback.wrap.children.length,1);fallback.reader.dispose();
  const revoked=fixture(raw,'always',async()=>binary(),async()=>new Response(null,{status:403}));await revoked.reader.load();
  assert.equal(revoked.wrap.children.length,0);assert.equal(revoked.calls.filter(c=>c.path.endsWith('/image')).length,0);
});

test('held presentation and image responses are discarded after account/session disposal; URLs are revoked',async()=>{
  let release!:(response:Response)=>void;const f=fixture(presentation([{image_ref:remote,kind:'remote',index:0,alt:'photo'}]),'ask',()=>new Promise(resolve=>{release=resolve;}));
  await f.reader.load();const images=f.reader.loadExternalImages();while(!release)await new Promise(resolve=>setImmediate(resolve));
  const before=f.states.length;f.end();f.reader.dispose();release(binary());await images;
  assert.equal(f.wrap.children.length,0);assert.equal(f.states.length,before);
  let releaseSource!:(response:Response)=>void;const wrap=new Element();let states=0;
  const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>true,change:()=>{states++;},
    fetch:()=>new Promise(resolve=>{releaseSource=resolve;})});const load=reader.load();reader.dispose();releaseSource(Response.json(presentation()));await load;
  assert.equal(states,0);assert.equal(wrap.children.length,0);
});

test('native permission denial clears loaded body immediately without trusting a cached presentation',async()=>{
  const f=fixture(presentation([{image_ref:remote,kind:'remote',index:0,alt:'photo'}]),'ask',async()=>new Response(null,{status:403}));
  await f.reader.load();assert.equal(f.wrap.children.length,1);await f.reader.loadExternalImages();
  assert.equal(f.wrap.children.length,0);assert.equal(f.states.at(-1)!.value,null);assert.match(f.states.at(-1)!.notice,/access ended/);
});

test('image byte budget caps cumulative URLs and unsupported/failure statuses stay distinct',async()=>{
  const images=Array.from({length:18},(_,i)=>({image_ref:(i+1).toString(16).padStart(64,'0'),kind:'remote',index:i,alt:'photo'}));
  const created:string[]=[],revoked:string[]=[],originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  URL.createObjectURL=()=>{const url='blob:test/'+created.length;created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);};
  try{
    let nonce=0;const f=fixture(presentation(images),'always',async()=>binary(2097152,'image/png',nonce++));await f.reader.load();assert.equal(created.length,16);
    assert.equal(f.states.at(-1)!.imageLimit,true);assert.match(f.states.at(-1)!.externalStatus,/32 MiB.*32 megapixel/);f.reader.dispose();assert.deepEqual(revoked,created);
  }finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
  for(const [response,expected]of [[binary(12,'image/svg+xml'),/unsupported/],[new Response(null,{status:503}),/could not be loaded/]]as const){
    const f=fixture(presentation([{image_ref:remote,kind:'remote',index:0,alt:'photo'}]),'always',async()=>response);await f.reader.load();
    assert.match(f.states.at(-1)!.externalStatus,expected);f.reader.dispose();
  }
});

test('one explicit choice loads a distinct 23-image newsletter above8 MiB within native bounds',async()=>{
 const images=Array.from({length:23},(_,index)=>({image_ref:(index+1).toString(16).padStart(64,'0'),kind:'remote',index,alt:'Newsletter tile'}));let nonce=0;
 const f=fixture(presentation(images),'ask',async()=>binary(1024*1024,'image/png',nonce++));await f.reader.load();assert.equal(f.calls.filter(c=>c.path.endsWith('/image')).length,0);
 await f.reader.loadExternalImages();assert.equal(f.calls.filter(c=>c.path.endsWith('/image')).length,23);assert.equal(f.states.at(-1)!.imageLimit,false);assert.equal(f.states.at(-1)!.externalAvailable,false);assert.equal((f.renders.at(-1) as {urls:Map<string,string>}).urls.size,23);assert.equal(f.states.at(-1)!.value?.presentation.plain_text,'Hello');f.reader.dispose();
});

test('received aggregate32 megapixels accepts the exact boundary and a blocked large image does not stop smaller later images',async()=>{
 for(const exact of [true,false]){
  const dimensions=exact?Array.from({length:9},()=>[2000,2000]):[...Array.from({length:7},()=>[2000,2000]),[2000,1500],[2000,2000],[1,1]];
  const images=dimensions.map((_,index)=>({image_ref:(index+1).toString(16).padStart(64,'0'),kind:'remote',index,alt:'Photo'}));let index=0;
  const f=fixture(presentation(images),'always',async()=>{const i=index++,[w,h]=dimensions[i];return new Response(new Uint8Array(raster(12,w,h,i)),{headers:{'Content-Type':'image/png','X-Content-Type-Options':'nosniff'}});});
  await f.reader.load();const rendered=f.renders.at(-1) as {urls:Map<string,string>;states:Map<string,string>};assert.equal(f.states.at(-1)!.imageLimit,true);assert.equal(rendered.urls.size,exact?8:9);assert.equal(rendered.states.get(images[8].image_ref),'limit');if(!exact)assert.ok(rendered.urls.has(images[9].image_ref));assert.equal(f.calls.filter(c=>c.path.endsWith('/image')).length,images.length);f.reader.dispose();
 }
});

test('identical concurrent CID and remote raster payloads share one URL and denial/disposal revoke it once',async()=>{
 const images=[{image_ref:cid,kind:'cid',index:0,alt:'Embedded'},{image_ref:remote,kind:'remote',index:1,alt:'Remote'},{image_ref:'f'.repeat(64),kind:'remote',index:2,alt:'Remote copy'}];
 const created:string[]=[],revoked:string[]=[],create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=()=>{const url='blob:dedup/'+created.length;created.push(url);return url;};URL.revokeObjectURL=url=>revoked.push(url);
 try{for(const deny of [false,true]){const f=fixture(presentation(images),'ask',async()=>binary());await f.reader.load();await f.reader.loadExternalImages();assert.equal(created.length,deny?2:1);assert.equal(new Set((f.renders.at(-1) as {urls:Map<string,string>}).urls.values()).size,1);
   if(deny){f.end();}f.reader.dispose();f.reader.dispose();}assert.deepEqual(revoked,created);
  const f=fixture(presentation(images),'ask',async()=>binary());await f.reader.load();f.reader.dispose();assert.deepEqual(revoked,created);
  let count=0;const denied=fixture(presentation(images),'ask',async()=>++count===1?binary():new Response(null,{status:403}));await denied.reader.load();await denied.reader.loadExternalImages();assert.equal(denied.states.at(-1)!.value,null);assert.equal(denied.states.at(-1)!.sourceAvailable,false);assert.deepEqual(revoked,created);denied.reader.dispose();assert.deepEqual(revoked,created);
 }finally{URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
});

test('CID and remote loading together never exceed two reads and queued work ends on disposal',async()=>{
 const images=Array.from({length:4},(_,index)=>({image_ref:(index+1).toString(16).padStart(64,'0'),kind:index<2?'cid':'remote',index,alt:'Held'}));let entered=0,active=0,maximum=0;
 const releases:Array<(value:Response)=>void>=[],f=fixture(presentation(images),'ask',()=>{entered++;active++;maximum=Math.max(maximum,active);return new Promise<Response>(resolve=>releases.push(value=>{active--;resolve(value);}));});
 const loading=f.reader.load();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(entered,2);const remoteLoading=f.reader.loadExternalImages();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(entered,2);f.reader.dispose();for(const release of releases)release(binary());await Promise.all([loading,remoteLoading]);assert.equal(maximum,2);assert.equal(entered,2);assert.equal(f.wrap.children.length,0);
});

test('malformed received raster stays retryable without a Blob or limit claim',async()=>{
 let reads=0;const f=fixture(presentation([{image_ref:remote,kind:'remote',index:0,alt:'Photo'}]),'always',async()=>++reads===1?new Response(new Uint8Array(12),{headers:{'Content-Type':'image/png','X-Content-Type-Options':'nosniff'}}):binary());await f.reader.load();assert.equal(f.states.at(-1)!.imageLimit,false);assert.equal(f.states.at(-1)!.externalAvailable,true);assert.match(f.states.at(-1)!.externalStatus,/could not be loaded/);assert.equal((f.renders.at(-1) as {urls:Map<string,string>}).urls.size,0);await f.reader.loadExternalImages();assert.equal(reads,2);assert.equal(f.states.at(-1)!.externalAvailable,false);f.reader.dispose();
});

test('disposal during the asynchronous image digest zeroes its owned copy and publishes no URL',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(crypto.subtle,'digest'),original=crypto.subtle.digest;let input:Uint8Array|undefined,release:(value:ArrayBuffer)=>void=()=>{},created=0;
 const create=URL.createObjectURL;URL.createObjectURL=()=>{created++;return 'blob:late';};Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:(_algorithm:AlgorithmIdentifier,bytes:Uint8Array)=>{input=bytes;return new Promise<ArrayBuffer>(resolve=>release=resolve);}});
 const f=fixture(presentation([{image_ref:remote,kind:'remote',index:0,alt:'Photo'}]),'ask');
 try{await f.reader.load();const loading=f.reader.loadExternalImages();while(!input)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(input.some(byte=>byte!==0));f.reader.dispose();release(new ArrayBuffer(32));await loading;assert.ok(input.every(byte=>byte===0));assert.equal(created,0);assert.equal(f.wrap.children.length,0);}
 finally{f.reader.dispose();if(descriptor)Object.defineProperty(crypto.subtle,'digest',descriptor);else{delete (crypto.subtle as unknown as {digest?:unknown}).digest;assert.equal(crypto.subtle.digest,original);}URL.createObjectURL=create;}
});

test('attachment download pins manifest ref/digest and respects byte/type limits without exposing locator fields',async()=>{
  const f=fixture(presentation([],[{file_ref:fileRef,filename:'receipt.txt',media_type:'application/octet-stream',size_bytes:12,disposition:'attachment',preview:'text'}]));
  await f.reader.load();await f.reader.downloadFile('f'.repeat(64));assert.equal(f.calls.filter(c=>c.path.endsWith('/file')).length,0);
  await f.reader.downloadFile(fileRef);assert.deepEqual(f.downloads,['receipt.txt']);
  assert.deepEqual(JSON.parse(f.calls.find(c=>c.path.endsWith('/file'))!.init.body as string),{source_digest:sourceDigest,file_ref:fileRef});
  await f.reader.downloadSource();assert.deepEqual(f.downloads,['receipt.txt','message.eml']);
  assert.equal(f.calls.find(c=>c.path.endsWith('/source'))!.init.body,undefined);f.reader.dispose();
  await assert.rejects(readNativeEmailBinary(binary(13,'application/octet-stream'),()=>true,{maxBytes:12,size:12,mediaType:'application/octet-stream'}));
  await assert.rejects(readNativeEmailBinary(binary(12,'image/svg+xml'),()=>true,{maxBytes:2097152,image:true}));
  await assert.rejects(readNativeEmailBinary(binary(),()=>false,{maxBytes:2097152,image:true}));
});

const attachment=(type='text/plain',preview:'text'|'image'|'pdf'|'unsupported'='text',size=5,ref=fileRef)=>({file_ref:ref,filename:'résumé '+ref.slice(0,1)+'.txt',media_type:type,size_bytes:size,disposition:'attachment' as const,preview});
function previewFixture(files:ReturnType<typeof attachment>[],respond:(init:RequestInit)=>Promise<Response>){
  const wrap=new Element(),states:NativeReaderState[]=[],calls:Array<{path:string;init:RequestInit}>=[];let allowed=true;
  const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>allowed,change:s=>states.push(s),
    render:()=>new Element() as unknown as HTMLElement,fetch:async(path,init)=>{calls.push({path,init});
      if(path.endsWith('/presentation'))return Response.json(presentation([],files));
      if(path.endsWith('/reading-preferences'))return Response.json({account_id:account,external_images:'ask',revision:1});
      return respond(init);}});
  return {reader,states,calls,wrap,end:()=>{allowed=false;reader.dispose();}};
}
const fileResponse=(bytes:Uint8Array,type='text/plain',nosniff=true)=>new Response(new Uint8Array(bytes),{headers:{'content-type':type,'content-disposition':'attachment; filename="file"',...(nosniff?{'x-content-type-options':'nosniff'}:{})}});

test('preview kind requires declared MIME pair and 2 MiB bound; unsupported files acquire no bytes',async()=>{
  for(const file of [attachment('text/html'),attachment('image/svg+xml','image'),attachment('application/pdf','text'),attachment('text/plain','unsupported'),attachment('text/plain','text',2097153)])assert.equal(nativeAttachmentPreviewKind(file),null);
  const f=previewFixture([attachment('application/pdf','text')],async()=>fileResponse(new Uint8Array(5)));await f.reader.load();
  await f.reader.previewFile(fileRef);assert.equal(f.calls.filter(c=>c.path.endsWith('/file')).length,0);assert.equal(f.states.at(-1)!.preview,null);f.reader.dispose();
});

test('text preview pins digest/ref/no-store, stays inert and reports clipping',async()=>{
  const text='<script>mail()</script>'+ 'x'.repeat(262144),bytes=new TextEncoder().encode(text);
  const f=previewFixture([attachment('text/plain','text',bytes.length)],async()=>fileResponse(bytes));await f.reader.load();const body=f.wrap.children[0];
  await f.reader.previewFile(fileRef);const preview=f.states.at(-1)!.preview!;
  assert.equal(preview.kind,'text');assert.equal(preview.text.length,262144);assert.ok(preview.text.startsWith('<script>'));assert.equal(preview.clipped,true);
  const call=f.calls.find(c=>c.path.endsWith('/file'))!;assert.equal(call.init.cache,'no-store');assert.deepEqual(JSON.parse(call.init.body as string),{source_digest:sourceDigest,file_ref:fileRef});
  assert.equal(f.wrap.children[0],body);assert.equal(f.states.at(-1)!.notice,'');f.reader.closePreview();assert.equal(f.states.at(-1)!.preview,null);f.reader.dispose();
});

test('optional preview type/size/nosniff/text/fetch failures retain the message; denial clears it',async()=>{
  const cases=[()=>Promise.resolve(fileResponse(new Uint8Array([0,1,2,3,4]))),()=>Promise.resolve(fileResponse(new Uint8Array([255,255,255,255,255]))),
    ()=>Promise.resolve(fileResponse(new Uint8Array(5),'text/html')),()=>Promise.resolve(fileResponse(new Uint8Array(6))),
    ()=>Promise.resolve(fileResponse(new TextEncoder().encode('hello'),'text/plain',false)),()=>Promise.resolve(new Response(null,{status:503})),()=>Promise.reject(Error('offline'))];
  for(const respond of cases){const f=previewFixture([attachment()],respond);await f.reader.load();await f.reader.previewFile(fileRef);
    assert.match(f.states.at(-1)!.preview!.error,/could not be previewed/);assert.ok(f.states.at(-1)!.value);assert.equal(f.wrap.children.length,1);f.reader.dispose();}
  const denied=previewFixture([attachment()],async()=>new Response(null,{status:403}));await denied.reader.load();await denied.reader.previewFile(fileRef);
  assert.equal(denied.states.at(-1)!.value,null);assert.equal(denied.states.at(-1)!.preview,null);assert.equal(denied.wrap.children.length,0);
});

test('raster/PDF preview URLs are replaced, closed and disposed without duplicate downloads',async()=>{
  const created:string[]=[],revoked:string[]=[],originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  URL.createObjectURL=()=>{const url='blob:preview/'+created.length;created.push(url);return url;};URL.revokeObjectURL=url=>{revoked.push(url);};
  try{const files=[attachment('image/png','image',12),attachment('application/pdf','pdf',12,'f'.repeat(64))];
    const f=previewFixture(files,async init=>fileResponse(new Uint8Array(12),JSON.parse(init.body as string).file_ref===fileRef?'image/png':'application/pdf'));await f.reader.load();
    await f.reader.previewFile(fileRef);assert.equal(f.states.at(-1)!.preview!.kind,'image');assert.equal(f.states.at(-1)!.preview!.url,created[0]);
    await f.reader.previewFile(files[1].file_ref);assert.deepEqual(revoked,[created[0]]);assert.equal(f.states.at(-1)!.preview!.kind,'pdf');
    f.reader.closePreview();assert.deepEqual(revoked,created);await f.reader.previewFile(fileRef);f.reader.dispose();assert.deepEqual(revoked,created);
  }finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});

test('closed/replaced previews discard late fetches and cancel blocked streams',async()=>{
  const releases:Array<(r:Response)=>void>=[],signals:AbortSignal[]=[];
  const f=previewFixture([attachment()],init=>{signals.push(init.signal!);return new Promise(resolve=>releases.push(resolve));});await f.reader.load();
  const first=f.reader.previewFile(fileRef);f.reader.closePreview();assert.equal(signals[0].aborted,true);
  let lateCancelled=false;releases[0](new Response(new ReadableStream({cancel(){lateCancelled=true;}})));await first;
  assert.equal(lateCancelled,true);assert.equal(f.states.at(-1)!.preview,null);
  const older=f.reader.previewFile(fileRef),newer=f.reader.previewFile(fileRef);releases[2](fileResponse(new TextEncoder().encode('newer')));await newer;
  releases[1](fileResponse(new TextEncoder().encode('older')));await older;assert.equal(f.states.at(-1)!.preview!.text,'newer');f.reader.dispose();
  let cancelled=false,started=false;const stream=previewFixture([attachment()],async()=>new Response(new ReadableStream({start(c){started=true;c.enqueue(new TextEncoder().encode('hello'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/plain','x-content-type-options':'nosniff','content-disposition':'attachment; filename="file"'}}));
  await stream.reader.load();const pending=stream.reader.previewFile(fileRef);while(!started)await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));stream.reader.closePreview();await pending;assert.equal(cancelled,true);assert.equal(stream.states.at(-1)!.preview,null);stream.reader.dispose();
});

test('scope disposal discards late preview bytes and closing preview preserves loaded body image URL',async()=>{
  let release!:(r:Response)=>void;const f=previewFixture([attachment()],()=>new Promise(resolve=>{release=resolve;}));await f.reader.load();
  const pending=f.reader.previewFile(fileRef);const count=f.states.length;f.end();release(fileResponse(new TextEncoder().encode('hello')));await pending;assert.equal(f.states.length,count);assert.equal(f.wrap.children.length,0);
  const originalRevoke=URL.revokeObjectURL,revoked:string[]=[];URL.revokeObjectURL=url=>{revoked.push(url);};
  try{const images=fixture(presentation([{image_ref:cid,kind:'cid',index:0,alt:'logo'}],[attachment()]));await images.reader.load();const body=images.wrap.children[0];
    images.reader.closePreview();assert.equal(revoked.length,0);assert.equal(images.wrap.children[0],body);images.reader.dispose();assert.equal(revoked.length,1);
  }finally{URL.revokeObjectURL=originalRevoke;}
});

test('held presentation JSON is discarded after scope disposal before parsing or rendering',async()=>{
  let release!:(v:unknown)=>void;const wrap=new Element(),states:NativeReaderState[]=[];
  const response=Response.json({});response.json=()=>new Promise(resolve=>{release=resolve;});
  const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>true,change:s=>states.push(s),fetch:async()=>response,
    render:()=>new Element() as unknown as HTMLElement});
  const pending=reader.load();while(!release)await new Promise(resolve=>setImmediate(resolve));reader.dispose();release(presentation());await pending;
  assert.equal(states.length,0);assert.equal(wrap.children.length,0);
});
test('native overflow and formatting fallback accept bounded optional fields without weakening nomination checks',async()=>{
 const raw={...presentation(),omitted_file_count:3,presentation:{...presentation().presentation,rendering_fallback:'plain_text'}};
 const parsed=parseNativeEmailPresentation(raw,account,message);assert.equal(parsed.omitted_file_count,3);assert.equal(parsed.presentation.rendering_fallback,'plain_text');assert.equal(parseNativeEmailPresentation(presentation(),account,message).omitted_file_count,undefined);
 for(const value of [-1,257,1.5,'1',null])assert.throws(()=>parseNativeEmailPresentation({...raw,omitted_file_count:value},account,message));
 for(const p of [{...raw.presentation,rendering_fallback:'html'},{...raw.presentation,format:'html'},{...raw.presentation,images:[{image_ref:cid,kind:'cid',index:0,alt:''}]}])assert.throws(()=>parseNativeEmailPresentation({...raw,presentation:p},account,message));
 const f=fixture(raw);await f.reader.load();assert.match(f.states.at(-1)!.notice,/Shown as plain text\. Download the original for full formatting\./);assert.equal(f.wrap.children.length,1);f.reader.dispose();
});
test('original source remains independently downloadable after unavailable or unparseable presentation, but denial and disposal stop it',async()=>{
 for(const presentationResponse of [new Response(null,{status:503}),Response.json({...presentation(),unexpected:true})]){
   const wrap=new Element(),states:NativeReaderState[]=[],paths:string[]=[],downloads:string[]=[];
   const reader=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>true,change:s=>states.push(s),download:(_url,name)=>downloads.push(name),
     fetch:async path=>{paths.push(path);return path.endsWith('/presentation')?presentationResponse:binary(12,'message/rfc822');}});
   await reader.load();assert.equal(states.at(-1)!.value,null);assert.equal(states.at(-1)!.sourceAvailable,true);await reader.downloadSource();assert.deepEqual(downloads,['message.eml']);assert.ok(paths[1].endsWith('/source'));reader.dispose();await reader.downloadSource();assert.equal(paths.length,2);
 }
 const denied=previewFixture([],async()=>new Response(null,{status:403}));await denied.reader.load();await denied.reader.downloadSource();assert.equal(denied.states.at(-1)!.sourceAvailable,false);const before=denied.calls.length;await denied.reader.downloadSource();assert.equal(denied.calls.length,before);
 const loaded=previewFixture([attachment()],async init=>init.method==='POST'?fileResponse(new TextEncoder().encode('hello')):new Response(null,{status:403}));await loaded.reader.load();await loaded.reader.previewFile(fileRef);assert.ok(loaded.states.at(-1)!.preview);await loaded.reader.downloadSource();assert.equal(loaded.states.at(-1)!.preview,null);assert.equal(loaded.states.at(-1)!.sourceAvailable,false);assert.equal(loaded.states.at(-1)!.value,null);
 let release!:(r:Response)=>void,downloads=0;const states:NativeReaderState[]=[],wrap=new Element();
 const held=createNativeEmailReader({accountId:account,messageId:message,wrap:wrap as unknown as HTMLElement,current:()=>true,change:s=>states.push(s),download:()=>{downloads++;},fetch:async path=>path.endsWith('/presentation')?new Response(null,{status:503}):new Promise(resolve=>{release=resolve;})});
 await held.load();const pending=held.downloadSource();held.dispose();release(binary(12,'message/rfc822'));await pending;assert.equal(downloads,0);
});
