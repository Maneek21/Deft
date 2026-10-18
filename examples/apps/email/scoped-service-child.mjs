import {createAppRuntimeClient} from '@deft/app-kit';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailSendJournal} from './outgoing-operation-store.mjs';
import {runEmailOutgoing} from './outgoing-runtime-service.mjs';
import {emailScopedChildDeadline} from './scoped-service-supervisor.mjs';

// Provider child receives no owner bearer, refresh token, manager path or env.
// The manager already claimed this exact attempt; the real SDK still governs
// Start, retained payload release, current authority and result acknowledgement.
process.once('disconnect',()=>process.exit(1));
process.once('message',async message=>{
 const key=Buffer.from(message?.template?.encryption_key_hex??'','hex'),journalKey=Buffer.from(message?.template?.journal_encryption_key_hex??'','hex');
 try{
  if(process.platform!=='linux'||process.getuid?.()===0||Object.keys(message??{}).sort().join(',')!=='channel_url,claim,credential,session_expires_at,template'
   ||key.length!==32||journalKey.length!==32||!['send_message','triage_message','permanent_delete_message'].includes(message.claim?.operation_name))throw Error('EMAIL_SERVICE_CHILD_INVALID');
  const c=message.template,triage=message.claim.operation_name!=='send_message',deadline=emailScopedChildDeadline({...message.claim,session_expires_at:message.session_expires_at});
  const sdk=createAppRuntimeClient({channel_url:message.channel_url,credential:message.credential,...(triage?{action_resources_version:'deft.app_action_resources.v1'}:{action_payload_version:'deft.app_action_payload.v1'})});
  let consumed=false;const claimedSdk=Object.freeze({...sdk,claim:async()=>{if(consumed)throw Error('EMAIL_SERVICE_CLAIM_REPLAY');consumed=true;return message.claim;}});
  const store=await createEmailFileCustodyStore({root:c.custody_root}),journalStore=await createEmailFileCustodyStore({root:c.journal_root});
  const custody=createEncryptedEmailCustody({store,encryption_key:key,key_id:c.key_id});let result;
  if(triage){
   if(c.schema_version!=='deft.email_triage_service.v1')throw Error('EMAIL_SERVICE_CHILD_INVALID');
   const [{runEmailTriage},{createEmailTriageJournal},{createSupervisedSyncStateStore}]=await Promise.all([
    import('./triage-runtime-service.mjs'),import('./providers/triage-journal.mjs'),import('./providers/supervised-sync-state.mjs')]);
   const pinKeys=['org_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','runtime_registration_id','runtime_binding_id','runtime_epoch','session_id','session_epoch','audience','operation_name'];
   const runtime_pin=Object.fromEntries(pinKeys.map(key=>[key,message.claim[key]])),indexKey=Buffer.from(c.index_encryption_key_hex??'','hex');
   try{if(indexKey.length!==32)throw Error('EMAIL_SERVICE_CHILD_INVALID');
    const indexStore=await createSupervisedSyncStateStore({root:c.index_root,encryption_key:indexKey,key_id:c.index_key_id,scope:c.binding.scope,account_id:c.binding.account.account_id});
    result=await runEmailTriage({sdk:claimedSdk,indexStore,oauthCustody:custody,
     journal:createEmailTriageJournal({store:journalStore,encryption_key:journalKey,key_id:c.journal_key_id}),
     config:{schema_version:'deft.email_triage_runtime.v1',channel_url:message.channel_url,credential:message.credential,expected_run_id:message.claim.run_id,
      binding:c.binding,runtime_pin,oauth_binding:c.oauth_binding,clients:c.clients,resource_key:c.resource_key,expires_at:new Date(deadline).toISOString()}});
   }finally{indexKey.fill(0);}
  }else{
   if(c.schema_version!=='deft.email_outgoing_service.v1')throw Error('EMAIL_SERVICE_CHILD_INVALID');
   result=await runEmailOutgoing({sdk:claimedSdk,account_binding:c.account_binding,clients:c.clients,expected_run_id:message.claim.run_id,custody,
    journal:createEmailSendJournal({store:journalStore,encryption_key:journalKey,key_id:c.journal_key_id})});
  }
  process.send({type:'settled',result},()=>process.exit(0));
 }catch{process.exitCode=1;process.disconnect();}
 finally{key.fill(0);journalKey.fill(0);}
});
process.send?.({type:'ready'});
