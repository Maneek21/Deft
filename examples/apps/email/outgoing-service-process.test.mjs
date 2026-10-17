import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,readdir,readFile,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {simpleParser} from 'mailparser';
import {createAppConnectionAdapter} from './providers/connection-http.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const posix=process.platform!=='win32'&&typeof process.getuid==='function';
const cli=join(dirname(fileURLToPath(import.meta.url)),'outgoing-service.mjs');
const version='deft.app_runtime_channel.v1';

// Only the child test process rewrites the known provider endpoints. The actual
// SDK still uses its unmodified HTTP transport; every other URL is refused.
const preload=`const original=globalThis.fetch;
const allowed=new Set(['https://oauth2.googleapis.com/token','https://openidconnect.googleapis.com/v1/userinfo',
 'https://gmail.googleapis.com/gmail/v1/users/me/profile','https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
globalThis.fetch=async(url,init)=>{const text=String(url),base=process.env.EMAIL_PROCESS_TEST_ORIGIN;
 if(text.startsWith(base+'/channel/'))return original(url,init);
 if(!allowed.has(text))throw Error('Unexpected test endpoint');
 const response=await original(base+'/provider?url='+encodeURIComponent(text),init);
 if(response.status===599)throw Error('Controlled acknowledgement loss');return response;};`;

