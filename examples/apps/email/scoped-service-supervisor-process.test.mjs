import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,chmod,chown,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {simpleParser} from 'mailparser';
import {createAppConnectionAdapter} from './providers/connection-http.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';

const rootLinux=process.platform==='linux'&&process.getuid?.()===0,version='deft.app_runtime_channel.v1';
const cli=fileURLToPath(new URL('./scoped-service-supervisor.mjs',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex'),uid=65534,gid=65534;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
async function until(read,accept,timeout=20000){const end=Date.now()+timeout;for(;;){const value=await read();if(accept(value))return value;if(Date.now()>end)throw Error('Supervisor proof deadline');await wait(50);}}
async function transferOwner(path){await chown(path,uid,gid);const names=await readdir(path,{withFileTypes:true});for(const entry of names){const child=join(path,entry.name);if(entry.isDirectory())await transferOwner(child);else await chown(child,uid,gid);}}

async function fixture(t,{loseResponse=false,expiredOwner=false}={}){
 const managerRoot=await mkdtemp('/var/tmp/deft-manager-proof-'),workerRoot=await mkdtemp('/var/tmp/deft-worker-proof-');
 await chmod(managerRoot,0o700);await chmod(workerRoot,0o700);
 const running=[];t.after(async()=>{for(const p of running)if(p.processChild.exitCode===null){p.processChild.kill('SIGKILL');await p.done;}
  await rm(managerRoot,{recursive:true,force:true});await rm(workerRoot,{recursive:true,force:true});});
 const now=Date.now(),scope={org_id:randomUUID(),owner_id:randomUUID(),installation_id:randomUUID()};
 const binding={id:randomUUID(),registration_id:randomUUID(),installation_id:scope.installation_id,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  action_key:'send_message',runtime_epoch:1,operator_user_id:scope.owner_id};
 const account_binding={scope,account_id:'gmail-isolated',provider:'gmail',connection_target:'personal',resource_binding_id:randomUUID(),
  action_binding_id:binding.id,authority_epoch:1,capabilities:['read','send']};
 const clients={gmail:{client_id:'synthetic-client',client_secret:'synthetic-client-secret',redirect_uri:'https://deft.test/apps/connections/callback'}};
 const custody_root=join(workerRoot,'oauth'),journal_root=join(workerRoot,'journal'),key=Buffer.alloc(32,3),journalKey=Buffer.alloc(32,8);
 const custody=createEncryptedEmailCustody({encryption_key:key,key_id:'proof-oauth',store:await createEmailFileCustodyStore({root:custody_root})});
 await createEmailFileCustodyStore({root:journal_root});
 const delivered=[],calls=[],results=[],children=[],errors=[];let queued=null,started=0,claims=0,sessions=0;
 const provider=async(url,init)=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-provider-token',refresh_token:'synthetic-provider-refresh',token_type:'Bearer',expires_in:3600,
   scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
  if(url==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'synthetic-subject',email:'verified@example.test',email_verified:true,name:'Verified'});
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/profile')return Response.json({emailAddress:'verified@example.test'});
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){
   assert.equal(init.headers.authorization,'Bearer synthetic-provider-token');delivered.push(Buffer.from(JSON.parse(init.body).raw,'base64url'));
   return loseResponse?new Response('controlled lost response',{status:599}):Response.json({id:'accepted-synthetic-id'});
  }throw Error('Unreviewed fixture provider URL');
 };
 const projection={purpose:'connect',org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,app_version_id:binding.app_version_id,
  grant_snapshot_id:binding.grant_snapshot_id,target_key:'personal',resource_key:'inbox',resource_binding_id:account_binding.resource_binding_id,
  action_key:'send_message',action_binding_id:binding.id,web_session_id:randomUUID(),experience_session_id:randomUUID(),runtime_registration_id:binding.registration_id,
  descriptor_digest:'sha256:'+'e'.repeat(64),allowed_operations:['list_summary','read_one'],lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,expires_at:now+300000,checked_at:now};
 const adapter=await createAppConnectionAdapter({host:{resolveContext:async()=>structuredClone(projection),assertCurrent:async()=>structuredClone(projection)},custody,fetch:provider,
  options:{origin:'https://deft.test',account_id:account_binding.account_id,provider:'gmail',authority_epoch:1,connection_target:'personal',resource_binding_id:account_binding.resource_binding_id,
   action_binding_id:binding.id,capabilities:['read','send'],clients}});
 const begin=await adapter.handle(new Request('https://deft-connection.invalid/connections/begin',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{});
 const callback=new URL('https://deft-connection.invalid/connections/callback');callback.searchParams.set('state',new URL((await begin.json()).authorization_url).searchParams.get('state'));callback.searchParams.set('code','synthetic-code');
 assert.equal((await adapter.handle(new Request(callback),{})).status,200);
 const pdf=Buffer.from('%PDF-1.4\nsynthetic immutable proof\n%%EOF'),file={file_id:randomUUID(),upload_operation_id:randomUUID(),filename:'proof.pdf',media_type:'application/pdf',byte_length:pdf.length,digest:hash(pdf),expires_at:new Date(now+300000).toISOString()};
 const input={to:'controlled@example.test',cc:'copy@example.test',bcc:'hidden@example.test',subject:'Autonomous queued proof',body:'Exact reviewed text.',body_html:'<p>Exact <strong>reviewed</strong> text.</p>',parent_record_id:''};
 const draftBinding={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,app_version_id:binding.app_version_id,grant_snapshot_id:binding.grant_snapshot_id,
  resource_target_key:'personal',state_key:'drafts',artifact_digest:'sha256:'+'a'.repeat(64),declaration_digest:'sha256:'+'b'.repeat(64),
  action_contract_digest:'sha256:'+'c'.repeat(64),input_digest:'sha256:'+'d'.repeat(64),runtime_binding_id:binding.id,action_key:'send_message',draft_id:randomUUID(),draft_revision:2};
 const built=await adapter.buildActionPayload({binding:draftBinding,input,draft_value:{...input,mode:'compose',reply_record_id:''},draft_updated_at:new Date(now).toISOString(),files:[{reference:file,bytes:pdf}],
  files_policy:{max_file_bytes:2097152,max_files_per_record:1,max_total_bytes_per_record:2097152,allowed_media_types:['application/pdf']},max_payload_bytes:4194304,expires_at:file.expires_at},{});
 const ref={snapshot_id:randomUUID(),digest:hash(built.bytes)},retained={ref,binding:draftBinding,metadata:built.metadata,file_refs:[file],expires_at:file.expires_at,byte_count:built.bytes.length,bytes_digest:hash(built.bytes)};
 const ownerIdentity={id:scope.owner_id,org_id:scope.org_id,sid:randomUUID(),exp:Math.floor(now/1000)+3600};
 let owner={accessToken:'fixture.'+Buffer.from(JSON.stringify({...ownerIdentity,exp:expiredOwner?Math.floor(now/1000)-1:ownerIdentity.exp,purpose:'web-access'})).toString('base64url')+'.fixture',refreshToken:'fixture.'+Buffer.from(JSON.stringify({...ownerIdentity,purpose:'web-refresh'})).toString('base64url')+'.fixture'},ownerRotations=0;
 let credential={session_id:randomUUID(),session_token:'s'.repeat(48),expires_at:new Date(now+300000).toISOString()};const issuedSessions=new Set();
 const server=createServer(async(req,res)=>{try{
  let body='';for await(const chunk of req)body+=chunk;const url=new URL(req.url,'http://localhost');calls.push(url.pathname);let response;
  if(url.pathname==='/proof/child'){const child=JSON.parse(body);assert.equal(child.uid,uid);assert.equal(child.gid,gid);assert.deepEqual(child.env,['PATH']);children.push(child);response=Response.json({ok:true});}
  else if(url.pathname==='/api/auth/refresh'){assert.equal(req.headers.authorization,undefined);assert.deepEqual(JSON.parse(body),{refreshToken:owner.refreshToken});ownerRotations++;
   owner={accessToken:'fixture.'+Buffer.from(JSON.stringify({...ownerIdentity,purpose:'web-access',jti:randomUUID()})).toString('base64url')+'.fixture',refreshToken:'fixture.'+Buffer.from(JSON.stringify({...ownerIdentity,purpose:'web-refresh',jti:randomUUID()})).toString('base64url')+'.fixture'};response=Response.json(owner);}
  else if(url.pathname==='/provider')response=await provider(url.searchParams.get('url'),{body,headers:req.headers});
  else if(url.pathname==='/api/apps/runtime/bindings/'+binding.id){assert.equal(req.headers.authorization,'Bearer '+owner.accessToken);response=Response.json({binding:{...binding,state:'active',registration_state:'active'},pendingRuns:queued?[{id:queued.run_id,state:'pending'}]:[]});}
  else if(url.pathname==='/api/apps/blob/composition/runtime/bindings/'+binding.id+'/sessions'){assert.equal(req.headers.authorization,'Bearer '+owner.accessToken);assert.deepEqual(JSON.parse(body),{});sessions++;credential={...credential,session_id:randomUUID()};issuedSessions.add(credential.session_id);response=Response.json({session:credential});}
  else{
   assert.equal(req.headers.authorization,'AppRuntime '+credential.session_token);const value=JSON.parse(body);assert.equal(value.schema_version,version);assert.equal(issuedSessions.has(value.session_id),true);
   if(url.pathname==='/api/app-runtime/channel/claim'){claims++;const claim=queued;queued=null;if(claim)claim.session_id=value.session_id;response=Response.json({claim});}
   else{assert.equal(value.run_id,currentClaim.run_id);assert.equal(value.attempt_id,currentClaim.attempt_id);
    if(url.pathname==='/api/app-runtime/channel/start'){started++;assert.equal(value.action_payload_version,'deft.app_action_payload.v1');response=Response.json({started:{schema_version:version,run_id:value.run_id,attempt_id:value.attempt_id,input,snapshot_ref:ref,lease_expires_at:currentClaim.lease_expires_at}});}
    else if(url.pathname==='/api/app-runtime/channel/result'){results.push(value);response=Response.json({run:{id:value.run_id,state:value.status==='returned'?'succeeded':'unknown_outcome'}});}
    else if(url.pathname==='/api/app-runtime/channel/payload'){
     assert.deepEqual(value.snapshot_ref,ref);if(value.part.kind==='metadata')response=Response.json({payload:retained});
     else{const bytes=value.part.kind==='bytes'?built.bytes:pdf;if(value.part.kind!=='bytes'){assert.equal(value.part.kind,'file');assert.equal(value.part.file_id,file.file_id);}response=new Response(bytes,{headers:{'content-type':'application/octet-stream','x-deft-snapshot-id':ref.snapshot_id,'x-deft-snapshot-digest':ref.digest,'x-deft-payload-digest':hash(bytes)}});}
    }else throw Error('Unreviewed fixture channel URL');
   }
  }
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){errors.push(error);res.writeHead(500,{'content-type':'application/json'});res.end('{"code":"ISOLATED_FIXTURE_FAILED"}');}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
 const origin='http://127.0.0.1:'+server.address().port;
 // Public synthetic transport instrumentation only. The manager and child
 // execute unchanged source, actual fork UID/GID, real SDK HTTP and custody.
 // Fork instrumentation adds a fetch preload; it cannot add owner credentials.
 const childPreload=join('/var/tmp','deft-proof-child-'+randomUUID()+'.mjs'),parentPreload=join(managerRoot,'transport.mjs');
 await writeFile(childPreload,`const original=fetch,origin=${JSON.stringify(origin)},host='https://deft.test';
 await original(origin+'/proof/child',{method:'POST',body:JSON.stringify({uid:process.getuid(),gid:process.getgid(),env:Object.keys(process.env).sort()})});
 globalThis.fetch=async(url,init)=>{const text=String(url);let response;if(text.startsWith(host+'/api/app-runtime/channel/'))response=await original(origin+text.slice(host.length),init);
 else if(text==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send')response=await original(origin+'/provider?url='+encodeURIComponent(text),init);else throw Error('Unexpected child endpoint');
 if(response.status===599)throw Error('Controlled lost provider response');return response;};`,{mode:0o644});
 t.after(()=>rm(childPreload,{force:true}));
 await writeFile(parentPreload,`import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url),cp=require('node:child_process'),originalFork=cp.fork;
 cp.fork=(file,args,options)=>{if(options.uid!==${uid}||options.gid!==${gid}||Object.keys(options.env).join(',')!=='PATH'||options.execArgv.length)throw Error('Child privileges changed');return originalFork(file,args,{...options,execArgv:['--import',${JSON.stringify(childPreload)}]});};syncBuiltinESMExports();
 const original=fetch;globalThis.fetch=(url,init)=>{const text=String(url);if(!text.startsWith('https://deft.test/api/'))throw Error('Unexpected manager endpoint');return original(${JSON.stringify(origin)}+text.slice('https://deft.test'.length),init);};`,{mode:0o600});
 await transferOwner(workerRoot);
 const state_dir=join(managerRoot,'state');await mkdir(state_dir,{mode:0o700});
 const login_file=join(managerRoot,'login.json'),worker_template_file=join(managerRoot,'worker-template.json'),configPath=join(managerRoot,'config.json');
 await writeFile(login_file,JSON.stringify(owner),{mode:0o600});
 await writeFile(worker_template_file,JSON.stringify({schema_version:'deft.email_outgoing_service.v1',account_binding,clients,custody_root,encryption_key_hex:key.toString('hex'),key_id:'proof-oauth',
  journal_root,journal_encryption_key_hex:journalKey.toString('hex'),journal_key_id:'proof-send'}),{mode:0o600});key.fill(0);journalKey.fill(0);
 await writeFile(configPath,JSON.stringify({schema_version:'deft.email_scoped_supervisor.v1',api:'https://deft.test',org_id:scope.org_id,binding,login_file,worker_template_file,state_dir,worker_uid:uid,worker_gid:gid,poll_ms:1000}),{mode:0o600});
 let currentClaim;
 const enqueue=()=>{currentClaim={schema_version:version,org_id:scope.org_id,app_installation_id:scope.installation_id,app_version_id:binding.app_version_id,grant_snapshot_id:binding.grant_snapshot_id,
  lifecycle_epoch:1,grant_epoch:1,runtime_registration_id:binding.registration_id,runtime_binding_id:binding.id,runtime_epoch:1,session_epoch:1,audience:'app_runtime',initiating_actor_type:'human',initiating_actor_id:scope.owner_id,
  session_id:credential.session_id,run_id:randomUUID(),attempt_id:randomUUID(),claim_token:randomUUID(),sequence:1,operation_name:'send_message',lease_expires_at:new Date(Date.now()+120000).toISOString()};queued=currentClaim;return currentClaim.run_id;};
 const status=async()=>{try{return JSON.parse(await readFile(join(state_dir,'status.json'),'utf8'));}catch{return null;}};
 const config2=join(managerRoot,'config2.json'),state2=join(managerRoot,'state2');await mkdir(state2,{mode:0o700});await writeFile(config2,JSON.stringify({...JSON.parse(await readFile(configPath,'utf8')),state_dir:state2}),{mode:0o600});
 const launch=(second=false)=>{const processChild=spawn(process.execPath,['--import',parentPreload,cli,second?config2:configPath],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';processChild.stdout.on('data',x=>{stdout+=x;});processChild.stderr.on('data',x=>{stderr+=x;});
  const done=new Promise((resolve,reject)=>{processChild.once('error',reject);processChild.once('close',code=>resolve({code,stdout,stderr}));});
  const run={processChild,done,stop:async()=>{processChild.kill('SIGTERM');return done;}};running.push(run);return run;};
 t.after(async()=>t.diagnostic(JSON.stringify({status:await status(),calls: calls.map(value=>value.replace(/[0-9a-f-]{36}/gi,'UUID')),fixture_errors:errors.map(error=>error.message),children:children.length,provider_calls:delivered.length,results:results.map(result=>result.status)})));
 return{launch,enqueue,status,status2:async()=>{try{return JSON.parse(await readFile(join(state2,'status.json'),'utf8'));}catch{return null;}},delivered,children,results,calls,errors,pdf,bytes:built.bytes,counts:()=>({started,claims,sessions}),ownerRotations:()=>ownerRotations,managerRoot,workerRoot};
}

test('POSIX supervisor autonomously polls queued Runs and forks the real scoped child; settled restart accepts a fresh Run',{skip:!rootLinux,timeout:60000},async t=>{
 const f=await fixture(t),first=f.launch();await until(f.status,x=>x?.phase==='idle');assert.equal(f.children.length,0);
 const firstRun=f.enqueue();await until(f.status,x=>x?.last_run_id===firstRun);assert.equal(f.children.length,1);assert.equal(f.delivered.length,1);
 assert.equal((await first.stop()).code,0);const restarted=f.launch();await until(f.status,x=>x?.pid===restarted.processChild.pid&&x.phase==='idle');
 assert.equal(f.delivered.length,1,'Settled restart does not resubmit the previous Run');
 const nextRun=f.enqueue();await until(f.status,x=>x?.last_run_id===nextRun);assert.notEqual(nextRun,firstRun);assert.equal(f.children.length,2);assert.equal(f.delivered.length,2);
 assert.equal((await restarted.stop()).code,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.delivered[0],f.bytes);
 const parsed=await simpleParser(f.delivered[0]);assert.equal(parsed.html,'<p>Exact <strong>reviewed</strong> text.</p>');assert.equal(parsed.text.trim(),'Exact reviewed text.');assert.deepEqual(parsed.attachments[0].content,f.pdf);
 assert.equal(f.results.every(x=>x.status==='returned'),true);assert.equal((await f.status()).owner_bearer_in_child,false);
 for(const name of await readdir(join(f.workerRoot,'oauth','records')))assert.equal((await readFile(join(f.workerRoot,'oauth','records',name),'utf8')).includes('synthetic-provider-token'),false);
});
test('POSIX actual supervisor unknown outcome latches on disk and a fresh process cannot claim or resend',{skip:!rootLinux,timeout:60000},async t=>{
 const f=await fixture(t,{loseResponse:true});f.enqueue();const first=f.launch(),ended=await first.done;assert.equal(ended.code,0);
 assert.equal((await f.status()).phase,'paused');assert.equal(f.delivered.length,1);assert.equal(f.children.length,1);
 const before=f.counts(),calls=f.calls.length,restarted=f.launch();assert.equal((await restarted.done).code,0);
 assert.equal((await f.status()).phase,'paused');assert.deepEqual(f.counts(),before);assert.equal(f.calls.length,calls,'Paused restart performs no owner/Runtime/provider I/O');
 assert.equal(f.delivered.length,1);assert.equal(f.children.length,1);assert.equal(f.results.every(x=>x.status==='indeterminate'),true);assert.deepEqual(f.errors,[]);
 for(const text of [ended.stdout,ended.stderr])for(const secret of ['synthetic-owner-refresh','synthetic-provider-token','synthetic-client-secret'])assert.equal(text.includes(secret),false);
});

test('two actual manager processes share atomic owner refresh without replaying the rotated token',{skip:!rootLinux,timeout:60000},async t=>{
 const f=await fixture(t,{expiredOwner:true}),first=f.launch(),second=f.launch(true);
 await Promise.all([until(f.status,x=>x?.phase==='idle'),until(f.status2,x=>x?.phase==='idle')]);assert.equal(f.ownerRotations(),1);assert.deepEqual(f.errors,[]);assert.equal(f.children.length,0);
 assert.equal((await first.stop()).code,0);assert.equal((await second.stop()).code,0);const restart=f.launch();await until(f.status,x=>x?.pid===restart.processChild.pid&&x.phase==='idle');
 assert.equal(f.ownerRotations(),1);assert.equal((await restart.stop()).code,0);assert.deepEqual(f.errors,[]);
});
