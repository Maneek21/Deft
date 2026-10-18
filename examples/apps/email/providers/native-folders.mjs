import {createApiTransport,digest,fail,text,pathId,pageLimit} from './contract.mjs';
import {oauthObject} from './oauth-contract.mjs';
import {gmailFolderId,microsoftFolderId,GMAIL_CANONICAL_FOLDERS} from './native-folder-identity.mjs';
import {NATIVE_MICROSOFT_STATE_KEY} from './native-microsoft.mjs';

const graph='https://graph.microsoft.com/v1.0/me',gmail='https://gmail.googleapis.com/gmail/v1/users/me';
const roles={inbox:'inbox',sentitems:'sent',junkemail:'spam',deleteditems:'trash',drafts:'drafts',archive:'archive'};
const select='id,displayName,parentFolderId,childFolderCount,isHidden';
const byteLimit=65536;
const protectedGraphAliases=['archive','clutter','conflicts','conversationhistory','deleteditems','drafts','inbox','junkemail','localfailures','msgfolderroot','outbox','recoverableitemsdeletions','scheduled','searchfolders','sentitems','serverfailures','syncissues'];
async function protectedGraph(api){
 const ids=[],systems={};let index=0,complete=true;const budget={remaining:128*1024,deadline:Date.now()+15000};
 await Promise.all(Array.from({length:4},async()=>{while(index<protectedGraphAliases.length){const alias=protectedGraphAliases[index++];try{const row=await api.request(`${graph}/mailFolders/${alias}?$select=id`,{operation:'modify',maxBytes:4096,budget});const id=text(row.id,256);ids.push(id);if(Object.hasOwn(roles,alias))Object.defineProperty(systems,id,{value:roles[alias],enumerable:true});}catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')complete=false;}}}));
 return {ids:[...new Set(ids)],systems,complete};
}
const renameable=(row,protectedIds)=>row.canonical_role===null&&row.move_allowed&&row.kind==='folder'&&!protectedIds.includes(row.id);
const bounded=value=>{if(Buffer.byteLength(JSON.stringify(value))>byteLimit)fail('EMAIL_NATIVE_FOLDER_CURSOR_LIMIT');return value;};
const encodeCursor=(binding,value)=>Buffer.from(JSON.stringify(bounded({v:1,binding,value}))).toString('base64url');
function decodeCursor(cursor,binding){
 if(cursor===null)return null;let parsed;
 try{if(typeof cursor!=='string'||cursor.length>90000||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw Error();const bytes=Buffer.from(cursor,'base64url');if(bytes.length>byteLimit||bytes.toString('base64url')!==cursor)throw Error();parsed=JSON.parse(bytes.toString('utf8'));}
 catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 if(parsed.v!==1||parsed.binding!==binding||Object.keys(parsed).sort().join(',')!=='binding,v,value')fail('EMAIL_PROVIDER_CURSOR_INVALID');return parsed.value;
}
function graphLink(value,parent){
 text(value,8192);let url;try{url=new URL(value);}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 let selected=null;const match=/^\/v1\.0\/me\/mailFolders(?:\/([^/]+)|\('((?:[^']|'')+)'\))\/childFolders$/iu.exec(url.pathname);
 if(match)try{selected=decodeURIComponent(match[1]??match[2]).replaceAll("''","'");}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 if(url.origin!=='https://graph.microsoft.com'||url.username||url.password||url.hash
   ||(parent===null?!/^\/v1\.0\/me\/mailFolders$/iu.test(url.pathname):!match||selected!==parent))fail('EMAIL_PROVIDER_CURSOR_INVALID');return url.href;
}
const label=row=>{if(!row||!['system','user'].includes(row.type))fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {
 id:text(row.id,256),label:text(row.name,512),kind:'label',parent_id:null,parent_folder_id:null,canonical_role:GMAIL_CANONICAL_FOLDERS[row.id]??null,
 folder_id:gmailFolderId(row.id),move_allowed:row.type==='user'||row.id==='INBOX',labels_allowed:row.type==='user'};};
// POST creates a user label; PATCH has already verified a current user label.
// Mutation Label responses may omit type; other label reads stay strict.
const mutationLabel=row=>{if(!row||Object.hasOwn(row,'type')&&row.type!=='user')fail('EMAIL_PROVIDER_RESPONSE_INVALID');return label({...row,type:'user'});};
const folder=(row,systems)=>{if(!row||!Number.isSafeInteger(row.childFolderCount)||row.childFolderCount<0||typeof row.isHidden!=='boolean')fail('EMAIL_PROVIDER_RESPONSE_INVALID');
 const id=text(row.id,256),parent=row.parentFolderId===undefined?null:text(row.parentFolderId,256);return {id,label:text(row.displayName,512),kind:'folder',parent_id:parent,
 parent_folder_id:parent===null?null:microsoftFolderId(parent,systems),
 canonical_role:Object.hasOwn(systems,id)?systems[id]:null,folder_id:microsoftFolderId(id,systems),
 move_allowed:!row.isHidden&&row['@odata.type']!=='#microsoft.graph.mailSearchFolder',labels_allowed:false};};

/** Provider IDs stay in host-only pages; the API seals destination nominations.
 * Collection pages have bounded HTTP, cursor and depth limits, never an entire
 * serialized mailbox catalog. Tree changes are weakly consistent. */
export function createNativeEmailFoldersBridge({runtime,now=Date.now}){
 return Object.freeze({
  async nativeEmailFolders(input,context){
   oauthObject(input,['cursor','limit','management'],'EMAIL_NATIVE_FOLDER_INPUT_INVALID');pageLimit(input.limit);if(input.management!==undefined&&input.management!==true)fail('EMAIL_NATIVE_FOLDER_INPUT_INVALID');
   if(!Object.hasOwn(input,'cursor')||input.cursor!==null&&typeof input.cursor!=='string')fail('EMAIL_NATIVE_FOLDER_INPUT_INVALID');
   const value=await runtime(context,input.management?'modify':'read');await value.check();const {account}=value;
   const api=createApiTransport(value.adapterOptions,account.provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com');
   const binding=digest({kind:'native_folder_catalog_v1',scope:value.scope,account_id:account.account_id,principal:value.principal_digest,revision:value.connection_revision,limit:input.limit,...(input.management?{management:true}:{})});
   const retained=decodeCursor(input.cursor,binding);let items=[],next=null;
   if(account.provider==='gmail'){
    const data=await api.request(`${gmail}/labels`,{operation:input.management?'modify':'read'});if(!Array.isArray(data.labels)||data.labels.length>10000)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
    const all=data.labels.map(label);if(new Set(all.map(row=>row.id)).size!==all.length)fail('EMAIL_PROVIDER_RESPONSE_INVALID');if(input.management)for(const row of all)row.rename_allowed=row.labels_allowed;
    // System flag/category labels do not have cached folder memberships. Only
    // current canonical folders and user labels are queryable catalog entries.
    const rows=all.filter(row=>row.canonical_role!==null||row.labels_allowed).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const catalog=digest(rows);if(retained&&(retained.catalog!==catalog||!Number.isSafeInteger(retained.offset)||retained.offset<0||retained.offset>=rows.length))fail('EMAIL_NATIVE_FOLDER_CATALOG_CHANGED');
    const offset=retained?.offset??0;items=rows.slice(offset,offset+input.limit);
    if(offset+items.length<rows.length)next=encodeCursor(binding,{catalog,offset:offset+items.length});
   }else{
    let state=retained??{v:1,stack:[{parent:null,url:null,depth:0}],systems:{}};
    bounded(state);if(state.v!==1||!Array.isArray(state.stack)||state.stack.length>256||!state.systems||typeof state.systems!=='object'||Array.isArray(state.systems))fail('EMAIL_PROVIDER_CURSOR_INVALID');
    state=structuredClone(state);
    if(input.management&&!retained){const protectedSet=await protectedGraph(api);state.protected_ids=protectedSet.ids;state.protected_complete=protectedSet.complete;state.systems=protectedSet.systems;}
    if(input.management&&(!Array.isArray(state.protected_ids)||state.protected_ids.length>17||state.protected_ids.some(id=>typeof id!=='string'||id.length>256)||typeof state.protected_complete!=='boolean'))fail('EMAIL_PROVIDER_CURSOR_INVALID');
    if(!retained){
     if(!input.management&&context.provider_state){await value.check();const stored=await context.provider_state.read(NATIVE_MICROSOFT_STATE_KEY);await value.check();
      const systems=stored?.value?.system_folders;if(systems&&typeof systems==='object'&&!Array.isArray(systems)&&Object.keys(systems).length<=6
        &&Object.entries(systems).every(([id,role])=>typeof id==='string'&&id.length<=256&&Object.values(roles).includes(role)))state.systems=structuredClone(systems);
     }
     if(!input.management&&!Object.keys(state.systems).length)for(const [known,role]of Object.entries(roles)){
      try{const row=await api.request(`${graph}/mailFolders/${known}?$select=id`);Object.defineProperty(state.systems,text(row.id,256),{value:role,enumerable:true,writable:true,configurable:true});}
      catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')throw error;await value.check();}
     }
    }
    const pageSize=Math.min(20,input.limit);
    for(let requests=0;requests<4&&input.limit-items.length>=pageSize&&state.stack.length;requests++){
     const frame=state.stack.pop();if(!frame||!Number.isSafeInteger(frame.depth)||frame.depth<0||frame.depth>32||frame.parent!==null&&typeof frame.parent!=='string'||frame.url!==null&&typeof frame.url!=='string')fail('EMAIL_PROVIDER_CURSOR_INVALID');
     const path=frame.parent===null?`${graph}/mailFolders`:`${graph}/mailFolders/${pathId(frame.parent)}/childFolders`;
     const url=new URL(frame.url===null?path:graphLink(frame.url,frame.parent));
     if(frame.url===null){url.searchParams.set('includeHiddenFolders','true');url.searchParams.set('$top',String(pageSize));url.searchParams.set('$select',select);}
     const page=await api.request(url.href,{operation:input.management?'modify':'read'});if(!Array.isArray(page.value)||page.value.length>pageSize)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
     const rows=page.value.map(row=>folder(row,state.systems));if(new Set(rows.map(row=>row.id)).size!==rows.length)fail('EMAIL_PROVIDER_RESPONSE_INVALID');if(input.management)for(const row of rows)row.rename_allowed=state.protected_complete&&renameable(row,state.protected_ids);
     if(page['@odata.nextLink']!==undefined){const following=graphLink(page['@odata.nextLink'],frame.parent);if(following===frame.url)fail('EMAIL_PROVIDER_PAGINATION_STALLED');state.stack.push({...frame,url:following});}
     for(let index=page.value.length-1;index>=0;index--)if(page.value[index].childFolderCount>0){
      if(frame.depth===32)fail('EMAIL_NATIVE_FOLDER_DEPTH_LIMIT');state.stack.push({parent:rows[index].id,url:null,depth:frame.depth+1});
     }
     items.push(...rows);if(state.stack.length>256)fail('EMAIL_NATIVE_FOLDER_CURSOR_LIMIT');bounded(state);
    }
    if(state.stack.length)next=encodeCursor(binding,bounded(state));
   }
   await value.check();return {schema_version:'deft.email_native_folders.v1',account_id:account.account_id,provider:account.provider,
    items,next_cursor:next,has_more:next!==null,observed_at:new Date(now()).toISOString(),...(input.management?{management:true}:{})};
  },
  async nativeEmailDestination(input,context){
   oauthObject(input,['id'],'EMAIL_NATIVE_FOLDER_INPUT_INVALID');text(input.id,256);
   const value=await runtime(context,'modify');await value.check();const {account}=value;
   const api=createApiTransport(value.adapterOptions,account.provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com');
   const row=account.provider==='gmail'?label(await api.request(`${gmail}/labels/${pathId(input.id)}`,{operation:'modify'})):
    folder(await api.request(`${graph}/mailFolders/${pathId(input.id)}?$select=${select}`,{operation:'modify'}),{});
   if(row.id!==input.id||!row.move_allowed)fail('EMAIL_NATIVE_FOLDER_DESTINATION_DENIED');await value.check();
   return {account_id:account.account_id,provider:account.provider,id:row.id,kind:row.kind};
  },
  async nativeEmailFolderManage(input,context){
   oauthObject(input,input?.kind==='rename'?['kind','id','name','expected_name']:['kind','name'],'EMAIL_NATIVE_FOLDER_INPUT_INVALID');
   if(!['create','rename'].includes(input.kind)||typeof input.name!=='string'||!input.name.isWellFormed()||input.name.trim()!==input.name||!input.name||input.name.length>128||Buffer.byteLength(input.name)>512||/[\u0000-\u001f\u007f-\u009f]/u.test(input.name))fail('EMAIL_NATIVE_FOLDER_INPUT_INVALID');
   const value=await runtime(context,'modify');await value.check();const {account}=value,api=createApiTransport(value.adapterOptions,account.provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com');
   if(input.kind==='rename'){
    text(input.id,256);text(input.expected_name,512);
    const row=account.provider==='gmail'?label(await api.request(`${gmail}/labels/${pathId(input.id)}`,{operation:'modify'})):
     folder(await api.request(`${graph}/mailFolders/${pathId(input.id)}?$select=${select}`,{operation:'modify'}),{});
    if(row.id!==input.id||row.label!==input.expected_name)fail('EMAIL_NATIVE_FOLDER_TARGET_CHANGED');
    if(account.provider==='gmail'){if(!row.labels_allowed)fail('EMAIL_NATIVE_FOLDER_TARGET_CHANGED');}
    else{const protectedSet=await protectedGraph(api);if(!protectedSet.complete||!renameable(row,protectedSet.ids))fail('EMAIL_NATIVE_FOLDER_TARGET_CHANGED');}
   }
   await value.check();const base=account.provider==='gmail'?`${gmail}/labels`:`${graph}/mailFolders`,url=input.kind==='create'?base:base+'/'+pathId(input.id);
   let raw;try{raw=await api.request(url,{operation:'modify',method:input.kind==='create'?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(account.provider==='gmail'?{name:input.name}:{displayName:input.name,...(input.kind==='create'?{isHidden:false}:{})})});}
   catch(error){if(error.status!==null&&error.status>=400&&error.status<500&&error.status!==408)fail('EMAIL_NATIVE_FOLDER_PROVIDER_REJECTED',{outcome:'no_effect'});fail('EMAIL_NATIVE_FOLDER_OUTCOME_UNKNOWN',{outcome:'uncertain'});}
   try{const id=text(raw.id,256);if(input.kind==='rename'&&id!==input.id)throw Error();
    const row=account.provider==='gmail'?mutationLabel(raw):folder(raw,{});if(row.label!==input.name||account.provider==='gmail'&&!row.labels_allowed||account.provider==='microsoft'&&(!row.move_allowed||row.canonical_role!==null))throw Error();
    await value.check();return {id:row.id,label:row.label,kind:row.kind,folder_id:row.folder_id};
   }catch{fail('EMAIL_NATIVE_FOLDER_OUTCOME_UNKNOWN',{outcome:'uncertain'});}
  }
 });
}
