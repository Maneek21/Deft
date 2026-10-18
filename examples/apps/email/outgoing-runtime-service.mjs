import {createHash} from 'node:crypto';
import {createOutgoingSnapshotService} from './outgoing-snapshot.mjs';
import {createOutgoingSendRuntime} from './outgoing-send-runtime.mjs';
import {createEmailOAuth} from './providers/oauth-account.mjs';
import {validateOAuthBinding,sameOAuthBinding} from './providers/oauth-contract.mjs';
import {sameEmailScope,validateEmailAccount} from './account-registry.mjs';

const fail=()=>{throw Error('EMAIL_SEND_RUNTIME_UNAVAILABLE');};
const json=value=>JSON.stringify(value);
const hash=value=>createHash('sha256').update(value).digest('hex');

/** One operator-scoped Runtime claim. Only authenticated retained payload reads
 * supply MIME; the worker never rebuilds from scalar input or asks Gmail twice. */
export async function runEmailOutgoing({sdk,account_binding:rawBinding,custody,journal,clients,
 fetch:fetchImpl=globalThis.fetch,now=Date.now,expected_run_id=null}){
 const binding=validateOAuthBinding(rawBinding);
 if(!binding.capabilities.includes('send')||['claim','start','payloadMetadata','payloadBytes','fileBytes','result'].some(key=>typeof sdk?.[key]!=='function')
  ||['reserve','reserveTransport','recordOutcome','readOutcome'].some(key=>typeof journal?.[key]!=='function'))fail();
 const claim=await sdk.claim();if(!claim)return {state:'idle'};
 if(claim.operation_name!=='send_message'||expected_run_id&&claim.run_id!==expected_run_id)fail();
 let started;
 try{started=await sdk.start(claim);}catch{
  return {state:'stopped',code:'EMAIL_SEND_START_UNCONFIRMED',run_id:claim.run_id,automatic_retry:false};
 }
 const ref=started?.snapshot_ref;
 if(!ref||started.run_id!==claim.run_id||started.attempt_id!==claim.attempt_id)
  return {state:'stopped',code:'EMAIL_SEND_START_UNCONFIRMED',run_id:claim.run_id,automatic_retry:false};
 let bytes,bodyBytes,htmlBytes,fileBytes=[];
 try{
  const retained=await sdk.payloadMetadata(claim,ref),metadata=retained.metadata,account=validateEmailAccount(metadata.account);
  if(metadata.schema_version!=='deft.email_action_payload.v1'||json(retained.ref)!==json(ref)
   ||retained.binding.action_key!=='send_message'||retained.binding.org_id!==binding.scope.org_id
   ||retained.binding.owner_user_id!==binding.scope.owner_id||retained.binding.installation_id!==binding.scope.installation_id
   ||retained.binding.resource_target_key!==binding.connection_target||retained.binding.runtime_binding_id!==binding.action_binding_id
   ||['account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch'].some(key=>account[key]!==binding[key])
   ||!account.capabilities.includes('send')||account.capabilities.some(capability=>!binding.capabilities.includes(capability))
   ||typeof metadata.body_text!=='string'||metadata.body_text.length>16384)fail();
  const deadline=Math.min(Date.parse(retained.expires_at),Date.parse(started.lease_expires_at));
  const check=async()=>{if(!Number.isFinite(deadline)||now()>=deadline)fail();const current=await sdk.payloadMetadata(claim,ref);
   if(now()>=deadline||json(current)!==json(retained))fail();return true;};
  await check();bytes=await sdk.payloadBytes(claim,ref);bodyBytes=Buffer.from(metadata.body_text,'utf8');
  if(hash(bytes)!==retained.bytes_digest||bytes.length!==retained.byte_count)fail();
  for(const file of retained.file_refs){const content=await sdk.fileBytes(claim,ref,file.file_id);
   if(content.byteLength!==file.byte_length||hash(content)!==file.digest)fail();fileBytes.push(content);}
  const snapshot={snapshot_id:ref.snapshot_id,sealed_contract:ref.digest,payload:metadata.payload,payload_digest:metadata.payload_digest,
   mime_digest:retained.bytes_digest,envelope:metadata.payload.envelope,mime_bytes:bytes,body_bytes:bodyBytes,file_bytes:fileBytes};
  if(metadata.body_html!==undefined){if(typeof metadata.body_html!=='string'||metadata.body_html.length>65536)fail();htmlBytes=Buffer.from(metadata.body_html,'utf8');snapshot.body_html_bytes=htmlBytes;}
  const effect={run_id:claim.run_id,attempt_id:claim.attempt_id,operation_name:claim.operation_name,scope:binding.scope,account,
   draft_ref:{draft_state_key:retained.binding.state_key,draft_id:retained.binding.draft_id,expected_revision:retained.binding.draft_revision},
   // The generic host digest covers binding+metadata+bytes. The Email digest
   // separately authenticates its canonical MIME contract inside that envelope.
   snapshot_ref:{snapshot_id:ref.snapshot_id,digest:metadata.payload_digest},expires_at:new Date(deadline).toISOString()};
  const snapshots=createOutgoingSnapshotService({resolve:async()=>fail(),seal:async()=>fail(),
   verify:async candidate=>{await check();return candidate.snapshot_id===ref.snapshot_id&&candidate.sealed_contract===ref.digest
    &&candidate.payload_digest===metadata.payload_digest&&candidate.mime_digest===retained.bytes_digest;},reserve:journal.reserve});
  const oauth=createEmailOAuth({clients,custody,fetch:fetchImpl,now,host:{
   async resolveAccount({scope,account_id,purpose}){if(!sameEmailScope(scope,binding.scope)||account_id!==binding.account_id||purpose!=='send')fail();await check();return binding;},
   async assertAuthority({binding:requested,purpose}){if(!sameOAuthBinding(requested,binding)||purpose!=='send')fail();await check();return {allowed:true,expires_at:deadline};},
  }});
  const runtime=createOutgoingSendRuntime({snapshots,fetch:fetchImpl,now,custody:{getAccessToken:request=>oauth.getAccessToken(request)},host:{
   async resolveEffect(request){if(request.run_id!==claim.run_id||request.attempt_id!==claim.attempt_id)fail();await check();return effect;},
   async loadSnapshot(){await check();return snapshot;},async assertEffect(){return check();},
   reserveTransport:journal.reserveTransport,recordOutcome:journal.recordOutcome,readOutcome:journal.readOutcome,
  }});
  const result=await runtime.execute({run_id:claim.run_id,attempt_id:claim.attempt_id});
  const acknowledged=await sdk.result(claim,result);
  if(acknowledged?.id!==claim.run_id||acknowledged.state!==(result.status==='returned'?'succeeded':'unknown_outcome'))fail();
  return {state:result.status==='returned'?'provider_accepted':'outcome_unknown',run_id:claim.run_id,automatic_retry:false};
 }catch{
  // Start is durable. A failed acknowledgement or missing custody never permits
  // an automatic second provider attempt, even if completion also fails.
  try{await sdk.result(claim,{status:'indeterminate'});}catch{}
  return {state:'outcome_unknown',run_id:claim.run_id,automatic_retry:false};
 }finally{bytes?.fill(0);bodyBytes?.fill(0);htmlBytes?.fill(0);for(const bytes of fileBytes)bytes.fill(0);}
}
