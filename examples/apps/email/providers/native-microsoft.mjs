import {randomUUID} from 'node:crypto';
import {createApiTransport,digest,fail,text,pathId,pageLimit} from './contract.mjs';
import {microsoftMetadataSummary} from './microsoft.mjs';
import {logicalMailIdForProviderMessage} from '../logical-mail-index.mjs';
import {microsoftFolderId} from './native-folder-identity.mjs';

const base='https://graph.microsoft.com/v1.0/me';
const fields='id,conversationId,parentFolderId,from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,internetMessageId';
const prefer={Prefer:'IdType="ImmutableId"'};
export const NATIVE_MICROSOFT_STATE_KEY=digest({kind:'native_microsoft_account_v1'});
const streamKey=id=>digest({kind:'native_microsoft_folder_v1',id});
const queueKey=n=>digest({kind:'native_microsoft_queue_v1',position:n});
const controlCursor=state=>'microsoft-native-v1:'+state.continuation;
const sameCatalog=(a,b)=>a?.sum===b.sum&&a?.count===b.count;
const addCatalog=(state,id)=>{const current=Buffer.from(state.catalog_sum,'hex'),next=Buffer.from(digest({kind:'native_graph_catalog_v1',id}),'hex');
 if(current.length!==32||!Number.isSafeInteger(state.catalog_count)||state.catalog_count<0||state.catalog_count>=Number.MAX_SAFE_INTEGER)fail('EMAIL_NATIVE_STATE_INVALID');
 for(let i=0;i<32;i++)current[i]^=next[i];state.catalog_sum=current.toString('hex');state.catalog_count++;
};
const bounded=value=>{if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>65536)fail('EMAIL_NATIVE_STATE_INVALID');return value;};
function folderPath(url){
 let path;try{path=new URL(url).pathname;}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 const match=/^\/v1\.0\/me\/mailFolders(?:\/([^/]+)|\('((?:[^']|'')+)'\))\/(messages\/delta|childFolders)$/i.exec(path);
 if(match){let folder;try{folder=decodeURIComponent(match[1]??match[2]).replaceAll("''","'");}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}return {folder,collection:match[3].toLowerCase()};}
 if(/^\/v1\.0\/me\/mailFolders$/i.test(path))return {folder:null,collection:'folders'};
 fail('EMAIL_PROVIDER_CURSOR_INVALID');
}
function scopedLink(value,folder,collection){
 text(value,8192);let url;try{url=new URL(value);}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 if(url.origin!=='https://graph.microsoft.com'||url.username||url.password||url.hash)fail('EMAIL_PROVIDER_CURSOR_INVALID');
 const path=folderPath(url.href);if(path.folder!==folder||path.collection!==collection)fail('EMAIL_PROVIDER_CURSOR_INVALID');
 return url.href;
}
async function metadataBatch(api,account,ids){
 const results=[];
 for(let offset=0;offset<ids.length;offset+=10){
  const batch=await Promise.allSettled(ids.slice(offset,offset+10).map(async id=>{
   const url=new URL(`${base}/messages/${pathId(id)}`);url.searchParams.set('$select',fields);
   try{const data=await api.request(url.href,{headers:prefer});if(data.id!==id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {id,message:microsoftMetadataSummary(account,data)};}
   catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')throw error;await api.authority('read');return {id,message:null};}
  }));
  const fatal=batch.find(result=>result.status==='rejected');if(fatal)throw fatal.reason;results.push(...batch.map(result=>result.value));
 }
 return results;
}

/** All-folder Graph traversal uses encrypted linked queue pages rather than an
 * unbounded cursor/catalog. Each folder retains its own opaque delta checkpoint.
 * Normal cycles preserve inventory generation and read only changed messages.
 * Catalog change, missing folders or expired delta trigger a full reconciliation. */
export async function readNativeMicrosoftPage({runtime,provider_state,input}){
 pageLimit(input.limit);if(typeof provider_state?.read!=='function'||typeof provider_state?.stale!=='function')fail('EMAIL_NATIVE_STATE_REQUIRED');
 const api=createApiTransport(runtime.adapterOptions,'https://graph.microsoft.com'),updates=new Map();
 const read=async key=>{if(updates.has(key))return updates.get(key);await runtime.check();const row=await provider_state.read(key);await runtime.check();if(row&&(row.state_key!==key||!Number.isSafeInteger(row.storage_revision)||row.storage_revision<1))fail('EMAIL_NATIVE_STATE_INVALID');return row;};
 let saved=await read(NATIVE_MICROSOFT_STATE_KEY),generation=saved?.generation??randomUUID(),state=saved?structuredClone(bounded(saved.value)):null;
 const start=(reset=false)=>({version:1,phase:'catalog',round:'baseline',root_cursor:null,head:null,tail:null,chunk:0,current:null,
  system_folders:state?.system_folders??{},reset,need_system_folders:reset,reconcile:reset,completed_catalog:state?.completed_catalog??null,
  baseline_catalog:null,catalog_sum:'0'.repeat(64),catalog_count:0,cycle:randomUUID(),continuation:randomUUID()});
 const restart=()=>{generation=randomUUID();state=start(true);};
 if(state){if(typeof generation!=='string'||!generation||generation.length>128||state.version!==1||!['catalog','work','sweep','idle'].includes(state.phase)||!['baseline','catchup'].includes(state.round)
   ||typeof state.continuation!=='string'||input.cursor!==controlCursor(state)||!Number.isSafeInteger(state.chunk)||state.chunk<0)fail('EMAIL_NATIVE_STATE_CONFLICT');
  if(state.phase==='idle')state=start();
 }else{if(input.cursor!==null)fail('EMAIL_NATIVE_STATE_CONFLICT');state=start(true);}
 const put=(key,value)=>{bounded(value);updates.set(key,{state_key:key,generation,value});};
 const enqueue=async ids=>{
  if(!ids.length)return;
  const key=queueKey(state.chunk++),node={kind:'queue',ids,index:0,next:null};
  if(state.tail){const tail=await read(state.tail);if(!tail||tail.value.kind!=='queue')fail('EMAIL_NATIVE_STATE_INVALID');put(state.tail,{...tail.value,next:key});}
  else state.head=key;
  state.tail=key;put(key,node);
 };
 const folders=async(parent,cursor)=>{
  const collection=parent===null?'folders':'childfolders',path=parent===null?`${base}/mailFolders`:`${base}/mailFolders/${pathId(parent)}/childFolders`;
  const url=new URL(cursor===null?path:scopedLink(cursor,parent,collection));
  if(cursor===null){url.searchParams.set('includeHiddenFolders','true');url.searchParams.set('$top','20');url.searchParams.set('$select','id');}
  const page=await api.request(url.href,{headers:prefer});if(!Array.isArray(page.value)||page.value.length>20)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  const ids=page.value.map(row=>text(row.id,2048));if(new Set(ids).size!==ids.length)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  const next=page['@odata.nextLink']===undefined?null:scopedLink(page['@odata.nextLink'],parent,collection);
  if(next!==null&&next===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');return {ids,next};
 };
 let messages=[],tombstones=[];
 const identify=id=>logicalMailIdForProviderMessage(runtime.scope,runtime.account.account_id,'microsoft',id);
 const ingest=results=>{for(const {id,message}of results){if(message)messages.push(message);else tombstones.push(identify(id));}};
 if(state.need_system_folders){
  state.system_folders={};
  for(const [wellKnown,canonical]of Object.entries({inbox:'inbox',sentitems:'sent',junkemail:'spam',deleteditems:'trash',drafts:'drafts',archive:'archive'})){
   try{const value=await api.request(`${base}/mailFolders/${wellKnown}?$select=id`,{headers:prefer});Object.defineProperty(state.system_folders,text(value.id,2048),{value:canonical,enumerable:true,configurable:true,writable:true});}
   catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')throw error;await api.authority('read');}
  }
  state.need_system_folders=false;
 }
 if(state.phase==='catalog'){
  const page=await folders(null,state.root_cursor);await enqueue(page.ids);state.root_cursor=page.next;if(page.next===null)state.phase='work';
 }else if(state.phase==='sweep'){
  await runtime.check();const stale=await provider_state.stale(generation,null,input.limit);await runtime.check();
  if(!Array.isArray(stale)||stale.length>input.limit)fail('EMAIL_NATIVE_STATE_INVALID');
  const ids=stale.map(row=>{const source=row.provider_source;if(source?.account_id!==runtime.account.account_id||source?.locator?.kind!=='microsoft'
    ||source.locator.id_type!=='immutable'||row.logical_message_id!==identify(source.locator.message_id))fail('EMAIL_NATIVE_STATE_INVALID');return text(source.locator.message_id,2048);});
  if(ids.length)ingest(await metadataBatch(api,runtime.account,ids));
  else{state.phase='catalog';state.round='catchup';state.root_cursor=null;state.head=null;state.tail=null;state.chunk=0;state.current=null;state.reset=false;state.catalog_sum='0'.repeat(64);state.catalog_count=0;}
 }else if(state.phase==='work'){
  if(!state.current){
   if(!state.head){
    const catalog={sum:state.catalog_sum,count:state.catalog_count};
    if(state.round==='catchup'){
     if(sameCatalog(state.baseline_catalog,catalog)){state.phase='idle';state.completed_catalog=catalog;}else restart();
    }else if(state.reconcile){state.baseline_catalog=catalog;state.phase='sweep';}
    else if(sameCatalog(state.completed_catalog,catalog)){state.phase='idle';state.completed_catalog=catalog;}else restart();
   }
   else{
    const node=await read(state.head);if(!node||node.generation!==generation||node.value.kind!=='queue'||!Array.isArray(node.value.ids)
      ||node.value.ids.length>20||!Number.isSafeInteger(node.value.index)||node.value.index<0||node.value.index>=node.value.ids.length)fail('EMAIL_NATIVE_STATE_INVALID');
    const id=text(node.value.ids[node.value.index],2048),stream=await read(streamKey(id));
    const nextNode={...node.value,index:node.value.index+1};
    if(nextNode.index===node.value.ids.length){state.head=node.value.next;if(state.head===null)state.tail=null;}else put(state.head,nextNode);
    if(stream?.generation!==generation||stream.value.visit!==`${state.cycle}:${state.round}`||stream.value.done!==true){addCatalog(state,id);state.current={id,stage:'delta',cursor:null};}
   }
  }else{
   const current=state.current,key=streamKey(current.id),stream=await read(key);
   if(current.stage==='delta'){
    const path=`${base}/mailFolders/${pathId(current.id)}/messages/delta`,retained=current.cursor??(state.reset?null:stream?.value.delta_link??null);
    const url=new URL(retained===null?path:scopedLink(retained,current.id,'messages/delta'));
    if(retained===null){url.searchParams.set('$select',fields);url.searchParams.set('$top',String(input.limit));}
    let page;try{page=await api.request(url.href,{headers:{Prefer:prefer.Prefer+`, odata.maxpagesize=${input.limit}`}});}catch(error){
     if(error.code==='EMAIL_PROVIDER_CURSOR_EXPIRED'||error.code==='EMAIL_PROVIDER_NOT_FOUND'){restart();page=null;}
     else throw error;
    }
    if(page){
     if(!Array.isArray(page.value)||page.value.length>input.limit||(page['@odata.nextLink']===undefined)===(page['@odata.deltaLink']===undefined))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
     const ids=[...new Set(page.value.map(row=>{if(row['@removed']!==undefined&&row['@removed']?.reason!=='deleted')fail('EMAIL_PROVIDER_RESPONSE_INVALID');return text(row.id,2048);} ))];
     // Delta rows can be duplicated or unordered and removal may mean a move.
     // Resolve latest immutable metadata; only authenticated global404 deletes.
     ingest(await metadataBatch(api,runtime.account,ids));
     const next=page['@odata.nextLink']===undefined?null:scopedLink(page['@odata.nextLink'],current.id,'messages/delta');
     if(next!==null&&next===retained)fail('EMAIL_PROVIDER_PAGINATION_STALLED');
     if(next!==null)current.cursor=next;
     else{put(key,{kind:'folder',id:current.id,delta_link:scopedLink(page['@odata.deltaLink'],current.id,'messages/delta'),visit:`${state.cycle}:${state.round}`,done:false});current.stage='children';current.cursor=null;}
    }
   }else if(current.stage==='children'){
    let page;try{page=await folders(current.id,current.cursor);}catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')throw error;restart();page=null;}
    if(page){await enqueue(page.ids);current.cursor=page.next;if(page.next===null){if(!stream?.value.delta_link)fail('EMAIL_NATIVE_STATE_INVALID');put(key,{...stream.value,done:true});state.current=null;}}
   }else fail('EMAIL_NATIVE_STATE_INVALID');
  }
 }
 await runtime.check();state.continuation=randomUUID();put(NATIVE_MICROSOFT_STATE_KEY,state);
 if(updates.size>8)fail('EMAIL_NATIVE_STATE_LIMIT');
 const complete=state.phase==='idle';
 return {messages,tombstones,generation,next_cursor:controlCursor(state),has_more:!complete,complete,state_updates:[...updates.values()],
  foldersFor:id=>[microsoftFolderId(id,state.system_folders)]};
}
