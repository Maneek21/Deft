import {nativeOwnerCapabilities} from './native-owner-consent.mjs';
import {randomUUID} from 'node:crypto';
import {digest,display,date,fail,pageLimit,PROVIDER_LIMITS} from './contract.mjs';
import {LogicalMailIndex,validateProviderLocator} from '../logical-mail-index.mjs';
import {projectEmailMetadata} from '../metadata-resource.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
import {createNativeImapReaderBridge} from './native-imap-reader.mjs';
import {createNativeImapQueryBridge} from './native-imap-query.mjs';
import {resolveNativeImapSource} from './native-imap-alias.mjs';
import {triageDigest} from './triage-contract.mjs';

export const NATIVE_IMAP_STATE_KEY=digest({kind:'native_imap_account_v1'});
export const NATIVE_IMAP_LIMITS=Object.freeze({folders:512,folder_path:2048,uid_window:4096,metadata_items:100});
const folderKey=path=>digest({kind:'native_imap_folder_v1',path});
const cursorFor=state=>'imap-native-v1:'+state.continuation;
const bounded=value=>{if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>65536)fail('EMAIL_NATIVE_STATE_INVALID');return value;};
const safeText=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\r\n\0]/.test(value);
const uint=value=>Number.isSafeInteger(value)&&value>=0&&value<=4294967295;
const decimal=value=>typeof value==='string'&&/^[1-9]\d{0,29}$/.test(value);
const nativeAccountView=account=>{const {org_id,owner_user_id,installation_id,connection_target,action_binding_id,verified_sender_identities,...view}=account;return view;};
const address=rows=>{if(rows===undefined)return '';if(!Array.isArray(rows)||rows.length>500)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return display(rows.map(row=>row.name?`${row.name} <${row.address??''}>`:row.address??'').join(', '));};
const sameStats=(a,b)=>a?.uidvalidity===b.uidvalidity&&a.uidnext===b.uidnext&&a.exists===b.exists&&a.modseq===b.modseq;
function stats(client){
 const row=client.mailbox,uidvalidity=String(row?.uidValidity),uidnext=Number(row?.uidNext),exists=Number(row?.exists);
 const modseq=!client.enabled?.has('CONDSTORE')||row?.noModseq||row?.highestModseq===undefined?null:String(row.highestModseq);
 if(!decimal(uidvalidity)||!Number.isSafeInteger(uidnext)||uidnext<1||uidnext>4294967296||!uint(exists)||modseq!==null&&!decimal(modseq))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
 return {uidvalidity,uidnext,exists,modseq};
}
function metadata(account,path,validity,row){
 const envelope=row.envelope??{},flags=new Set(row.flags??[]);
 return {account_id:account.account_id,provider:'imap_smtp',locator:{kind:'imap_smtp',mailbox:path,uidvalidity:validity,uid:row.uid},
  subject:display(envelope.subject),sender:address(envelope.from),recipients:address(envelope.to),cc:address(envelope.cc),
  date:date(row.internalDate??envelope.date),folders:[path],flags:{seen:flags.has('\\Seen'),flagged:flags.has('\\Flagged'),answered:flags.has('\\Answered')},
  message_id:display(envelope.messageId),in_reply_to:display(envelope.inReplyTo),references:'',body_status:'lazy',files_status:'unknown'};
}
function roles(row){
 const names=new Set([row.specialUse,...(row.flags??[])]),result=[];
 if(row.path.toUpperCase()==='INBOX')result.push('inbox');
 for(const [name,canonical]of Object.entries({'\\Sent':'sent','\\Junk':'spam','\\Trash':'trash','\\Drafts':'drafts','\\Archive':'archive','\\All':'all','\\Flagged':'starred'}))if(names.has(name))result.push(canonical);
 return result.length?result:['folder:'+folderKey(row.path)];
}
function missingFolder(error){
 // A transport failure, permission denial or generic tagged NO is not proof of
 // absence. ImapFlow preserves the parsed tagged response on command errors.
 return error?.responseStatus==='NO'&&error.response?.attributes?.some(attribute=>attribute.type==='SECTION'&&attribute.section?.[0]?.value==='NONEXISTENT');
}

