import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {simpleParser} from 'mailparser';
import {createAppConnectionAdapter} from './providers/connection-http.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailOAuth} from './providers/oauth-account.mjs';
import {sameOAuthBinding} from './providers/oauth-contract.mjs';
import {createRecipientVerificationProbe,verifyGmailRecipientProbe} from './providers/recipient-verification.mjs';
import {createOutgoingSnapshotService} from './outgoing-snapshot.mjs';
import {createOutgoingSendRuntime} from './outgoing-send-runtime.mjs';

const copy=value=>structuredClone(value),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const reply=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const mailbox=(address,display_name='')=>({address,display_name});
const identityMatches=(left,right)=>Object.entries(left).every(([key,value])=>key==='scope'
 ?JSON.stringify(value)===JSON.stringify(right.scope):value===right[key]);

// Explicit test fixtures: this in-memory lock/CAS store, current member/effect
// ports, snapshot seals and outcome journal prove no deployment durability,
// production host integration or live Google delivery.
function memoryCustodyStore(){
 const rows=new Map(),queues=new Map();
 return {rows,async withLock({key},use){
  const previous=queues.get(key)??Promise.resolve();let release;
  const tail=new Promise(resolve=>{release=resolve;});queues.set(key,tail);await previous;
  try{return await use({async read(){return copy(rows.get(key)??null);},
   async compareAndSwap({expected_revision,value}){const prior=rows.get(key);if((prior?.revision??null)!==expected_revision)return false;
    rows.set(key,{revision:(prior?.revision??0)+1,value:copy(value)});return true;}});
  }finally{release();if(queues.get(key)===tail)queues.delete(key);}
 }};
}

// Derive the simulated Gmail full/metadata representation from the actual raw
// Send bytes. Expected probe bytes are never used to fabricate received content.
async function gmailDelivery(raw,number,now){
 const parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true});
 const headers=parsed.headerLines.map(({key,line})=>({name:key,value:line.slice(line.indexOf(':')+1).replace(/\r?\n[\t ]+/gu,' ').trim()}));
 headers.push({name:'Delivered-To',value:parsed.to.value[0].address});
 const text=Buffer.from(parsed.text??''),parts=[{mimeType:'text/plain',filename:'',
  headers:[{name:'Content-Type',value:'text/plain; charset=utf-8'}],body:{size:text.byteLength,data:text.toString('base64url')}}];
 for(const file of parsed.attachments)parts.push({mimeType:file.contentType,filename:file.filename,
  headers:[{name:'Content-Disposition',value:'attachment'}],body:{size:file.content.byteLength,data:file.content.toString('base64url')}});
 return {raw:Buffer.from(raw),parsed,message:{id:`simulated-received-${number}`,threadId:`simulated-thread-${number}`,labelIds:['INBOX'],
  internalDate:String(now),payload:{mimeType:'multipart/mixed',headers,parts}}};
}

