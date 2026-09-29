import {readFileSync,openSync,writeSync,fsyncSync,closeSync,renameSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {attachmentPolicy,collectEmailAttachments} from './email-attachments.mjs';

export const MAIL_SYNC_LIMITS=Object.freeze({uid_window:64,items:10,source_bytes:8388608,page_source_bytes:16777216,record_bytes:57344,page_bytes:524288,cache_entries:4096,cache_bytes:1048576});
// UUID links have fixed width. Budget the actual published scalar/link shape,
// never the private binary buffers that go through the separate stage endpoint.
export const stagedWireRow=row=>({id:row.id,revision:row.revision,data:row.data,attachments:row.attachments.map(part=>({attachment_key:part.key,staging_id:'00000000-0000-0000-0000-000000000000'}))});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded=(value,max)=>String(value??'').replace(/[\r\n\0]/g,' ').slice(0,max);
const address=rows=>(rows??[]).map(row=>row.name?`${row.name} <${row.address}>`:row.address).filter(Boolean).join(', ');
const date=value=>{if(value===undefined||value===null)return '';const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'':parsed.toISOString();};
const initial=()=>({v:1,round:0,folder:0,after:0,validity:null,highwater:null});
function cursor(raw){if(raw===null)return initial();let value;try{if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)throw Error();value=JSON.parse(raw);}catch{throw Error('EMAIL_SYNC_CURSOR_INVALID');}
 if(!value||Object.keys(value).sort().join(',')!=='after,folder,highwater,round,v,validity'||value.v!==1||!Number.isSafeInteger(value.round)||value.round<0||!Number.isInteger(value.folder)||value.folder<0||value.folder>2||!Number.isSafeInteger(value.after)||value.after<0||(value.highwater!==null&&(!Number.isSafeInteger(value.highwater)||value.highwater<value.after))||(value.validity!==null&&(!/^\d{1,30}$/.test(value.validity))))throw Error('EMAIL_SYNC_CURSOR_INVALID');return value;
}
function cache(path,scope){if(!existsSync(path))return {v:1,scope,entries:[]};const raw=readFileSync(path);if(raw.byteLength>MAIL_SYNC_LIMITS.cache_bytes)throw Error('EMAIL_SYNC_CACHE_INVALID');let value;try{value=JSON.parse(raw);}catch{throw Error('EMAIL_SYNC_CACHE_INVALID');}
 if(value?.v!==1||value.scope!==scope||!Array.isArray(value.entries)||value.entries.length>MAIL_SYNC_LIMITS.cache_entries||value.entries.some(entry=>!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||entry[0].length>256||typeof entry[1]!=='string'||!/^[a-f0-9]{64}$/.test(entry[1])))throw Error('EMAIL_SYNC_CACHE_INVALID');return value;
}
function commitCache(path,entries,scope){const value={v:1,scope,entries:[...entries].slice(-MAIL_SYNC_LIMITS.cache_entries)};const bytes=Buffer.from(JSON.stringify(value));if(bytes.byteLength>MAIL_SYNC_LIMITS.cache_bytes)throw Error('EMAIL_SYNC_CACHE_LIMIT');const pending=`${path}.pending-${randomUUID()}`,fd=openSync(pending,'wx',0o600);try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(pending,path);}
function parts(structure){const out=[];const visit=(node,depth)=>{if(!node||depth>16||out.length>128)throw Error('EMAIL_ATTACHMENT_METADATA_LIMIT');if(node.childNodes?.length){for(const child of node.childNodes)visit(child,depth+1);}else if(node.disposition==='attachment'||node.parameters?.name||node.dispositionParameters?.filename||!['text/plain','text/html'].includes(node.type))out.push(node);};visit(structure,0);return out;}
export async function resolveMailboxFolders(client,configured){const list=await client.list();const special=name=>list.find(row=>row.specialUse===name||row.flags?.has(name))?.path;return [{key:'inbox',path:'INBOX'},{key:'sent',path:configured?.sent??special('\\Sent')??null},{key:'archive',path:configured?.archive??special('\\Archive')??null}];}
export async function loadMessageByLocator(client,id,configured){
 const match=/^(inbox|sent|archive):(\d{1,30}):([1-9]\d{0,9})$/.exec(id??'');if(!match)throw Error('STALE_MAIL_PARENT');
 const folder=(await resolveMailboxFolders(client,configured)).find(row=>row.key===match[1]);if(!folder?.path)throw Error('STALE_MAIL_PARENT');const uid=Number(match[3]);
 const lock=await client.getMailboxLock(folder.path);try{
  if(String(client.mailbox.uidValidity)!==match[2])throw Error('STALE_MAIL_PARENT');
  const metadata=await client.fetchOne(uid,{size:true,uid:true},{uid:true});if(!metadata||metadata.uid!==uid||!Number.isSafeInteger(metadata.size)||metadata.size<0||metadata.size>MAIL_SYNC_LIMITS.source_bytes)throw Error('STALE_MAIL_PARENT');
  const source=await client.fetchOne(uid,{source:{start:0,maxLength:metadata.size+1}},{uid:true});if(!source?.source||source.uid!==uid||source.source.byteLength!==metadata.size)throw Error('STALE_MAIL_PARENT');
  const parsed=await simpleParser(source.source);return {uid,uidvalidity:match[2],mailbox:folder.path,message_id:parsed.messageId??'',references:Array.isArray(parsed.references)?parsed.references.join(' '):parsed.references??'',archive_path:(await resolveMailboxFolders(client,configured)).find(row=>row.key==='archive')?.path};
 }finally{lock.release();}
}