/** Trusted host port (never supplied by an HTTP caller):
 * current(context) -> NativeEmailAccount plus org_id, owner_user_id, installation_id.
 * withAuthorizedClient(context, expectedAccount, work) -> work(authenticated ImapFlow).
 * The host owns encrypted profile custody, verified implicit TLS/required STARTTLS,
 * logger:false, connect deadlines, principal/generation checks and final cleanup.
 * It releases credential-storage locks BEFORE connect/work. current is read-only
 * and does not connect. PREAUTH is accepted only under the host's principal proof.
 * This factory never reads legacy plaintext account-config or obtains passwords.
 */
export function createNativeImapBridge({host,now=Date.now,monotonic=()=>performance.now(),imageDependencies}){
 if(typeof host?.current!=='function'||typeof host?.withAuthorizedClient!=='function')fail('EMAIL_NATIVE_IMAP_HOST_REQUIRED');
 async function runtime(context,inspection=false){
  nativeOwnerCapabilities(context,{inspection});
  const keys=['org_id','owner_user_id','account_id','installation_id','resource_binding_id','authority_version','expires_at','recheck','signal','provider_state','imap_aliases','owner_capabilities','lifecycle_inspect'];
  if(!context||Object.keys(context).some(key=>!keys.includes(key))||keys.slice(0,6).some(key=>!safeText(context[key]))
   ||!Number.isSafeInteger(context.expires_at)||context.expires_at<=now()||typeof context.recheck!=='function'
   ||context.signal!==undefined&&!(context.signal instanceof AbortSignal))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
  const received=monotonic(),started=now(),expires=context.expires_at,checkSql=async()=>{
   context.signal?.throwIfAborted();if(expires<=Math.max(now(),started+Math.max(0,monotonic()-received)))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
   await context.recheck();context.signal?.throwIfAborted();if(expires<=Math.max(now(),started+Math.max(0,monotonic()-received)))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
  };
  const current=async()=>{
   await checkSql();const account=await host.current(context);await checkSql();
   const accountKeys=['org_id','owner_user_id','installation_id','account_id','provider','resource_binding_id','authority_epoch','connection_revision','principal_digest','health','capabilities','primary_address','display_label','connection_target','action_binding_id','verified_sender_identities'];
   if(!account||Object.keys(account).some(key=>!accountKeys.includes(key))||['org_id','owner_user_id','account_id','installation_id','resource_binding_id'].some(key=>account[key]!==context[key])
    ||account.provider!=='imap_smtp'||!Number.isSafeInteger(account.authority_epoch)||account.authority_epoch<1
    ||!Number.isSafeInteger(account.connection_revision)||account.connection_revision<1||!(/^[a-f0-9]{64}$/).test(account.principal_digest??'')
    ||!['connected','reauth_required','revoked','unavailable'].includes(account.health)||!Array.isArray(account.capabilities)
    ||account.capabilities.length>6||new Set(account.capabilities).size!==account.capabilities.length||account.capabilities.some(value=>!['read','search','thread','send','modify','permanent_delete'].includes(value))
    ||!safeText(account.primary_address)||!safeText(account.display_label))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
   return structuredClone(account);
  };
  const account=await current(),fingerprint=digest(account),check=async()=>{
   const fresh=await current();if(digest(fresh)!==fingerprint||fresh.health!=='connected'||!fresh.capabilities.includes('read'))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
  };
  return {account,check,scope:{org_id:context.org_id,owner_id:context.owner_user_id,installation_id:context.installation_id}};
 }
 return Object.freeze({
  ...createNativeImapReaderBridge({runtime,host,now,imageDependencies}),
  ...createNativeImapQueryBridge({runtime,host,nativeView:nativeAccountView,metadata,folderRoles:roles,now}),
  async nativeEmailAccount(context){const {account}=await runtime(context,true);return nativeAccountView(account);},
  async nativeEmailPage(input,context){
   if(!input||Object.keys(input).sort().join(',')!=='cursor,limit'||input.cursor!==null&&!safeText(input.cursor,8192))fail('EMAIL_NATIVE_PAGE_INVALID');pageLimit(input.limit);
   if(typeof context.provider_state?.read!=='function'||typeof context.provider_state?.stale!=='function')fail('EMAIL_NATIVE_STATE_REQUIRED');
   const value=await runtime(context);await value.check();
   const page=await host.withAuthorizedClient(context,Object.freeze(structuredClone(nativeAccountView(value.account))),async client=>{
    if(client?.secureConnection!==true||!client.authenticated)fail('EMAIL_NATIVE_IMAP_TLS_REQUIRED');await value.check();
    return readNativeImapPage({client,runtime:value,provider_state:context.provider_state,input,signal:context.signal,imap_aliases:context.imap_aliases});
   });
   await value.check();return {...page,observed_at:new Date(now()).toISOString()};
  },
 });
}

