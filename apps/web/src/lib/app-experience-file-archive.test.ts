import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createExperienceFileArchive} from './app-experience-file-archive';
const oldDocument=globalThis.document,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
let blobs:Blob[]=[],names:string[]=[],revoked=0;
test.beforeEach(()=>{blobs=[];names=[];revoked=0;globalThis.document={createElement:()=>({download:'',href:'',click(){names.push(this.download);}})} as unknown as Document;URL.createObjectURL=blob=>{blobs.push(blob as Blob);return 'blob:archive';};URL.revokeObjectURL=()=>{revoked++;};});
test.after(()=>{globalThis.document=oldDocument;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;});
test('scoped host ZIP reuses native safe names/collisions and independent unzip confirms exact bytes',async()=>{
 const files=[{filename:'../unsafe:file?.txt',size_bytes:3},{filename:'CON.txt',size_bytes:0},{filename:'Report.csv',size_bytes:1},{filename:'report.csv',size_bytes:1}],buffers=[new Uint8Array([0,255,10]),new Uint8Array(),new Uint8Array([1]),new Uint8Array([2])];let reads=0;
 const host=createExperienceFileArchive({files:()=>files,subject:()=> 'Synthetic / files',current:()=>true,signal:new AbortController().signal,read:async()=>buffers[reads++]});
 assert.equal(await host.download(),true);assert.equal(reads,4);assert.equal(revoked,1);assert.deepEqual(names,['Synthetic _ files.zip']);
 const bytes=await blobs[0].arrayBuffer();const entries=JSON.parse(execFileSync('python',['-c','import io,json,sys,zipfile;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None;print(json.dumps([{"name":i.filename,"bytes":list(z.read(i))} for i in z.infolist()]))'],{input:Buffer.from(bytes)}).toString());
 assert.deepEqual(entries,[{name:'.._unsafe_file_.txt',bytes:[0,255,10]},{name:'_CON.txt',bytes:[]},{name:'Report.csv',bytes:[1]},{name:'report (2).csv',bytes:[2]}]);assert.ok(buffers.every(bytes=>bytes.every(byte=>byte===0)));host.dispose();
});
test('failed/changed file never saves partial ZIP and no automatic retry occurs',async()=>{
 for(const change of ['read','size','hash','list','scope'] as const){let files=[{filename:'a.txt',size_bytes:1,sha256:undefined as string|undefined},{filename:'b.txt',size_bytes:1,sha256:undefined as string|undefined}],reads=0,live=true;const held:Uint8Array[]=[];
  if(change==='hash')files[0].sha256='a'.repeat(64);
  const host=createExperienceFileArchive({files:()=>files,current:()=>live,signal:new AbortController().signal,read:async()=>{reads++;if(change==='read'&&reads===2)throw Error('Read failed');const bytes=new Uint8Array(change==='size'?2:1).fill(8);held.push(bytes);if(change==='list')files=[...files,{filename:'new.txt',size_bytes:1,sha256:undefined}];if(change==='scope')live=false;return bytes;}});
  assert.equal(await host.download(),false,change);assert.ok(reads<=2);assert.ok(held.every(bytes=>bytes.every(byte=>byte===0)));host.dispose();
 }assert.equal(blobs.length,0);
});
test('count, payload and filename limits fail before IO and never truncate the names',async()=>{
 for(const files of [[],Array.from({length:33},()=>({filename:'a',size_bytes:0})),[{filename:'a',size_bytes:26214401}],[{filename:'a'.repeat(201),size_bytes:1}]]){let reads=0;const host=createExperienceFileArchive({files:()=>files,current:()=>true,signal:new AbortController().signal,read:async()=>{reads++;return new Uint8Array();}});assert.equal(await host.download(),false);assert.equal(reads,0);host.dispose();}assert.equal(blobs.length,0);
});
test('explicit cancel/disposal and total deadline settle held reads, wipe late data and block duplicate requests',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});for(const how of ['cancel','dispose','timeout'] as const){let release!:(bytes:Uint8Array)=>void,reads=0;const host=createExperienceFileArchive({files:()=>[{filename:'a',size_bytes:1}],current:()=>true,signal:new AbortController().signal,read:()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
  const pending=host.download();assert.equal(await host.download(),false);if(how==='cancel')host.cancel();if(how==='dispose')host.dispose();if(how==='timeout')t.mock.timers.tick(60000);assert.equal(await pending,false);const late=new Uint8Array([8]);release(late);await Promise.resolve();assert.equal(late[0],0);assert.equal(reads,1);host.dispose();
 }assert.equal(blobs.length,0);
});
