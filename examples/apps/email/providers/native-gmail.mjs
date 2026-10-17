import {randomUUID} from 'node:crypto';
import {createMetadataResetReader} from './conversation-reset.mjs';
import {digest,fail,text,pageLimit} from './contract.mjs';
import {logicalMailIdForProviderMessage} from '../logical-mail-index.mjs';

export const NATIVE_GMAIL_STATE_KEY=digest({kind:'native_gmail_account_v1'});
const phases=['inventory','catchup','sweep','delta','idle'];
const validSequence=value=>typeof value==='string'&&/^\d{1,30}$/.test(value);
const cursorFor=value=>'gmail-native-v1:'+value.continuation;
const validCursor=value=>value===null||typeof value==='string'&&value.length<=8192;
const inventoryRefresh=(checkpoint,turn='inventory')=>({checkpoint,cursor:null,pending:[],turn});
function validateState(row){
 const state=row?.value;
 if(!row||row.state_key!==NATIVE_GMAIL_STATE_KEY||!Number.isSafeInteger(row.storage_revision)||row.storage_revision<1
  ||typeof row.generation!=='string'||!row.generation||row.generation.length>128||!state||state.version!==1
  ||!phases.includes(state.phase)||!validSequence(state.checkpoint)||typeof state.continuation!=='string'
  ||state.continuation.length>128||!['string','object'].includes(typeof state.cursor)||state.cursor!==null&&typeof state.cursor!=='string'
  ||typeof state.sweep_done!=='boolean'||!Array.isArray(state.pending)||state.pending.length>256
  ||state.pending.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(state.pending).size!==state.pending.length
  ||state.pending.length>0&&state.after_pending===null||state.after_pending!==null&&(!state.after_pending||!phases.includes(state.after_pending.phase)||!validSequence(state.after_pending.checkpoint)
    ||state.after_pending.cursor!==null&&typeof state.after_pending.cursor!=='string')||Buffer.byteLength(JSON.stringify(state))>65536)fail('EMAIL_NATIVE_STATE_INVALID');
 const refresh=state.inventory_refresh;
 if(refresh!==undefined&&(!refresh||state.phase!=='inventory'||!validSequence(refresh.checkpoint)||!validCursor(refresh.cursor)
  ||!['inventory','history'].includes(refresh.turn)||!Array.isArray(refresh.pending)||refresh.pending.length>256
  ||refresh.pending.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(refresh.pending).size!==refresh.pending.length))fail('EMAIL_NATIVE_STATE_INVALID');
 return structuredClone(state);
}
async function metadataBatch(reader,ids){
 const found=[];
 for(let offset=0;offset<ids.length;offset+=10){
  const results=await Promise.allSettled(ids.slice(offset,offset+10).map(async id=>({id,message:await reader.resetReadMetadata(id)})));
  const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  found.push(...results.map(result=>result.value));
 }
 return found;
}

/** Account-wide inventory and history state are bounded SQL-owned records.
 * This function produces a proposed page; only the host's fenced transaction
 * commits messages, generation, private state, checkpoint and replay receipt. */