/** Bounded all-selectable-folder inventory and CONDSTORE catch-up. Successful UID
 * SEARCH is the absence proof; a partial FETCH or failed folder never deletes.
 * IMAP move identity remains folder/UIDVALIDITY/UID unless separate reviewed
 * move evidence supplies aliases. Header equality never merges two messages. */
export async function readNativeImapPage({client,runtime,provider_state,input,signal,imap_aliases}){
 let timer,expired=false;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;try{client.close?.();}catch{}try{fail('EMAIL_PROVIDER_SCAN_DEADLINE');}catch(error){reject(error);}},PROVIDER_LIMITS.timeout_ms);});
 const check=async()=>{signal?.throwIfAborted();if(expired)fail('EMAIL_PROVIDER_SCAN_DEADLINE');await wait(runtime.check());signal?.throwIfAborted();if(expired)fail('EMAIL_PROVIDER_SCAN_DEADLINE');};
 const wait=promise=>Promise.race([promise,timeout]);
 const call=async work=>{await check();const value=await wait(work());await check();return value;};
 try{
  const updates=new Map(),read=async key=>{if(updates.has(key))return updates.get(key);const row=await call(()=>provider_state.read(key));if(row&&(row.state_key!==key||!Number.isSafeInteger(row.storage_revision)||row.storage_revision<1))fail('EMAIL_NATIVE_STATE_INVALID');return row;};
  const listed=await call(()=>client.list());
  if(!Array.isArray(listed)||listed.length>NATIVE_IMAP_LIMITS.folders||Buffer.byteLength(JSON.stringify(listed))>1048576)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
  const catalog=listed.filter(row=>!row.flags?.has('\\Noselect')&&!row.flags?.has('\\NonExistent')).map(row=>{
   if(!safeText(row.path,NATIVE_IMAP_LIMITS.folder_path))fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {path:row.path,roles:roles(row)};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(!catalog.length||new Set(catalog.map(row=>row.path)).size!==catalog.length)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  const catalogDigest=digest(catalog),saved=await read(NATIVE_IMAP_STATE_KEY);
  let generation=saved?.generation??randomUUID(),state=saved?structuredClone(bounded(saved.value)):null;
  const start=full=>({version:1,phase:'scan',round:full?'baseline':'changes',catalog:catalogDigest,folder:0,work:null,
   full,needs_sweep:full,after:null,probe:randomUUID(),cycle:randomUUID(),continuation:randomUUID()});
  const reset=()=>{generation=randomUUID();state=start(true);};
  if(state){
   if(state.version!==1||!['scan','sweep','verify','idle'].includes(state.phase)||!['baseline','changes'].includes(state.round)
    ||!safeText(generation,128)||!safeText(state.continuation)||input.cursor!==cursorFor(state)||!Number.isSafeInteger(state.folder)||state.folder<0
    ||typeof state.full!=='boolean'||typeof state.needs_sweep!=='boolean'||!safeText(state.cycle)||!safeText(state.probe))fail('EMAIL_NATIVE_STATE_CONFLICT');
   if(state.catalog!==catalogDigest)reset();else if(state.phase==='idle')state=start(false);
  }else{if(input.cursor!==null)fail('EMAIL_NATIVE_STATE_CONFLICT');state=start(true);}
  const put=(key,value)=>updates.set(key,{state_key:key,generation,value:bounded(value)});
  const messages=[],tombstones=[],tombstone_sources={};
  const open=async(path,work)=>{
   let lock;try{await check();lock=await wait(client.getMailboxLock(path,{readOnly:true}));await check();if(client.mailbox?.readOnly!==true)fail('EMAIL_NATIVE_IMAP_READONLY_REQUIRED');return await work();}finally{lock?.release();}
  };
  const search=async(query,min,max)=>{
   const rows=await call(()=>client.search(query,{uid:true}));
   if(!Array.isArray(rows)||rows.length>4096||new Set(rows).size!==rows.length||rows.some(uid=>!uint(uid)||uid<min||uid>max))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
   return rows.sort((a,b)=>a-b);
  };
  const fetch=async(path,validity,ids)=>{
   if(!ids.length)return;const found=new Set(),rows=[];let bytes=0;
   const iterator=client.fetch(ids.join(','),{uid:true,envelope:true,flags:true,size:true,internalDate:true},{uid:true})[Symbol.asyncIterator]();
   try{for(;;){await check();const next=await wait(iterator.next());await check();if(next.done)break;const row=next.value;
    if(!ids.includes(row.uid)||found.has(row.uid)||rows.length>=input.limit)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
    bytes+=Buffer.byteLength(JSON.stringify({uid:row.uid,envelope:row.envelope,size:row.size,date:row.internalDate,flags:[...(row.flags??[])]}));
    if(bytes>PROVIDER_LIMITS.metadata_bytes)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');found.add(row.uid);rows.push(row);
   }}finally{await wait(iterator.return?.());}
   // ImapFlow can present a partial FETCH as successful for some tagged NO
   // responses. Retry a short metadata batch; it cannot certify coverage or
   // delete a UID that the preceding successful SEARCH reported present.
   if(found.size!==ids.length)fail('EMAIL_NATIVE_IMAP_FETCH_INCOMPLETE');
   for(const row of rows)messages.push({message:metadata(runtime.account,path,validity,row),roles:catalog.find(folder=>folder.path===path)?.roles??['folder:'+folderKey(path)]});
  };
  if(state.phase==='scan'){
   if(state.folder>=catalog.length){
    if(state.round==='baseline'){state.round='changes';state.folder=0;state.work=null;}
    else{state.phase=state.needs_sweep?'sweep':'idle';state.folder=0;state.after=null;}
   }else{
    const folder=catalog[state.folder],key=folderKey(folder.path),prior=await read(key);
    if(prior&&(prior.value.kind!=='folder'||prior.value.path!==folder.path))fail('EMAIL_NATIVE_STATE_INVALID');
    await open(folder.path,async()=>{
     const current=stats(client),last=prior?.value;
     if(state.work&&state.work.path!==folder.path)fail('EMAIL_NATIVE_STATE_INVALID');
     if(state.work&&state.work.target.uidvalidity!==current.uidvalidity){state.work=null;state.needs_sweep=true;}
     if(!state.work){
      const full=state.round==='baseline'||!last||last.uidvalidity!==current.uidvalidity||last.modseq===null||current.modseq===null||BigInt(current.modseq)<BigInt(last.modseq);
      if(!full&&sameStats(last,current)){state.folder++;return;}
      state.needs_sweep=true;
      state.work={path:folder.path,target:current,after:0,pending:[],modseq:full?null:last.modseq};
     }
     const work=state.work,highwater=work.target.uidnext-1;
     if(!uint(work.after)||!Array.isArray(work.pending)||work.pending.length>4096||work.pending.some(uid=>!uint(uid)||uid<1||uid>highwater))fail('EMAIL_NATIVE_STATE_INVALID');
     if(!work.pending.length&&work.after<highwater){
      const end=Math.min(highwater,work.after+4096),query={uid:`${work.after+1}:${end}`};if(work.modseq!==null)query.modseq=BigInt(work.modseq)+1n;
      work.pending=await search(query,work.after+1,end);work.after=end;
     }
     const batch=work.pending.splice(0,input.limit);await fetch(folder.path,current.uidvalidity,batch);
     if(!work.pending.length&&work.after>=highwater){put(key,{kind:'folder',path:folder.path,roles:folder.roles,...work.target,sweep_cycle:state.cycle});state.work=null;state.folder++;}
    });
   }
  }else if(state.phase==='sweep'){
   // Scan all cached sources even on the first generation: a message can be
   // expunged after its inventory page was committed. Generation equality is
   // not presence proof. The keyset keeps this reconciliation bounded.
   const rows=await call(()=>provider_state.stale(state.probe,state.after,input.limit));
   if(!Array.isArray(rows)||rows.length>input.limit)fail('EMAIL_NATIVE_STATE_INVALID');
   let previous=state.after;const groups=new Map();
   for(const row of rows){
    if(!/^mail_[a-f0-9]{64}$/.test(row.logical_message_id??'')||previous!==null&&row.logical_message_id<=previous)fail('EMAIL_NATIVE_STATE_INVALID');previous=row.logical_message_id;
    const source=row.provider_source,locator=validateProviderLocator(source?.locator);
    const parent=await resolveNativeImapSource({scope:runtime.scope,account:{...runtime.account,authority_epoch:source.authority_epoch},source,aliases:imap_aliases,check});
    if(source.account_id!==runtime.account.account_id||source.provider!=='imap_smtp'||locator.kind!=='imap_smtp'||source.logical_message_id!==row.logical_message_id||parent.logical_message_id!==row.logical_message_id)fail('EMAIL_NATIVE_STATE_INVALID');
    tombstone_sources[row.logical_message_id]=triageDigest(source);
    if(!groups.has(locator.mailbox))groups.set(locator.mailbox,[]);groups.get(locator.mailbox).push({id:row.logical_message_id,locator});
   }
   for(const [path,group]of groups){
    const folder=catalog.find(item=>item.path===path),status=folder?await read(folderKey(path)):null;
    if(!state.full&&status?.value.sweep_cycle!==state.cycle)continue;
    try{await open(path,async()=>{
     const current=stats(client),matching=[];
     for(const row of group)if(current.uidvalidity!==row.locator.uidvalidity)tombstones.push(row.id);else matching.push(row);
     if(matching.length){
      const ids=matching.map(row=>row.locator.uid),present=await search({uid:ids.join(',')},Math.min(...ids),Math.max(...ids));
      if(present.some(uid=>!ids.includes(uid)))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
      for(const row of matching)if(!present.includes(row.locator.uid))tombstones.push(row.id);
      await fetch(path,current.uidvalidity,present);
     }
    });}catch(error){if(!missingFolder(error))throw error;await check();tombstones.push(...group.map(row=>row.id));}
   }
   state.after=previous;if(!rows.length){state.phase='verify';state.folder=0;}
  }else if(state.phase==='verify'){
   if(state.folder>=catalog.length)state.phase='idle';
   else{const folder=catalog[state.folder],last=await read(folderKey(folder.path));await open(folder.path,async()=>{
    if(!last||!sameStats(last.value,stats(client))){state.phase='scan';state.round='changes';state.folder=0;state.work=null;state.needs_sweep=true;state.after=null;state.probe=randomUUID();state.cycle=randomUUID();}
    else state.folder++;
   });}
  }
  const index=new LogicalMailIndex(runtime.scope),items=messages.map(({message,roles})=>{
   const parent=index.upsert(runtime.scope,message),projection=projectEmailMetadata(parent);
   return {account_id:runtime.account.account_id,logical_message_id:parent.logical_message_id,revision:projection.revision,
    received_at:projection.data.date||null,folders:roles,flags:parent.summary.flags,data:projection.data,
    provider_source:providerSourceForParent(runtime.account,parent),inventory_generation:generation};
  });
  state.continuation=randomUUID();put(NATIVE_IMAP_STATE_KEY,state);await check();
  return {account_id:runtime.account.account_id,items,next_cursor:cursorFor(state),has_more:state.phase!=='idle',complete:state.phase==='idle',failure_count:0,tombstones,tombstone_sources:Object.fromEntries(tombstones.map(id=>[id,tombstone_sources[id]])),state_updates:[...updates.values()]};
 }finally{clearTimeout(timer);}
}