async function fixture(t,{loseResponse=false}={}){
 const root=await mkdtemp('/var/tmp/deft-email-process-');await chmod(root,0o700);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const now=Date.now(),scope={org_id:randomUUID(),owner_id:randomUUID(),installation_id:randomUUID()},accountId='gmail-controlled';
 const binding={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  resource_target_key:'personal',state_key:'drafts',draft_id:randomUUID(),draft_revision:2,artifact_digest:'sha256:'+'a'.repeat(64),declaration_digest:'sha256:'+'b'.repeat(64),
  runtime_binding_id:randomUUID(),action_key:'send_message',action_contract_digest:'sha256:'+'c'.repeat(64),input_digest:'sha256:'+'d'.repeat(64)};
 const resourceId=randomUUID(),clients={gmail:{client_id:'synthetic-client',client_secret:'synthetic-private-secret',redirect_uri:'https://deft.example.test/apps/connections/callback'}};
 const accountBinding={scope,account_id:accountId,provider:'gmail',connection_target:'personal',resource_binding_id:resourceId,
  action_binding_id:binding.runtime_binding_id,authority_epoch:1,capabilities:['read','send']};
 const custodyRoot=join(root,'oauth'),journalRoot=join(root,'journal'),key=Buffer.alloc(32,3),journalKey=Buffer.alloc(32,8);
 const custody=createEncryptedEmailCustody({encryption_key:key,key_id:'process-oauth',store:await createEmailFileCustodyStore({root:custodyRoot})});
 const delivered=[],calls=[],results=[],errors=[];let starts=0,claims=0;
 const provider=async(url,init)=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-token',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:3600,
   scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
  if(url==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'synthetic-subject',email:'verified@example.test',email_verified:true,name:'Verified'});
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/profile')return Response.json({emailAddress:'verified@example.test'});
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){
   assert.equal(init.headers.authorization,'Bearer synthetic-token');
   delivered.push(Buffer.from(JSON.parse(init.body).raw,'base64url'));
   return loseResponse?new Response('controlled loss',{status:599}):Response.json({id:'accepted-provider-id',threadId:'provider-thread',labelIds:['SENT']});
  }
  assert.fail('Unexpected provider endpoint');
 };
 const projection={purpose:'connect',org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,
  app_version_id:binding.app_version_id,grant_snapshot_id:binding.grant_snapshot_id,target_key:'personal',resource_key:'inbox',resource_binding_id:resourceId,
  action_key:'send_message',action_binding_id:binding.runtime_binding_id,web_session_id:randomUUID(),experience_session_id:randomUUID(),runtime_registration_id:randomUUID(),
  descriptor_digest:'sha256:'+'e'.repeat(64),allowed_operations:['list_summary','read_one'],lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,expires_at:now+300000,checked_at:now};
 const adapter=await createAppConnectionAdapter({host:{resolveContext:async()=>structuredClone(projection),assertCurrent:async()=>structuredClone(projection)},custody,fetch:provider,
  options:{origin:'https://deft.example.test',account_id:accountId,provider:'gmail',authority_epoch:1,connection_target:'personal',resource_binding_id:resourceId,
   action_binding_id:binding.runtime_binding_id,capabilities:['read','send'],clients}});
 const begin=await adapter.handle(new Request('https://deft-connection.invalid/connections/begin',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{});
 const auth=new URL((await begin.json()).authorization_url),callback=new URL('https://deft-connection.invalid/connections/callback');
 callback.searchParams.set('state',auth.searchParams.get('state'));callback.searchParams.set('code','synthetic-code');
 assert.equal((await adapter.handle(new Request(callback),{})).status,200);
 const pdf=Buffer.from('%PDF-1.4\ncontrolled immutable attachment\n%%EOF'),file={file_id:randomUUID(),upload_operation_id:randomUUID(),filename:'brief.pdf',
  media_type:'application/pdf',byte_length:pdf.length,digest:hash(pdf),expires_at:new Date(now+300000).toISOString()};
 const input={to:'controlled@example.test',subject:'Trusted delivery',body:'Exact controlled body.'};
 const built=await adapter.buildActionPayload({binding,input,draft_value:{...input,mode:'compose'},draft_updated_at:new Date(now).toISOString(),
  files:[{reference:file,bytes:pdf}],files_policy:{max_file_bytes:2097152,max_files_per_record:1,max_total_bytes_per_record:2097152,allowed_media_types:['application/pdf']},
  max_payload_bytes:4194304,expires_at:file.expires_at},{});
 const ref={snapshot_id:randomUUID(),digest:hash(built.bytes)},claim={schema_version:version,run_id:randomUUID(),attempt_id:randomUUID(),operation_name:'send_message',
  claim_token:'synthetic-claim-token',sequence:7,lease_expires_at:new Date(now+120000).toISOString()};
 const retained={ref,binding,metadata:built.metadata,file_refs:[file],expires_at:file.expires_at,byte_count:built.bytes.length,bytes_digest:hash(built.bytes)};
 const credential={session_id:randomUUID(),session_token:'s'.repeat(48)};
 const server=createServer(async(req,res)=>{try{
  let body='';for await(const chunk of req)body+=chunk;
  const url=new URL(req.url,'http://localhost');calls.push(url.pathname);
  let response;
  if(url.pathname==='/provider')response=await provider(url.searchParams.get('url'),{body,headers:req.headers});
  else{
   assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'AppRuntime '+credential.session_token);
   assert.equal(req.headers['content-type'],'application/json');const value=JSON.parse(body);
   assert.equal(value.schema_version,version);assert.equal(value.session_id,credential.session_id);
   if(url.pathname==='/channel/claim'){claims++;assert.equal(value.max_claims,1);response=Response.json({claim});}
   else{
    for(const field of ['run_id','attempt_id','claim_token','sequence'])assert.equal(value[field],claim[field]);
    if(url.pathname==='/channel/start'){starts++;assert.equal(value.action_payload_version,'deft.app_action_payload.v1');
     response=Response.json({started:{schema_version:version,run_id:claim.run_id,attempt_id:claim.attempt_id,input,snapshot_ref:ref,lease_expires_at:claim.lease_expires_at}});}
    else if(url.pathname==='/channel/result'){results.push(value);response=Response.json({run:{id:claim.run_id,state:value.status==='returned'?'succeeded':'unknown_outcome'}});}
    else if(url.pathname==='/channel/payload'){
     assert.deepEqual(value.snapshot_ref,ref);
     if(value.part.kind==='metadata')response=Response.json({payload:retained});
     else{const bytes=value.part.kind==='bytes'?built.bytes:pdf;
      if(value.part.kind!=='bytes'){assert.equal(value.part.kind,'file');assert.equal(value.part.file_id,file.file_id);}
      response=new Response(bytes,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),
       'x-deft-snapshot-id':ref.snapshot_id,'x-deft-snapshot-digest':ref.digest,'x-deft-payload-digest':hash(bytes)}});}
    }else assert.fail('Unexpected channel operation');
   }
  }
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){errors.push(error);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:'CONTROLLED_TEST_FAILED'}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port,preloadPath=join(root,'provider-test-preload.mjs');await writeFile(preloadPath,preload,{mode:0o600});
 const config={schema_version:'deft.email_outgoing_service.v1',channel_url:origin+'/channel',credential,account_binding:accountBinding,clients,custody_root:custodyRoot,
  encryption_key_hex:key.toString('hex'),key_id:'process-oauth',journal_root:journalRoot,journal_encryption_key_hex:journalKey.toString('hex'),journal_key_id:'process-send',expected_run_id:claim.run_id};
 const configPath=join(root,'private-config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});key.fill(0);journalKey.fill(0);
 const run=async(path=configPath)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import',preloadPath,cli,'send',path],{env:{...process.env,EMAIL_PROCESS_TEST_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},20000);
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',reject);
  child.once('close',code=>{clearTimeout(timer);try{assert.equal(timedOut,false,'Child deadline exceeded');assert.deepEqual(errors,[]);
   resolve({code,stdout,stderr,value:JSON.parse((stdout||stderr).trim().split('\n').at(-1))});}catch(error){reject(error);}});
 });
 return {root,config,configPath,run,delivered,results,calls,pdf,bytes:built.bytes,counts:()=>({starts,claims}),journalRoot,custodyRoot};
}