export async function readNativeGmailPage({runtime,provider_state,input}){
 pageLimit(input.limit);
 if(typeof provider_state?.read!=='function'||typeof provider_state?.stale!=='function')fail('EMAIL_NATIVE_STATE_REQUIRED');
 await runtime.check();const retained=await provider_state.read(NATIVE_GMAIL_STATE_KEY);await runtime.check();
 const reader=createMetadataResetReader(runtime.adapterOptions);
 let generation,state;
 if(retained){generation=retained.generation;state=validateState(retained);if(input.cursor!==cursorFor(state))fail('EMAIL_NATIVE_STATE_CONFLICT');}
 else{
  if(input.cursor!==null)fail('EMAIL_NATIVE_STATE_CONFLICT');
  generation=randomUUID();state={version:1,phase:'inventory',checkpoint:await reader.resetStartCheckpoint(),cursor:null,
  pending:[],after_pending:null,sweep_done:false,continuation:randomUUID()};state.inventory_refresh=inventoryRefresh(state.checkpoint);
 }
 let messages=[],tombstones=[],failures=[];
 const reset=async()=>{generation=randomUUID();state={version:1,phase:'inventory',checkpoint:await reader.resetStartCheckpoint(),cursor:null,
  pending:[],after_pending:null,sweep_done:false,continuation:randomUUID()};state.inventory_refresh=inventoryRefresh(state.checkpoint);};
 const identify=id=>logicalMailIdForProviderMessage(runtime.scope,runtime.account.account_id,'gmail',id);
 const ingest=results=>{for(const {id,message}of results){if(message)messages.push(message);else tombstones.push(identify(id));}};
 if(state.pending.length){
  const batch=state.pending.splice(0,input.limit);ingest(await metadataBatch(reader,batch));
  if(!state.pending.length){Object.assign(state,state.after_pending);state.after_pending=null;}
 }else if(state.phase==='inventory'){
  // Interleave current changes with older inventory. Preserve the original
  // checkpoint for the final catch-up/sweep; this lane never claims coverage.
  // Older persisted inventories join immediately without restarting backfill.
  const refresh=state.inventory_refresh??=inventoryRefresh(state.checkpoint,'history');
  if(refresh.turn==='history'){
   if(!refresh.pending.length){
    let changes;try{changes=await reader.resetReadChanges({checkpoint:refresh.checkpoint,cursor:refresh.cursor,limit:1});}
    catch(error){if(error.code!=='EMAIL_PROVIDER_RESPONSE_LIMIT')throw error;changes={expired:true};}
    const ids=changes.expired?[]:[...new Set(changes.changes.map(change=>text(change.id,256)))];
    if(changes.expired||ids.length>256)await reset();
    else{refresh.checkpoint=changes.checkpoint;refresh.cursor=changes.next_cursor;refresh.pending=ids;}
   }
   if(state.inventory_refresh===refresh){
    ingest(await metadataBatch(reader,refresh.pending.splice(0,input.limit)));refresh.turn='inventory';
   }
  }else{
  const page=await runtime.adapter.listMessages({limit:input.limit,cursor:state.cursor,include_spam_trash:true});
  messages=page.messages;failures=page.failures.filter(failure=>failure.code!=='EMAIL_PROVIDER_NOT_FOUND');
  tombstones=page.failures.filter(failure=>failure.code==='EMAIL_PROVIDER_NOT_FOUND').map(failure=>identify(failure.provider_message_id));state.cursor=page.next_cursor;
  refresh.turn='history';
  if(page.next_cursor===null){state.phase='catchup';delete state.inventory_refresh;}
  }
 }else if(state.phase==='sweep'){
  await runtime.check();const stale=await provider_state.stale(generation,null,input.limit);await runtime.check();
  if(!Array.isArray(stale)||stale.length>input.limit)fail('EMAIL_NATIVE_STATE_INVALID');
  const ids=stale.map(record=>{
   const source=record.provider_source;
   if(source?.account_id!==runtime.account.account_id||source?.locator?.kind!=='gmail'
    ||record.logical_message_id!==identify(source.locator.message_id))fail('EMAIL_NATIVE_STATE_INVALID');
   return text(source.locator.message_id,256);
  });
  if(ids.length)ingest(await metadataBatch(reader,ids));
  else{state.sweep_done=true;state.phase='catchup';state.cursor=null;}
 }else{
  // One history record per fetch bounds the private pending queue. A provider
  // record that exceeds the storage budget is rejected without advancement.
  let changes;try{changes=await reader.resetReadChanges({checkpoint:state.checkpoint,cursor:state.cursor,limit:1});}
  catch(error){if(error.code!=='EMAIL_PROVIDER_RESPONSE_LIMIT')throw error;changes={expired:true};}
  if(changes.expired){
   await reset();
  }else{
   const ids=[...new Set(changes.changes.map(change=>text(change.id,256)))];
   // Bulk history can exceed one bounded state record. A fresh full inventory
   // repairs that interval without truncating events or serializing the index.
   if(ids.length>256)await reset();
   else{
   let phase=state.phase==='idle'?'delta':state.phase;
   if(changes.next_cursor===null&&!ids.length)phase=state.sweep_done?'idle':'sweep';
   const next={phase,checkpoint:changes.checkpoint,cursor:changes.next_cursor};
   state.pending=ids;
   if(ids.length)state.after_pending=next;else Object.assign(state,next);
   }
  }
 }
 await runtime.check();
 state.continuation=randomUUID();
 if(Buffer.byteLength(JSON.stringify(state))>65536)fail('EMAIL_NATIVE_STATE_LIMIT');
 const complete=state.phase==='idle'&&!state.pending.length;
 return {messages,tombstones,failures,generation,next_cursor:cursorFor(state),has_more:!complete,complete,
  state_updates:[{state_key:NATIVE_GMAIL_STATE_KEY,generation,value:state}]};
}