// Client is the normal ImapFlow object. Tests record the same bounded fetch calls;
// production wrappers supply an authenticated verified-TLS connection.
export async function readMailboxSyncPage(client,{request,cachePath,cacheScope,configuredFolders,onProgress}) {
 if(!request||!Number.isInteger(request.max_items)||request.max_items<1||request.max_items>100)throw Error('EMAIL_SYNC_REQUEST_INVALID');
 if(typeof cacheScope!=='string'||cacheScope.length<1||cacheScope.length>256)throw Error('EMAIL_SYNC_CACHE_SCOPE_REQUIRED');
 const state=cursor(request.cursor),folderSet=await resolveMailboxFolders(client,configuredFolders),selected=folderSet[state.folder],retained=cache(cachePath,cacheScope);
 // A null host cursor begins a new checkpoint. Never omit its initial upserts
 // because an older local cache happened to share the same binding/descriptor.
 const policy=attachmentPolicy(request.attachments),entries=new Map(request.cursor===null?[]:retained.entries),upserts=[],budget={count:0,bytes:0};let sourceBytes=0;
 let hasMore=true;const advance=()=>{state.folder++;state.after=0;state.validity=null;state.highwater=null;if(state.folder===3){state.folder=0;state.round++;hasMore=false;}};
 if(selected.path===null)advance();
 else {
  const lock=await client.getMailboxLock(selected.path);try{
   const validity=String(client.mailbox.uidValidity),highwater=Math.max(0,client.mailbox.uidNext-1);
   if(state.validity!==validity){state.after=0;state.highwater=highwater;state.validity=validity;}
   if(state.highwater===null)state.highwater=highwater;
   const end=Math.min(state.highwater,state.after+MAIL_SYNC_LIMITS.uid_window),metadata=[];
   if(end>state.after)for await(const row of client.fetch(`${state.after+1}:${end}`,{uid:true,envelope:true,flags:true,size:true,internalDate:true,bodyStructure:true},{uid:true}))metadata.push(row);
   metadata.sort((a,b)=>a.uid-b.uid);
   for(const row of metadata){
    if(!Number.isSafeInteger(row.uid)||row.uid<=state.after||row.uid>end)throw Error('EMAIL_SYNC_UID_INVALID');
    const id=`${selected.key}:${validity}:${row.uid}`,flags=[...(row.flags??[])].sort(),metadataDigest=hash({projection:'email.metadata.v2',policy,id,size:row.size,envelope:row.envelope,flags,date:date(row.internalDate),structure:row.bodyStructure});
    if(entries.get(id)===metadataDigest){state.after=row.uid;continue;}
    if(upserts.length>=Math.min(request.max_items,MAIL_SYNC_LIMITS.items))break;
    let attachmentMetadata;try{attachmentMetadata=parts(row.bodyStructure);}catch{attachmentMetadata=null;}
    let bodyStatus='oversize',parsed,source;
    if(Number.isSafeInteger(row.size)&&row.size>=0&&row.size<=MAIL_SYNC_LIMITS.source_bytes){
     if(sourceBytes+row.size+1>MAIL_SYNC_LIMITS.page_source_bytes)break;
     const fetched=await client.fetchOne(row.uid,{source:{start:0,maxLength:Math.min(row.size+1,MAIL_SYNC_LIMITS.source_bytes+1)}},{uid:true});
     sourceBytes+=fetched?.source?.byteLength??0;
     if(fetched?.source&&fetched.uid===row.uid&&fetched.source.byteLength===row.size){source=fetched.source;try{parsed=await simpleParser(source);bodyStatus='available';}catch{bodyStatus='unavailable';}}else bodyStatus='unavailable';
    }
    const candidateBudget={...budget},collected=collectEmailAttachments(parsed,policy,candidateBudget),{attachments,skipped:originalSkipped,original_downloadable_count,...body}=collected;
    if(parsed&&body.body_truncated)bodyStatus='truncated';let skipped=originalSkipped;
    const attachmentCount=parsed?parsed.attachments.length:attachmentMetadata?.length??0;
    if(!parsed)skipped=attachmentCount;
    const data={subject:bounded(parsed?.subject??row.envelope?.subject??'(no subject)',200),...body,sender:bounded(parsed?.from?.text??address(row.envelope?.from),200),recipients:bounded(parsed?.to?.text??address(row.envelope?.to),200),message_id:bounded(parsed?.messageId??row.envelope?.messageId,200),in_reply_to:bounded(parsed?.inReplyTo??row.envelope?.inReplyTo,200),references:bounded(Array.isArray(parsed?.references)?parsed.references.join(' '):parsed?.references,1000),resource_id:id,uidvalidity:validity,mailbox:selected.path,folder:selected.key,date:date(parsed?.date??row.envelope?.date??row.internalDate),seen:flags.includes('\\Seen'),answered:flags.includes('\\Answered'),flagged:flags.includes('\\Flagged'),attachment_count:attachmentCount,downloadable_attachment_count:original_downloadable_count,skipped_attachment_count:skipped,attachment_metadata_complete:parsed!==undefined||attachmentMetadata!==null,body_status:bodyStatus};
    const revision=createHash('sha256').update(metadataDigest).update(source??Buffer.alloc(0)).digest('hex'),candidate={id,revision,data,attachments};
    if(Buffer.byteLength(JSON.stringify(stagedWireRow(candidate)))>MAIL_SYNC_LIMITS.record_bytes)throw Error('EMAIL_RECORD_WIRE_BUDGET');
    // Reserve 4KiB for cursor/page envelope. A declined candidate advances
    // neither cache nor UID cursor and consumes no staged attachment allowance.
    if(Buffer.byteLength(JSON.stringify([...upserts,candidate].map(stagedWireRow)))>MAIL_SYNC_LIMITS.page_bytes-4096)break;
    Object.assign(budget,candidateBudget);upserts.push(candidate);entries.delete(id);entries.set(id,metadataDigest);state.after=row.uid;
    await onProgress?.();
   }
   if(metadata.length===0||state.after>=end||metadata.every(row=>row.uid<=state.after))state.after=end;
   if(state.after>=state.highwater)advance();
  }finally{lock.release();}
 }
 return {upserts,tombstones:[],next_cursor:JSON.stringify(state),has_more:hasMore,source_bytes:sourceBytes,folder:selected.key,commit:()=>commitCache(cachePath,entries,cacheScope)};
}