test('POSIX CLI child uses exact SDK transport and encrypted durable custody; restart never resends',{skip:!posix},async t=>{
 const f=await fixture(t);
 for(let i=0;i<2;i++){const reply=await f.run();assert.equal(reply.code,0);assert.equal(reply.value.state,'provider_accepted');assert.equal(reply.value.automatic_retry,false);assert.equal(reply.stderr.includes('EMAIL_SEND_RUNTIME_UNAVAILABLE'),false);}
 assert.equal(f.delivered.length,1);assert.deepEqual(f.delivered[0],f.bytes);
 const parsed=await simpleParser(f.delivered[0]);assert.equal(parsed.from.value[0].address,'verified@example.test');
 assert.equal(parsed.to.value[0].address,'controlled@example.test');assert.equal(parsed.subject,'Trusted delivery');
 assert.equal(parsed.text.trim(),'Exact controlled body.');assert.deepEqual(parsed.attachments[0].content,f.pdf);
 assert.equal(f.results.every(result=>result.status==='returned'),true);assert.equal(f.counts().starts,2);
 for(const directory of [f.custodyRoot,f.journalRoot])for(const name of await readdir(join(directory,'records'))){
  const text=await readFile(join(directory,'records',name),'utf8');assert.equal(text.includes('synthetic-token'),false);
  assert.equal(text.includes('synthetic-refresh'),false);assert.equal(text.includes('provider_accepted'),false);
 }
});

test('POSIX CLI uncertain provider acknowledgement survives a fresh process without resend',{skip:!posix},async t=>{
 const f=await fixture(t,{loseResponse:true});
 for(let i=0;i<2;i++){const reply=await f.run();assert.equal(reply.code,0);assert.equal(reply.value.state,'outcome_unknown');assert.equal(reply.value.automatic_retry,false);}
 assert.equal(f.delivered.length,1);assert.equal(f.results.every(result=>result.status==='indeterminate'),true);
});

test('POSIX CLI refuses wrong Run before Start and denies malformed or insecure configuration before claim',{skip:!posix},async t=>{
 const f=await fixture(t),wrong=join(f.root,'wrong-run.json');await writeFile(wrong,JSON.stringify({...f.config,expected_run_id:randomUUID()}),{mode:0o600});
 const denied=reply=>{assert.equal(reply.code,1);assert.deepEqual(reply.value,{state:'stopped',code:'EMAIL_SEND_RUNTIME_UNAVAILABLE',automatic_retry:false});assert.equal(reply.stdout,'');};
 denied(await f.run(wrong));assert.deepEqual(f.counts(),{starts:0,claims:1});assert.equal(f.delivered.length,0);
 const cases=[['malformed.json','{'],['unknown-field.json',JSON.stringify({...f.config,extra:'refused'})],
  ['missing-run.json',JSON.stringify({...f.config,expected_run_id:undefined})],['insecure.json',JSON.stringify(f.config)]];
 for(const [name,body] of cases){const path=join(f.root,name);await writeFile(path,body,{mode:name==='insecure.json'?0o644:0o600});denied(await f.run(path));}
 const link=join(f.root,'config-link.json');await symlink(f.configPath,link);denied(await f.run(link));
 assert.deepEqual(f.counts(),{starts:0,claims:1});assert.equal(f.delivered.length,0);assert.equal(f.calls.some(path=>path==='/channel/payload'),false);
});
