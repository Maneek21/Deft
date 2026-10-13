import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createEmailAttachmentRoutes} from '../src/routes/email-attachments.js';
const draft=randomUUID(),file=randomUUID(),path=`/accounts/account/drafts/${draft}/files/${file}`,auth={authorization:'Bearer valid'};
function fixture(){
 const calls:unknown[][]=[],data=Buffer.from('fixture bytes'),metadata={file_id:file,filename:'Synthetic résumé.txt',media_type:'text/plain',size_bytes:data.length,sha256:'a'.repeat(64)};
 let released:Uint8Array|undefined;
 const service={upload:async(...args:unknown[])=>{calls.push(['upload',...args.slice(0,6),Buffer.from(args[6] as Uint8Array)]);released=args[6] as Uint8Array;return {revision:2,file:metadata};},
  detach:async(...args:unknown[])=>{calls.push(['detach',...args]);return {revision:3};},
  read:async(...args:unknown[])=>{calls.push(['read',...args]);const bytes=Buffer.from(data);released=bytes;return {...metadata,bytes};}};
 const routes=createEmailAttachmentRoutes({verify:async token=>{if(token!=='valid')throw Error('invalid');return {id:'owner',org_id:'org',sid:'sid',exp:2_000_000_000};},files:async()=>service,now:()=>1000});
 return {routes,calls,data,metadata,get released(){return released;}};
}
test('attachment HTTP uploads raw bytes with owner session and metadata, then clears transient input',async()=>{
 const f=fixture(),response=await f.routes.request(path,{method:'PUT',headers:{...auth,'content-type':'text/plain','x-email-filename':encodeURIComponent(f.metadata.filename),'x-email-draft-revision':'1'},body:Buffer.from(f.data)});
 assert.equal(response.status,200);assert.equal((await response.json() as any).revision,2);
 assert.deepEqual(f.calls[0]?.slice(1,7),[{user_id:'owner',web_session_id:'sid',access_expires_at:2_000_000_000_000},{org_id:'org',owner_user_id:'owner',account_id:'account'},draft,1,file,{filename:f.metadata.filename,media_type:'text/plain'}]);
 assert.deepEqual(f.calls[0]?.[7],f.data);assert.ok(f.released?.every(byte=>byte===0));
});
test('download copies bytes before clearing server buffer and forces attachment handling',async()=>{
 const f=fixture(),response=await f.routes.request(path,{headers:auth});
 assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.data);assert.ok(f.released?.every(byte=>byte===0));
 assert.match(response.headers.get('content-disposition')!,/^attachment;.*Synthetic%20r%C3%A9sum%C3%A9.txt/u);
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'no-store');
});
test('unauthorized uploads, oversized declarations, malformed headers and forged detach ownership do not reach custody',async()=>{
 const f=fixture(),headers={...auth,'content-type':'text/plain','x-email-filename':'notes.txt','x-email-draft-revision':'1'};
 assert.equal((await f.routes.request(path,{method:'PUT',headers:{...headers,authorization:'Bearer invalid'},body:'x'})).status,401);
 assert.equal((await f.routes.request(path,{method:'PUT',headers:{...headers,'content-length':String(25*1024*1024+1)},body:'x'})).status,413);
 assert.equal((await f.routes.request(path,{method:'PUT',headers:{...headers,'x-email-filename':'%ZZ'},body:'x'})).status,400);
 assert.equal((await f.routes.request(path+'/detach',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({expected_revision:2,owner_user_id:'other'})})).status,400);
 assert.equal(f.calls.length,0);
 const detached=await f.routes.request(path+'/detach',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({expected_revision:2})});
 assert.equal(detached.status,200);assert.equal(f.calls[0]?.[0],'detach');
});
