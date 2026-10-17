import {digest,display,date,fail,pageLimit,PROVIDER_LIMITS} from './contract.mjs';

export const IMAP_METADATA_LIMITS=Object.freeze({uid_window:64,folders:512,folder_path:2048});
function nextFolder(state){state.folder++;state.after=0;state.validity=null;state.highwater=null;if(state.folder===3){state.folder=0;state.round++;return false;}return true;}
function stateFrom(cursor,folderDigest){
 const initial={v:1,round:0,folder:0,after:0,validity:null,highwater:null,folders_digest:folderDigest};if(cursor===null)return initial;
 if(!cursor||typeof cursor!=='object'||Object.keys(cursor).sort().join(',')!=='after,folder,folders_digest,highwater,round,v,validity'||cursor.v!==1||cursor.folders_digest!==folderDigest||!Number.isSafeInteger(cursor.round)||cursor.round<0||!Number.isInteger(cursor.folder)||cursor.folder<0||cursor.folder>2||!Number.isSafeInteger(cursor.after)||cursor.after<0||cursor.after>4294967295||cursor.highwater!==null&&(!Number.isSafeInteger(cursor.highwater)||cursor.highwater<cursor.after||cursor.highwater>4294967295)||cursor.validity!==null&&!/^\d{1,30}$/.test(cursor.validity))fail('EMAIL_PROVIDER_CURSOR_INVALID');return {...cursor};
}
function address(rows){if(rows===undefined)return '';if(!Array.isArray(rows)||rows.length>500)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return display(rows.map(row=>row.name?`${row.name} <${row.address??''}>`:row.address??'').join(', '));}
async function folders(client,configured){
 if(configured!==undefined&&(!configured||typeof configured!=='object'||Object.keys(configured).some(key=>!['sent','archive'].includes(key))))fail('EMAIL_PROVIDER_FOLDER_MAP_INVALID');
 const listed=await client.list();if(!Array.isArray(listed)||listed.length>IMAP_METADATA_LIMITS.folders||listed.some(row=>typeof row.path!=='string'||!row.path||row.path.length>IMAP_METADATA_LIMITS.folder_path||/[\r\n\0]/.test(row.path)))fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
 const special=name=>listed.find(row=>row.specialUse===name||row.flags?.has(name))?.path??null;
 const values=[{key:'inbox',path:'INBOX'},{key:'sent',path:configured?.sent??special('\\Sent')},{key:'archive',path:configured?.archive??special('\\Archive')}];
 if(values.some(row=>row.path!==null&&(typeof row.path!=='string'||!row.path||row.path.length>IMAP_METADATA_LIMITS.folder_path||/[\r\n\0]/.test(row.path))))fail('EMAIL_PROVIDER_FOLDER_MAP_INVALID');
 const paths=values.map(row=>row.path).filter(Boolean);if(new Set(paths).size!==paths.length)fail('EMAIL_PROVIDER_FOLDER_MAP_INVALID');return values;
}
// A separate metadata path: no source/bodyStructure/file fetch and no legacy
// tombstone inference. The host acknowledgement persists its private index.
async function readPage(client,{account_id,limit,cursor,configuredFolders,onProgress},checkDeadline,wait){
 pageLimit(limit);checkDeadline();const selectedFolders=await wait(folders(client,configuredFolders));checkDeadline();const state=stateFrom(cursor,digest(selectedFolders)),selected=selectedFolders[state.folder],messages=[];
 let hasMore=true;
 if(selected.path===null)hasMore=nextFolder(state);
 else{
  const lock=await wait(client.getMailboxLock(selected.path).then(value=>{try{checkDeadline();}catch(error){value.release();throw error;}return value;}));
  try{
   checkDeadline();
   const validity=String(client.mailbox.uidValidity),uidNext=Number(client.mailbox.uidNext);if(!/^\d{1,30}$/.test(validity)||!Number.isSafeInteger(uidNext)||uidNext<1||uidNext>4294967296)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
   if(state.validity!==validity){state.after=0;state.highwater=uidNext-1;state.validity=validity;}
   if(state.highwater===null)state.highwater=uidNext-1;if(state.highwater>=uidNext)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
   const end=Math.min(state.highwater,state.after+IMAP_METADATA_LIMITS.uid_window),rows=[],uids=new Set();let bytes=0;
   if(end>state.after){const iterator=client.fetch(`${state.after+1}:${end}`,{uid:true,envelope:true,flags:true,size:true,internalDate:true},{uid:true})[Symbol.asyncIterator]();
    try{for(;;){const {done,value:row}=await wait(iterator.next());if(done)break;
     checkDeadline();
     if(rows.length>=IMAP_METADATA_LIMITS.uid_window||!Number.isInteger(row.uid)||row.uid<=state.after||row.uid>end||uids.has(row.uid))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
     bytes+=Buffer.byteLength(JSON.stringify({uid:row.uid,envelope:row.envelope,size:row.size,date:row.internalDate,flags:[...(row.flags??[])]}));if(bytes>PROVIDER_LIMITS.metadata_bytes)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');uids.add(row.uid);rows.push(row);
    }}finally{try{await wait(iterator.return?.());}catch{}}
   }
   rows.sort((a,b)=>a.uid-b.uid);
   for(const row of rows.slice(0,limit)){
    checkDeadline();
    const envelope=row.envelope??{},flags=new Set(row.flags??[]);messages.push({account_id,provider:'imap_smtp',locator:{kind:'imap_smtp',mailbox:selected.path,uidvalidity:validity,uid:row.uid},subject:display(envelope.subject),sender:address(envelope.from),recipients:address(envelope.to),cc:address(envelope.cc),date:date(row.internalDate??envelope.date),folders:[selected.path],flags:{seen:flags.has('\\Seen'),flagged:flags.has('\\Flagged'),answered:flags.has('\\Answered')},message_id:display(envelope.messageId),in_reply_to:display(envelope.inReplyTo),references:'',body_status:'lazy',files_status:'unknown'});state.after=row.uid;await wait(onProgress?.({uid:row.uid}));checkDeadline();
   }
   if(rows.length<=limit)state.after=end;if(state.after>=state.highwater)hasMore=nextFolder(state);
  }finally{lock.release();}
 }
 checkDeadline();
 return {messages,next_state:state,has_more:hasMore,folder_map:Object.fromEntries(selectedFolders.map(row=>[row.key,row.path===null?[]:[row.path]]))};
}
export async function readImapMetadataPage(client,{account_id,limit=25,cursor=null,configuredFolders,onProgress,timeout_ms=PROVIDER_LIMITS.timeout_ms}={}){
 if(!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>PROVIDER_LIMITS.timeout_ms)fail('EMAIL_PROVIDER_INPUT_INVALID');
 let expired=false,timer;const deadline=Date.now()+timeout_ms;
 const expire=()=>{if(expired)return;expired=true;try{client.close?.();}catch{}};
 const checkDeadline=()=>{if(expired||Date.now()>=deadline){expire();fail('EMAIL_PROVIDER_SCAN_DEADLINE');}};
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expire();try{fail('EMAIL_PROVIDER_SCAN_DEADLINE');}catch(error){reject(error);}},timeout_ms);});
 const wait=promise=>Promise.race([promise,timeout]);
 try{return await readPage(client,{account_id,limit,cursor,configuredFolders,onProgress},checkDeadline,wait);}finally{clearTimeout(timer);}
}
