import {simpleParser} from 'mailparser';
import {compileEmailQuery} from '../email-query-language.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {projectEmailMetadata} from '../metadata-resource.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
import {resolveNativeImapSource} from './native-imap-alias.mjs';
import {digest,encodeCursor,decodeCursor,pageLimit,fail,PROVIDER_LIMITS} from './contract.mjs';

export const NATIVE_IMAP_QUERY_LIMITS=Object.freeze({folders:512,uid_window:4096,windows_per_page:8,header_bytes:65536,relationship_ids:16,message_id:200});
const text=(value,max=2048)=>typeof value==='string'&&value.length>0&&value.length<=max&&Buffer.byteLength(value)<=max&&!/[\r\n\0]/u.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const validId=value=>typeof value==='string'&&value.length<=200&&/^<[^<>\s@]+@[^<>\s@]+>$/u.test(value);
function stateFrom(client){const validity=String(client.mailbox?.uidValidity),next=Number(client.mailbox?.uidNext);if(!/^[1-9]\d{0,29}$/u.test(validity)||!integer(next,1,4294967296)||client.mailbox?.readOnly!==true)fail('EMAIL_NATIVE_IMAP_QUERY_INVALID');return {validity,upper:next-1};}
async function headerIds(row){
 if(!(row.headers instanceof Uint8Array)||row.headers.length>NATIVE_IMAP_QUERY_LIMITS.header_bytes)fail('EMAIL_NATIVE_IMAP_HEADER_LIMIT');const bytes=Buffer.from(row.headers);
 try{const parsed=await simpleParser(bytes,{skipHtmlToText:true,skipTextToHtml:true});const message_id=parsed.messageId??'';
  if(parsed.headerLines.filter(row=>row.key==='message-id').length>1||message_id&&!validId(message_id))fail('EMAIL_NATIVE_IMAP_HEADERS_INVALID');
  const raw=[parsed.inReplyTo??'',...(Array.isArray(parsed.references)?parsed.references:[parsed.references??''])].join(' '),references=raw.match(/<[^<>\s]+>/gu)??[];
  if(references.some(id=>!validId(id)))fail('EMAIL_NATIVE_IMAP_HEADERS_INVALID');return {message_id,references:[...new Set(references)]};
 }finally{bytes.fill(0);row.headers.fill(0);}
}
function cursorState(value){
 if(!value||Object.keys(value).sort().join(',')!=='catalog,folder,mailbox,upper,validity'||!text(value.catalog,64)||!integer(value.folder,0,512)||value.mailbox!==null&&!text(value.mailbox)
  ||value.validity!==null&&(typeof value.validity!=='string'||!/^[1-9]\d{0,29}$/u.test(value.validity))||value.upper!==null&&!integer(value.upper,0,4294967295)
  ||[value.mailbox,value.validity,value.upper].filter(v=>v===null).length%3!==0)fail('EMAIL_PROVIDER_CURSOR_INVALID');return value;
}
/** Server search and exact header relationships share bounded UID traversal.
 * Private provider cursors are wrapped by the host's scoped encrypted cursor.
 * No cached subset, Subject grouping, or body/header snippets are search proof. */