async function milestoneFixture({acceptedResponseLoss=false}={}){
 const now=Date.now(),sender='sender@example.test',from='verified-alias@example.test',recipient='recipient@example.test';
 const pdf=await readFile(new URL('./fixtures/launch-stage0/synthetic-brief.pdf',import.meta.url));
 const scope={org_id:randomUUID(),owner_id:randomUUID(),installation_id:randomUUID()},trustedContext={kind:'memory-current-member'};
 const projection={purpose:'connect',org_id:scope.org_id,owner_user_id:scope.owner_id,web_session_id:randomUUID(),experience_session_id:randomUUID(),
  installation_id:scope.installation_id,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'reviewed-gmail-target',
  resource_key:'inbox',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),descriptor_digest:'reviewed-descriptor',
  action_key:'send_message',action_binding_id:randomUUID(),allowed_operations:['list_summary','read_one','search'],
  lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,expires_at:now+300000,checked_at:now};
 const options={origin:'https://deft.example.test',account_id:'controlled-gmail',provider:'gmail',authority_epoch:7,
  connection_target:projection.target_key,resource_binding_id:projection.resource_binding_id,action_binding_id:projection.action_binding_id,
  capabilities:['read','search','thread','send'],clients:{gmail:{client_id:'synthetic-client',client_secret:'synthetic-client-secret',verify_aliases:true,
   redirect_uri:'https://deft.example.test/apps/connections/callback'}}};
 const binding={scope,account_id:options.account_id,provider:options.provider,connection_target:options.connection_target,
  resource_binding_id:options.resource_binding_id,action_binding_id:options.action_binding_id,authority_epoch:options.authority_epoch,capabilities:options.capabilities};
 const store=memoryCustodyStore(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(6),key_id:'synthetic-encryption-key',store,now:()=>now});
 const calls=[],deliveries=[];
 const googleFetch=async(url,init)=>{
  const parsed=new URL(url),authorization=new Headers(init.headers).get('authorization');calls.push({url:parsed,method:init.method});
  if(url==='https://oauth2.googleapis.com/token'){
   assert.equal(init.body.get('grant_type'),'authorization_code');assert.equal(init.body.get('code'),'synthetic-auth-code');
   assert.equal(init.body.get('client_id'),options.clients.gmail.client_id);
   return reply({access_token:'synthetic-sender-bearer',refresh_token:'synthetic-refresh-secret',token_type:'Bearer',expires_in:3600,
    scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
  }
  if(url==='https://openidconnect.googleapis.com/v1/userinfo')return reply({sub:'synthetic-stable-subject',email:sender,email_verified:true,name:'Connected sender'});
  assert.equal(parsed.origin,'https://gmail.googleapis.com');
  if(parsed.pathname.endsWith('/profile'))return reply({emailAddress:authorization==='Bearer synthetic-recipient-read-token'?recipient:sender});
  if(parsed.pathname.endsWith('/settings/sendAs'))return reply({sendAs:[{sendAsEmail:from,verificationStatus:'accepted',displayName:'Verified alias'}]});
  if(parsed.pathname.endsWith('/messages/send')){
   assert.equal(init.method,'POST');assert.equal(authorization,'Bearer synthetic-sender-bearer');
   const raw=Buffer.from(JSON.parse(init.body).raw,'base64url');deliveries.push(await gmailDelivery(raw,deliveries.length+1,now));
   if(acceptedResponseLoss)throw Error('Simulated Google accepted raw MIME; HTTP response was lost');
   return reply({id:`simulated-sent-${deliveries.length}`});
  }
  assert.equal(init.method,'GET');assert.equal(authorization,'Bearer synthetic-recipient-read-token');
  if(parsed.pathname.endsWith('/messages')){
   assert.ok(parsed.searchParams.get('q').includes('rfc822msgid:'));return reply({messages:deliveries.map(row=>({id:row.message.id,threadId:row.message.threadId}))});
  }
  const id=decodeURIComponent(parsed.pathname.split('/messages/')[1]),delivered=deliveries.find(row=>row.message.id===id);assert.ok(delivered);
  if(parsed.searchParams.get('format')==='metadata')return reply({...copy(delivered.message),payload:{headers:copy(delivered.message.payload.headers)}});
  assert.equal(parsed.searchParams.get('format'),'full');return reply(copy(delivered.message));
 };
 const connectionHost={async resolveContext(context){assert.equal(context,trustedContext);return copy(projection);},
  async assertCurrent(context){assert.equal(context,trustedContext);return copy(projection);}};
 const connection=await createAppConnectionAdapter({host:connectionHost,options,custody,fetch:googleFetch,now:()=>now});
 const begin=await connection.handle(new Request('https://deft-connection.invalid/connections/begin',{
  method:'POST',headers:{'Content-Type':'application/json',Origin:options.origin},body:'{}'}),trustedContext);
 assert.equal(begin.status,200);const pending=await begin.json(),state=new URL(pending.authorization_url).searchParams.get('state');
 const callback=new URL('https://deft-connection.invalid/connections/callback');callback.searchParams.set('state',state);callback.searchParams.set('code','synthetic-auth-code');
 const completed=await connection.handle(new Request(callback,{headers:{Origin:options.origin}}),trustedContext);
 assert.equal(completed.status,200);const connected=await completed.json();assert.equal(connected.state,'connected');
 const account={...connected.account,connection_target:binding.connection_target,resource_binding_id:binding.resource_binding_id,
  action_binding_id:binding.action_binding_id,authority_epoch:binding.authority_epoch};
 assert.ok(account.verified_sender_identities.includes(from));assert.equal(account.primary_address,sender);assert.ok(account.capabilities.includes('send'));
 const encryptedRows=JSON.stringify([...store.rows.values()]);
 for(const secret of ['synthetic-sender-bearer','synthetic-refresh-secret','synthetic-stable-subject',sender,from])assert.equal(encryptedRows.includes(secret),false);
 assert.equal(JSON.stringify(connected).includes('synthetic-sender-bearer'),false);
 const oauth=createEmailOAuth({clients:options.clients,custody,fetch:googleFetch,now:()=>now,host:{
  async resolveAccount(request){assert.equal(request.account_id,binding.account_id);assert.deepEqual(request.scope,scope);await connectionHost.assertCurrent(trustedContext);return copy(binding);},
  async assertAuthority(request){assert.ok(sameOAuthBinding(request.binding,binding));await connectionHost.assertCurrent(trustedContext);return {allowed:true,expires_at:projection.expires_at};},
 }});
 const probe=createRecipientVerificationProbe({recipient,expected_sender:from,body_text:'Component milestone — controlled plain body.',
  attachments:[{filename:'synthetic-brief.pdf',media_type:'application/pdf',bytes:pdf}]});
 const draftId=randomUUID(),seals=new Map(),operations=new Map(),signature=(id,digest)=>createHmac('sha256','synthetic-memory-host-seal').update(`${id}:${digest}`).digest('hex');
 const context={scope,account_id:account.account_id,authority_epoch:account.authority_epoch,provider:'gmail',
  verified_from:account.verified_sender_identities.map(address=>mailbox(address)),captured_at:new Date(now).toISOString(),message_id:probe.message_id,
  limits:{max_recipients:20,max_body_bytes:65536,max_files:4,max_file_bytes:1048576,max_total_file_bytes:2097152,max_mime_bytes:4194304,allowed_media_types:['application/pdf']},
  draft:{account_id:account.account_id,draft_id:draftId,revision:3,mode:'compose',from:mailbox(from),to:[mailbox(recipient)],cc:[],bcc:[],
   subject:probe.subject,body_format:'plain',body_bytes:Buffer.from(probe.body_text),reply_parent:null,
   files:[{file_id:randomUUID(),account_id:account.account_id,org_id:scope.org_id,owner_id:scope.owner_id,parent:{kind:'draft',id:draftId},
    availability:'ready',filename:'synthetic-brief.pdf',media_type:'application/pdf',byte_count:pdf.byteLength,digest:hash(pdf),bytes:Buffer.from(pdf),expires_at:new Date(now+300000).toISOString()}]}};
 const snapshots=createOutgoingSnapshotService({resolve:async()=>copy(context),
  seal:async retained=>{const snapshot_id=randomUUID();seals.set(snapshot_id,retained);return {snapshot_id,sealed_contract:signature(snapshot_id,retained.payload_digest)};},
  verify:async candidate=>{const retained=seals.get(candidate.snapshot_id);return candidate.sealed_contract===signature(candidate.snapshot_id,retained?.payload_digest)
   &&candidate.payload_digest===retained?.payload_digest&&candidate.payload.draft_revision===context.draft.revision;},
  reserve:async identity=>{const row=operations.get(identity.operation_id);if(row)return identityMatches(row.base,identity)?'replay':'unknown';
   operations.set(identity.operation_id,{base:copy(identity),state:'reserved'});return 'reserved';},
 });
 const snapshot=await snapshots.prepare({account_id:account.account_id,draft_id:draftId,expected_revision:3});
 const effect={run_id:randomUUID(),attempt_id:randomUUID(),operation_name:'send_message',scope,account,
  draft_ref:{draft_state_key:'drafts',draft_id:draftId,expected_revision:3},snapshot_ref:{snapshot_id:snapshot.snapshot_id,digest:snapshot.payload_digest},expires_at:new Date(now+60000).toISOString()};
 const effectHost={
  async resolveEffect(request){assert.equal(request.run_id,effect.run_id);assert.equal(request.attempt_id,effect.attempt_id);return copy(effect);},
  async assertEffect(){await connectionHost.assertCurrent(trustedContext);return true;},async loadSnapshot(){return snapshot;},
  async reserveTransport(identity){const row=operations.get(identity.operation_id);if(!row||row.state!=='reserved'||!identityMatches(row.base,identity))return false;
   row.identity=copy(identity);row.state='provider_started';return true;},
  async recordOutcome({identity,state,output}){const row=operations.get(identity.operation_id);if(!row||!identityMatches(row.base,identity))return false;
   if(row.state==='accepted')return state==='accepted';row.identity=copy(identity);row.state=state;if(output)row.output=copy(output);return true;},
  async readOutcome(identity){const row=operations.get(identity.operation_id);return row?.state==='accepted'?{identity:copy(row.identity),state:'accepted',output:copy(row.output)}:{identity:copy(identity),state:row?.state??'unknown'};},
 };
 const runtime=()=>createOutgoingSendRuntime({host:effectHost,snapshots,custody:{getAccessToken:request=>oauth.getAccessToken(request)},fetch:googleFetch,now:()=>now});
 const verify=()=>verifyGmailRecipientProbe({probe,provider_options:{account:{account_id:'controlled-recipient',provider:'gmail',display_label:'Simulated controlled recipient',
  primary_address:recipient,verified_sender_identities:[recipient],capabilities:['read','search'],connection_target:'reviewed-recipient',resource_binding_id:randomUUID(),
  action_binding_id:null,authority_epoch:1,health:'connected'},fetch:googleFetch,assertAuthority:async()=>true,getAccessToken:async()=> 'synthetic-recipient-read-token'}});
 return {runtime,nomination:{run_id:effect.run_id,attempt_id:effect.attempt_id},verify,probe,pdf,snapshot,deliveries,calls,operations,effect};
}

test('simulated milestone joins encrypted Gmail connection, authorized snapshot Send and exact recipient receipt',async()=>{
 const f=await milestoneFixture(),result=await f.runtime().execute(f.nomination);assert.equal(result.status,'returned');assert.equal(result.provider_succeeded,true);
 assert.equal(f.deliveries.length,1);assert.deepEqual(f.deliveries[0].raw,f.snapshot.mime_bytes);assert.deepEqual(f.deliveries[0].parsed.attachments[0].content,f.pdf);
 const receipt=await f.verify();assert.equal(receipt.status,'receipt_observed');assert.equal(receipt.exact_receipts.length,1);assert.deepEqual(receipt.mismatches,[]);
 assert.equal(receipt.exact_receipts[0].body_sha256,f.probe.body_sha256);assert.deepEqual(receipt.exact_receipts[0].attachments,f.probe.attachments);
 assert.equal(receipt.message_id,f.probe.message_id);assert.equal(result.output.operation_id,`mail-${f.effect.run_id}`);
 assert.deepEqual(await f.runtime().execute(f.nomination),result);assert.equal(f.deliveries.length,1);
 assert.equal(f.calls.filter(call=>call.url.pathname.endsWith('/messages/send')).length,1);
});

test('simulated accepted-response loss leaves one exact recipient receipt and reconciliation cannot resend',async()=>{
 const f=await milestoneFixture({acceptedResponseLoss:true});assert.deepEqual(await f.runtime().execute(f.nomination),{status:'indeterminate'});
 assert.equal(f.operations.get(`mail-${f.effect.run_id}`).state,'unknown');
 const observed=await f.verify();assert.equal(observed.status,'receipt_observed');assert.equal(observed.exact_receipts.length,1);
 assert.deepEqual(observed.exact_receipts[0].attachments,f.probe.attachments);
 assert.deepEqual(await f.runtime().execute(f.nomination),{status:'indeterminate'});
 const reconciled=await f.verify();assert.equal(reconciled.status,'receipt_observed');assert.equal(reconciled.exact_receipts.length,1);
 assert.equal(f.deliveries.length,1);assert.equal(f.calls.filter(call=>call.url.pathname.endsWith('/messages/send')).length,1);
 assert.deepEqual(f.deliveries[0].raw,f.snapshot.mime_bytes);
});
