import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {createOutgoingSnapshotService} from './outgoing-snapshot.mjs';
import {createOutgoingSendRuntime} from './outgoing-send-runtime.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const mailbox=(address,display_name='')=>({address,display_name});
const copy=value=>structuredClone(value);
const code=expected=>error=>error.code===expected;
const defer=()=>{let resolve;const promise=new Promise(accept=>{resolve=accept;});return {promise,resolve};};
const policy={max_recipients:20,max_body_bytes:65536,max_files:4,max_file_bytes:1048576,
 max_total_file_bytes:2097152,max_mime_bytes:4194304,allowed_media_types:['application/pdf']};
const baseIdentityMatches=(left,right)=>Object.entries(left).every(([key,value])=>key==='scope'
 ?JSON.stringify(value)===JSON.stringify(right.scope):value===right[key]);

async function fixture({responseLoss=false,outcomeAckLoss=false}={}){
 const pdf=await readFile(new URL('./fixtures/launch-stage0/synthetic-brief.pdf',import.meta.url));
 const scope={org_id:randomUUID(),owner_id:randomUUID(),installation_id:randomUUID()},draftId=randomUUID();
 const account={account_id:'gmail-work',provider:'gmail',display_label:'Work',primary_address:'work@example.test',
  verified_sender_identities:['work@example.test','work-alias@example.test'],capabilities:['read','search','thread','send'],
  connection_target:'reviewed-work',resource_binding_id:randomUUID(),action_binding_id:randomUUID(),authority_epoch:7,health:'connected'};
 let time=Date.now(),allowed=true,resolveCount=0,transportCount=0,tokenCount=0;const sealed=new Map(),operations=new Map(),requests=[];
 const context={scope,account_id:account.account_id,authority_epoch:account.authority_epoch,provider:account.provider,
  verified_from:[mailbox('work-alias@example.test','Reviewed sender')],captured_at:new Date(time).toISOString(),
  message_id:`<snapshot-${draftId}@example.test>`,limits:copy(policy),draft:{account_id:account.account_id,draft_id:draftId,revision:3,mode:'compose',
   from:mailbox('work-alias@example.test','Reviewed sender'),to:[mailbox('to@example.test','Recipient')],
   cc:[mailbox('cc@example.test'),mailbox('to@example.test')],bcc:[mailbox('blind@example.test')],subject:'Exact attachment Send',
   body_format:'plain',body_bytes:Buffer.from('Reviewed plain body — exact.\nPDF attached.\n'),reply_parent:null,
   files:[{file_id:randomUUID(),account_id:account.account_id,org_id:scope.org_id,owner_id:scope.owner_id,parent:{kind:'draft',id:draftId},
    availability:'ready',filename:'synthetic-brief.pdf',media_type:'application/pdf',byte_count:pdf.byteLength,digest:hash(pdf),bytes:Buffer.from(pdf),
    expires_at:new Date(time+300000).toISOString()}]}};
 const snapshots=createOutgoingSnapshotService({
  resolve:async()=>copy(context),
  seal:async value=>{const snapshot_id=randomUUID();sealed.set(snapshot_id,value);return {snapshot_id,sealed_contract:'synthetic-host-seal'};},
  verify:async value=>{const retained=sealed.get(value.snapshot_id);return allowed&&retained?.payload_digest===value.payload_digest
   &&value.sealed_contract==='synthetic-host-seal'&&context.draft.revision===value.payload.draft_revision;},
  reserve:async identity=>{
   if(!allowed)return 'unknown';const prior=operations.get(identity.operation_id);
   if(prior)return baseIdentityMatches(prior.base,identity)?'replay':'unknown';
   operations.set(identity.operation_id,{base:copy(identity),state:'reserved'});return 'reserved';
  },
 });
 const snapshot=await snapshots.prepare({account_id:account.account_id,draft_id:draftId,expected_revision:3});
 const effect={run_id:randomUUID(),attempt_id:randomUUID(),operation_name:'send_message',scope,account,
  draft_ref:{draft_state_key:'drafts',draft_id:draftId,expected_revision:3},snapshot_ref:{snapshot_id:snapshot.snapshot_id,digest:snapshot.payload_digest},
  expires_at:new Date(time+60000).toISOString()};
 const host={
  async resolveEffect(){resolveCount++;return copy(effect);},
  async assertEffect(){return allowed;},
  async loadSnapshot(){return snapshot;},
  async reserveTransport(identity){
   const row=operations.get(identity.operation_id);if(!allowed||!row||row.state!=='reserved'||!baseIdentityMatches(row.base,identity))return false;
   row.identity=copy(identity);row.state='provider_started';transportCount++;return true;
  },
  async recordOutcome({identity,state,output,provider_receipt}){
   const row=operations.get(identity.operation_id);if(!row||!baseIdentityMatches(row.base,identity)||row.identity&&!baseIdentityMatches(row.identity,identity))return false;
   if(row.state==='accepted')return state==='accepted';
   row.identity=copy(identity);row.state=state;if(output)row.output=copy(output);if(provider_receipt)row.provider_receipt=copy(provider_receipt);
   if(outcomeAckLoss&&state==='accepted')throw Error('synthetic host result acknowledgement lost');return true;
  },
  async readOutcome(identity){const row=operations.get(identity.operation_id);return row?.state==='accepted'
   ?{identity:copy(row.identity),state:row.state,output:copy(row.output),...(row.provider_receipt?{provider_receipt:copy(row.provider_receipt)}:{})}:{identity:copy(identity),state:row?.state??'unknown'};},
 };
 const custody={async getAccessToken(request){tokenCount++;assert.equal(request.account.account_id,account.account_id);
  assert.equal(request.account.action_binding_id,account.action_binding_id);return 'synthetic-private-token';}};
 const providerFetch=async(url,init)=>{
  requests.push({url,init});if(responseLoss)throw Error('synthetic provider accepted then lost response with secret bytes');
  return new Response(JSON.stringify({id:'synthetic-gmail-accepted'}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const runtime=()=>createOutgoingSendRuntime({host,snapshots,custody,fetch:providerFetch,now:()=>time});
 const nomination=()=>({run_id:effect.run_id,attempt_id:effect.attempt_id});
 return {pdf,scope,account,context,snapshot,effect,host,custody,snapshots,requests,operations,runtime,nomination,
  revoke:()=>{allowed=false;},advance:ms=>{time+=ms;},counts:()=>({resolveCount,transportCount,tokenCount})};
}

test('trusted effect sends exact immutable From/To/Cc/Bcc/plain body/PDF through Gmail raw once',async()=>{
 const f=await fixture(),result=await f.runtime().execute(f.nomination());
 assert.deepEqual(result,{status:'returned',provider_succeeded:true,output:{operation_id:`mail-${f.effect.run_id}`,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'}});
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
 assert.equal(f.requests[0].init.headers.Authorization,'Bearer synthetic-private-token');assert.equal(f.requests[0].init.redirect,'error');
 const raw=Buffer.from(JSON.parse(f.requests[0].init.body).raw,'base64url');assert.deepEqual(raw,f.snapshot.mime_bytes);
 const parsed=await simpleParser(raw),addresses=value=>value.value.map(row=>row.address);
 assert.deepEqual(addresses(parsed.from),['work-alias@example.test']);assert.deepEqual(addresses(parsed.to),['to@example.test']);
 assert.deepEqual(addresses(parsed.cc),['cc@example.test']);assert.deepEqual(addresses(parsed.bcc),['blind@example.test']);
 assert.equal(parsed.subject,f.context.draft.subject);assert.equal(parsed.text.replace(/\r\n/gu,'\n'),f.context.draft.body_bytes.toString('utf8'));
 assert.equal(parsed.html,false);assert.equal(parsed.attachments.length,1);assert.equal(parsed.attachments[0].filename,'synthetic-brief.pdf');
 assert.equal(parsed.attachments[0].contentType,'application/pdf');assert.deepEqual(parsed.attachments[0].content,f.pdf);
 const row=f.operations.get(result.output.operation_id);assert.equal(row.identity.run_id,f.effect.run_id);
 assert.equal(row.identity.mime_digest,hash(raw));assert.equal(row.identity.snapshot_digest,f.snapshot.payload_digest);
 assert.equal(row.identity.resource_binding_id,f.account.resource_binding_id);assert.equal(row.identity.action_binding_id,f.account.action_binding_id);
 assert.equal(JSON.stringify(result).includes('synthetic-private-token'),false);
 const replay=await f.runtime().execute(f.nomination());assert.deepEqual(replay,result);assert.equal(f.requests.length,1);assert.equal(f.counts().transportCount,1);
});

test('Gmail acceptance followed by response loss is indeterminate and never automatically resends',async()=>{
 const f=await fixture({responseLoss:true}),first=await f.runtime().execute(f.nomination());
 assert.deepEqual(first,{status:'indeterminate'});assert.equal(f.requests.length,1);
 const operationId=`mail-${f.effect.run_id}`;assert.equal(f.operations.get(operationId).state,'unknown');
 assert.deepEqual(await f.runtime().execute(f.nomination()),{status:'indeterminate'});
 assert.equal(f.requests.length,1);assert.equal(f.counts().transportCount,1);
 assert.equal(f.operations.get(operationId).identity.operation_id,operationId);
});

test('lost accepted-outcome acknowledgement reconciles metadata for the same effect without another HTTP send',async()=>{
 const f=await fixture({outcomeAckLoss:true});assert.deepEqual(await f.runtime().execute(f.nomination()),{status:'indeterminate'});
 const recovered=await f.runtime().execute(f.nomination());assert.equal(recovered.status,'returned');
 assert.equal(recovered.output.operation_id,`mail-${f.effect.run_id}`);assert.equal(f.requests.length,1);
});

test('caller nominations cannot assert account/snapshot/bytes or replace host effect identity',async()=>{
 const f=await fixture(),runtime=f.runtime();
 for(const extra of [{account:f.account},{snapshot_ref:f.effect.snapshot_ref},{mime_bytes:f.snapshot.mime_bytes},{expires_at:'2099-01-01T00:00:00.000Z'}])
  await assert.rejects(runtime.execute({...f.nomination(),...extra}),code('OUTGOING_RUNTIME_INPUT_INVALID'));
 await assert.rejects(runtime.execute({...f.nomination(),run_id:randomUUID()}),code('OUTGOING_RUNTIME_EFFECT_DENIED'));
 assert.equal(f.requests.length,0);assert.equal(f.operations.size,0);
});

test('cross-owner/account/epoch/draft/reviewed snapshot substitutions fail before reservation or credentials',async()=>{
 for(const edit of [effect=>{effect.scope.owner_id=randomUUID();},effect=>{effect.account.account_id='gmail-other';},
  effect=>{effect.account.authority_epoch++;},effect=>{effect.draft_ref.expected_revision++;},
  effect=>{effect.snapshot_ref.digest='0'.repeat(64);},effect=>{effect.snapshot_ref.snapshot_id=randomUUID();}]){
  const f=await fixture();edit(f.effect);await assert.rejects(f.runtime().execute(f.nomination()),code('OUTGOING_RUNTIME_SNAPSHOT_DENIED'));
  assert.equal(f.requests.length,0);assert.equal(f.operations.size,0);assert.equal(f.counts().tokenCount,0);
 }
});

test('expired finalized file and current effect withdrawal stop dispatch',async()=>{
 const expired=await fixture();expired.effect.expires_at=new Date(Date.now()+600000).toISOString();expired.advance(300001);
 await assert.rejects(expired.runtime().execute(expired.nomination()),code('OUTGOING_RUNTIME_EFFECT_DENIED'));assert.equal(expired.operations.size,0);
 const withdrawn=await fixture();withdrawn.revoke();await assert.rejects(withdrawn.runtime().execute(withdrawn.nomination()),code('OUTGOING_RUNTIME_EFFECT_DENIED'));
 assert.equal(withdrawn.requests.length,0);assert.equal(withdrawn.operations.size,0);
});

test('withdrawal during held token custody prevents provider HTTP and preserves uncertainty fence',async()=>{
 const f=await fixture(),entered=defer(),release=defer();f.custody.getAccessToken=async()=>{entered.resolve();await release.promise;return 'synthetic-private-token';};
 const pending=f.runtime().execute(f.nomination());await entered.promise;f.revoke();release.resolve();
 assert.deepEqual(await pending,{status:'indeterminate'});assert.equal(f.requests.length,0);assert.equal(f.operations.get(`mail-${f.effect.run_id}`).state,'unknown');
});

test('a prior unsettled reservation and forged reconciliation metadata cannot authorize resend',async()=>{
 const f=await fixture(),operationId=`mail-${f.effect.run_id}`;
 await f.snapshots.bind(f.snapshot,{operation_id:operationId,expected_digest:f.snapshot.payload_digest});
 assert.deepEqual(await f.runtime().execute(f.nomination()),{status:'indeterminate'});assert.equal(f.requests.length,0);
 f.host.readOutcome=async identity=>({identity:{...identity,action_binding_id:randomUUID()},state:'accepted',output:{operation_id:operationId,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'}});
 assert.deepEqual(await f.runtime().execute(f.nomination()),{status:'indeterminate'});assert.equal(f.requests.length,0);
});

test('accepted provider locator stays private while public results and replay remain unchanged',async()=>{
 const f=await fixture();let captured;const record=f.host.recordOutcome;
 f.host.recordOutcome=async value=>{captured=copy(value);return record(value);};
 const first=await f.runtime().execute(f.nomination());
 assert.deepEqual(captured.provider_receipt,{provider:'gmail',provider_message_id:'synthetic-gmail-accepted'});
 assert.equal(JSON.stringify(first).includes('synthetic-gmail-accepted'),false);
 const replay=await f.runtime().execute(f.nomination());assert.deepEqual(replay,first);assert.equal(f.requests.length,1);
});

test('legacy accepted replay remains readable without a private receipt',async()=>{
 const f=await fixture();const first=await f.runtime().execute(f.nomination());
 for(const row of f.operations.values())delete row.provider_receipt;
 assert.deepEqual(await f.runtime().execute(f.nomination()),first);assert.equal(f.requests.length,1);
});

test('invalid private replay receipt fails closed without another provider request',async()=>{
 const f=await fixture();await f.runtime().execute(f.nomination());
 for(const row of f.operations.values())row.provider_receipt={provider:'gmail',provider_message_id:'bad\nlocator'};
 assert.deepEqual(await f.runtime().execute(f.nomination()),{status:'indeterminate'});assert.equal(f.requests.length,1);
});