export function createNativeImapQueryBridge({runtime,host,nativeView,metadata,folderRoles,now=Date.now}){
 const project=(value,path,validity,row,roles)=>{
  const parent=new LogicalMailIndex(value.scope).upsert(value.scope,metadata(value.account,path,validity,row)),projected=projectEmailMetadata(parent);
  return {account_id:value.account.account_id,logical_message_id:parent.logical_message_id,revision:projected.revision,received_at:projected.data.date||null,folders:roles,
   flags:{seen:parent.summary.flags?.seen??false,flagged:parent.summary.flags?.flagged??false,answered:parent.summary.flags?.answered??false},data:projected.data,provider_source:providerSourceForParent(value.account,parent)};
 };
 async function withRead(value,context,work){
  await value.check();const result=await host.withAuthorizedClient(context,Object.freeze(nativeView(value.account)),async client=>{
   if(client?.secureConnection!==true||!client.authenticated)fail('EMAIL_NATIVE_IMAP_TLS_REQUIRED');let timer,onAbort;
   const interrupted=new Promise((_,reject)=>{const stop=code=>{try{client.close?.();}catch{}try{fail(code);}catch(error){reject(error);}};onAbort=()=>stop('EMAIL_SOURCE_ABORTED');context.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>stop('EMAIL_PROVIDER_SCAN_DEADLINE'),Math.max(1,Math.min(PROVIDER_LIMITS.timeout_ms,context.expires_at-now())));});void interrupted.catch(()=>{});
   const wait=promise=>Promise.race([Promise.resolve(promise),interrupted]),check=async()=>{context.signal?.throwIfAborted();await wait(value.check());context.signal?.throwIfAborted();if(context.expires_at<=now())fail('EMAIL_NATIVE_AUTHORITY_DENIED');},call=async work=>{await check();const result=await wait(work());await check();return result;};
   const open=async(path,work)=>{let lock;try{lock=await call(()=>client.getMailboxLock(path,{readOnly:true}));stateFrom(client);return await work();}finally{lock?.release();}};
   const fetch=async(ids,headers=false)=>{
    const query={uid:true,envelope:true,flags:true,size:true,internalDate:true,...(headers?{headers:['message-id','references','in-reply-to']}:{})},iterator=client.fetch(ids.join(','),query,{uid:true})[Symbol.asyncIterator](),rows=[],seen=new Set();let bytes=0;
    try{for(;;){await check();const row=await wait(iterator.next());await check();if(row.done)break;const value=row.value;
     if(!ids.includes(value.uid)||seen.has(value.uid)||rows.length>=ids.length)fail('EMAIL_PROVIDER_RESPONSE_INVALID');seen.add(value.uid);
     bytes+=Buffer.byteLength(JSON.stringify({envelope:value.envelope,flags:[...(value.flags??[])],size:value.size,date:value.internalDate}))+Number(value.headers?.length??0);if(bytes>PROVIDER_LIMITS.metadata_bytes)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');rows.push(value);
    }}finally{await wait(iterator.return?.());}return rows;
   };
   try{return await work({client,wait,check,call,open,fetch});}finally{clearTimeout(timer);context.signal?.removeEventListener('abort',onAbort);}
  });await value.check();return result;
 }
 async function scan(value,context,input,{kind,predicate,identity,relation,folderRole}){
  return withRead(value,context,async io=>{
   const raw=await io.call(()=>io.client.list());if(!Array.isArray(raw)||raw.length>512||Buffer.byteLength(JSON.stringify(raw))>1048576)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
   const fullCatalog=raw.filter(row=>!row.flags?.has('\\Noselect')&&!row.flags?.has('\\NonExistent')).map(row=>{if(!text(row.path))fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {path:row.path,roles:folderRoles(row)};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
   if(new Set(fullCatalog.map(row=>row.path)).size!==fullCatalog.length)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
   const catalog=folderRole?fullCatalog.filter(row=>row.roles.includes(folderRole)):fullCatalog;
   if(folderRole&&!catalog.length){await io.check();return {scope_unavailable:true};}
   const catalogDigest=digest(fullCatalog),binding=digest({kind,scope:value.scope,account_id:value.account.account_id,principal:value.account.principal_digest,connection:value.account.connection_revision,epoch:value.account.authority_epoch,identity,limit:input.limit});
   let state=input.cursor?cursorState(decodeCursor(input.cursor,binding)):{catalog:catalogDigest,folder:0,mailbox:null,validity:null,upper:null};
   if(state.catalog!==catalogDigest||state.folder>catalog.length)fail('EMAIL_NATIVE_IMAP_QUERY_RESET');const items=[];let windows=0,consumed=0,failures=0;
   while(state.folder<catalog.length&&windows<8&&consumed<input.limit){const folder=catalog[state.folder];
    await io.open(folder.path,async()=>{
     const actual=stateFrom(io.client);if(state.mailbox===null){state.mailbox=folder.path;state.validity=actual.validity;state.upper=actual.upper;}
     else if(state.mailbox!==folder.path||state.validity!==actual.validity)fail('EMAIL_NATIVE_IMAP_QUERY_RESET');
     while(state.upper>0&&windows<8&&consumed<input.limit){const high=state.upper,low=Math.max(1,high-4095),query={...predicate,uid:`${low}:${high}`},ids=await io.call(()=>io.client.search(query,{uid:true}));windows++;
      if(!Array.isArray(ids)||ids.length>4096||new Set(ids).size!==ids.length||ids.some(uid=>!integer(uid,low,high)))fail('EMAIL_PROVIDER_RESPONSE_INVALID');ids.sort((a,b)=>b-a);
      if(!ids.length){state.upper=low-1;continue;}const selected=ids.slice(0,input.limit-consumed);consumed+=selected.length;const rows=await io.fetch(selected,Boolean(relation));failures+=selected.length-rows.length;
      const byId=new Map(rows.map(row=>[row.uid,row]));for(const uid of selected){const row=byId.get(uid);if(!row)continue;if(relation){const headers=await headerIds(row);await io.check();if(!relation(headers))continue;}items.push(project(value,folder.path,actual.validity,row,folder.roles));}
      state.upper=selected.at(-1)-1;
     }
    });
    if(state.upper===0){state.folder++;state.mailbox=null;state.validity=null;state.upper=null;}
   }
   await io.check();const has_more=state.folder<catalog.length;return {items,has_more,next_cursor:has_more?encodeCursor(binding,state):null,failure_count:failures,observed_at:new Date(now()).toISOString()};
  });
 }
 const checked=input=>{if(!input||input.cursor!==null&&!text(input.cursor,8192))fail('EMAIL_NATIVE_SEARCH_INVALID');pageLimit(input.limit);};
 return Object.freeze({
  async nativeEmailSearch(input,context){
   if(!input||Object.keys(input).sort().join(',')!=='cursor,limit,query'||typeof input.query!=='string')fail('EMAIL_NATIVE_SEARCH_INVALID');checked(input);const value=await runtime(context);await value.check();const compiled=compileEmailQuery('imap_smtp',input.query);
   const identity={schema_version:'deft.email_search_page.v1',account_id:value.account.account_id,provider:'imap_smtp',original_query:input.query,provider_result_cap:null,limitations:[...compiled.limitations,'weak_uid_traversal',...(compiled.request?.folder_role?['canonical_folder_scope']:['all_selectable_folders']),'date_is_internal_date_for_metadata']};
   if(compiled.status==='unsupported'){await value.check();return {...identity,status:'unsupported',items:[],next_cursor:null,has_more:false,query_complete:false,failure_count:0,observed_at:new Date(now()).toISOString(),unsupported:compiled.unsupported};}
   const page=await scan(value,context,input,{kind:'native_imap_search_v1',predicate:compiled.request.search,identity:input.query,folderRole:compiled.request.folder_role});
   if(page.scope_unavailable)return {...identity,status:'unsupported',items:[],next_cursor:null,has_more:false,query_complete:false,failure_count:0,observed_at:new Date(now()).toISOString(),unsupported:[{index:compiled.ast.terms.findIndex(term=>term.field==='in'),field:'in',reason:'folder_scope_unavailable'}]};
   return {...identity,...page,status:'supported',unsupported:[],query_complete:!page.has_more&&page.failure_count===0};
  },
  async nativeEmailConversation(input,context){
   if(!input||Object.keys(input).sort().join(',')!=='cursor,limit,source')fail('EMAIL_NATIVE_CONVERSATION_INPUT_INVALID');checked(input);const value=await runtime(context);await value.check();const parent=await resolveNativeImapSource({scope:value.scope,account:value.account,source:input.source,aliases:context.imap_aliases,check:value.check}),locator=parent.locator;if(locator.kind!=='imap_smtp')fail('EMAIL_NATIVE_CONVERSATION_INPUT_INVALID');
   const anchor=await withRead(value,context,async io=>io.open(locator.mailbox,async()=>{if(stateFrom(io.client).validity!==locator.uidvalidity)fail('EMAIL_NATIVE_IMAP_QUERY_RESET');const rows=await io.fetch([locator.uid],true);if(rows.length!==1)fail('EMAIL_NATIVE_CONVERSATION_SOURCE_STALE');return headerIds(rows[0]);}));
   if(!validId(anchor.message_id))fail('EMAIL_NATIVE_IMAP_CONVERSATION_HEADERS_REQUIRED');const all=[...new Set([anchor.message_id,...anchor.references])],ids=all.slice(0,16),known=new Set(ids);
   const predicate={or:ids.flatMap(id=>['Message-ID','References','In-Reply-To'].map(header=>({header:{[header]:id}})))};
   const page=await scan(value,context,input,{kind:'native_imap_relationships_v1',identity:[input.source.logical_message_id,locator,ids],predicate,relation:headers=>known.has(headers.message_id)||headers.references.some(id=>known.has(id))});
   await value.check();return {schema_version:'deft.email_conversation_page.v1',account_id:value.account.account_id,provider:'imap_smtp',anchor_logical_message_id:parent.logical_message_id,...page,complete:false,thread_basis:'message_headers',limitations:['bounded_header_relationships','not_provider_thread','transitive_relationships_not_complete',...(all.length>16?['anchor_reference_limit']:[])]};
  },
 });
}
