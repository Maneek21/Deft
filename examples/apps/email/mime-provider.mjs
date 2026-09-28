import {realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDeftResourceSyncClientV3,createAppRuntimeClient,parseSyncPageV2} from '@deft/app-kit';
import {messages,Journal,effect,syncPage} from './mail.mjs';
import {attachmentPolicy,EMAIL_MEDIA_TYPES} from './email-attachments.mjs';
const root=realpathSync(process.cwd());
assert.ok(realpathSync(resolve('node_modules/@deft/app-kit')).startsWith(root+sep));
const credential=({session_id,session_token})=>({session_id,session_token});
process.once('message',async config=>{let phase='construct',boundedPage;try {
 if(config.mode==='sync') {
  const legacySchema=process.env.DEFT_EMAIL_LEGACY_SCHEMA==='true';
  if(!legacySchema&&(typeof config.inventoryPath!=='string'||!config.inventoryPath))throw Error('EMAIL_SYNC_INVENTORY_REQUIRED');
  if(typeof config.stageJournal!=='string'||!config.stageJournal||typeof config.recoveryPath!=='string'||!config.recoveryPath)throw Error('EMAIL_SYNC_PRIVATE_PATHS_REQUIRED');
  const sdk=createDeftResourceSyncClientV3({channel_url:config.url,credential:credential(config.credential)});
  phase='claim';const claim=await sdk.claim();if(!claim)throw Error('NO_SYNC_CLAIM');if(config.expected_run_id&&claim.run_id!==config.expected_run_id)throw Error('EMAIL_SYNC_CLAIM_MISMATCH');
  phase='start';const started=await sdk.start(claim),journal=new Journal(config.stageJournal),upserts=[];
  const authorityScope=createHash('sha256').update(JSON.stringify({org_id:claim.org_id,app_installation_id:claim.app_installation_id,app_version_id:claim.app_version_id,grant_snapshot_id:claim.grant_snapshot_id,lifecycle_epoch:claim.lifecycle_epoch,grant_epoch:claim.grant_epoch,runtime_registration_id:claim.runtime_registration_id,runtime_epoch:claim.runtime_epoch,resource_binding_id:started.resource_binding_id,descriptor_digest:started.descriptor_digest})).digest('hex');
  phase='actual_imap';boundedPage=!legacySchema?await syncPage(started.input,config.inventoryPath,authorityScope,signal=>sdk.heartbeat(claim,{signal})):null;
  const rows=boundedPage?boundedPage.upserts:await messages();
  const count=rows.reduce((n,row)=>n+row.attachments.length,0),bytes=rows.reduce((n,row)=>n+row.attachments.reduce((a,part)=>a+part.bytes.byteLength,0),0);
  const policy=attachmentPolicy(started.input.attachments);
  if(count>policy.max_attachments_per_run||bytes>policy.max_attachment_bytes_per_run||rows.some(row=>row.attachments.length>policy.max_attachments_per_record||row.attachments.some(part=>part.bytes.byteLength>policy.max_attachment_bytes||!EMAIL_MEDIA_TYPES.includes(part.media_type)||!policy.allowed_media_types.includes(part.media_type))))throw Error('DECLARED_ATTACHMENT_BUDGET');
  for(const row of rows) {
   const {id,revision,uid,attachments,...legacyData}=row,data=boundedPage?row.data:legacyData,linked=[];
   for(const part of attachments) {
    const identity={run_id:claim.run_id,parent:id,revision,key:part.key,digest:createHash('sha256').update(part.bytes).digest('hex')};
    const prior=journal.rows().find(item=>item.run_id===identity.run_id&&item.parent===id&&item.key===part.key);
    if(prior)throw Error('STAGE_ALREADY_ATTEMPTED_NO_AUTOMATIC_RETRY');
    journal.append({...identity,state:'put_started'});
    phase='stage';const staged=await sdk.stageAttachment(claim,{parent_resource_id:id,parent_revision:revision,attachment_key:part.key,filename:part.filename,declared_media_type:part.media_type},part.bytes);
    journal.append({...identity,state:'staged',staging_id:staged.staging_id});linked.push({attachment_key:part.key,staging_id:staged.staging_id});
    await sdk.heartbeat(claim);
   }
   upserts.push({id,revision,data:{...data,resource_id:id},attachments:linked});
  }
  const page=parseSyncPageV2(started.descriptor,started.input,{schema_version:'deft.app_sync_page.v2',upserts,
   tombstones:boundedPage?boundedPage.tombstones:(config.previousIds||[]).filter(id=>!rows.some(row=>row.id===id)).map(id=>({id,revision:'archived'})),next_cursor:boundedPage?boundedPage.next_cursor:'email-mime-refresh',has_more:boundedPage?boundedPage.has_more:false});
  // Provider-only recovery artifact is private and never copied to reports.
  writeFileSync(config.recoveryPath,JSON.stringify({claim,started,page}),{mode:0o600});
  phase='result';await sdk.result(claim,started,{status:'returned',provider_succeeded:true,page});
  boundedPage?.commit();
  process.send({type:'sync_settled',run_id:claim.run_id,count:rows.length,tombstone_count:page.tombstones.length,has_more:page.has_more,attachment_count:count,ids:rows.map(row=>row.id)});
 } else {
  const sdk=createAppRuntimeClient({channel_url:config.url,credential:credential(config.credential)}),journal=new Journal(config.journal);
  phase='claim';const claim=await sdk.claim();if(!claim)throw Error('NO_RUNTIME_CLAIM');
  phase='start';const started=await sdk.start(claim);
  phase='actual_transport';const output=await effect(journal,claim.run_id,config.action,started.input);
  phase='result';await sdk.result(claim,{status:'returned',provider_succeeded:true,output});
  journal.append({...journal.latest(claim.run_id),state:'reported'});
  process.send({type:'effect_settled',run_id:claim.run_id,action:config.action});
 }
 } catch(error){process.send({type:'error',phase,code:error instanceof Error?error.name:'UNKNOWN',status:error?.status});}
 finally {boundedPage?.close();process.disconnect();}
});
process.send({type:'ready'});
