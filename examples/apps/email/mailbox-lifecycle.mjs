import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {MailInventory} from './mail-inventory.mjs';
import {MAIL_SYNC_LIMITS,stagedWireRow,resolveMailboxFolders} from './mailbox-sync.mjs';
import {attachmentPolicy,collectEmailAttachments} from './email-attachments.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded=(value,max)=>String(value??'').replace(/[\r\n\0]/g,' ').slice(0,max);
const address=rows=>(rows??[]).map(row=>row.name?`${row.name} <${row.address}>`:row.address).filter(Boolean).join(', ');
const date=value=>{if(value===undefined||value===null)return '';const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'':parsed.toISOString();};
function attachmentParts(node){let count=0;const visit=(node,depth)=>{if(!node||depth>16||count>128)throw Error();if(node.childNodes?.length)for(const child of node.childNodes)visit(child,depth+1);else if(node.disposition==='attachment'||node.parameters?.name||node.dispositionParameters?.filename||!['text/plain','text/html'].includes(node.type))count++;};try{visit(node,0);return count;}catch{return null;}}
function parseCursor(raw,namespace){
 if(raw===null)return {v:2,namespace,step:0,round:0,folder:0,after:0,validity:null,highwater:null};
 let value;try{if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)throw Error();value=JSON.parse(raw);}catch{throw Error('EMAIL_SYNC_CURSOR_INVALID');}
 if(Object.keys(value).sort().join(',')!=='after,folder,highwater,namespace,round,step,v,validity'||value.v!==2||value.namespace!==namespace||!Number.isSafeInteger(value.step)||value.step<0||!Number.isSafeInteger(value.round)||value.round<0||!Number.isInteger(value.folder)||value.folder<0||value.folder>2||!Number.isSafeInteger(value.after)||value.after<0||(value.validity!==null&&!/^\d{1,30}$/.test(value.validity))||(value.highwater!==null&&(!Number.isSafeInteger(value.highwater)||value.highwater<value.after)))throw Error('EMAIL_SYNC_CURSOR_INVALID');return value;
}
const tombstone=(namespace,folder,row)=>({id:`${folder}:${row.validity}:${row.uid}`,revision:hash({domain:'email.removal.v1',namespace,folder,validity:row.validity,uid:row.uid,prior:row.revision})});

// A complete successful bounded UID FETCH is authoritative for absence inside
// that range only. The iterator must reach its tagged OK; errors never prepare.
export const LIFECYCLE_PAGE_LIMITS=Object.freeze({items:100,windows:16,scan_ms:10000});
export async function readMailboxLifecyclePage(client,{request,inventoryPath,cacheScope,configuredFolders,onProgress,clock=Date.now}){
 if(!request||!Number.isInteger(request.max_items)||request.max_items<1||request.max_items>100)throw Error('EMAIL_SYNC_REQUEST_INVALID');
 const deadline=clock()+LIFECYCLE_PAGE_LIMITS.scan_ms,inventory=new MailInventory(inventoryPath,cacheScope);
 const scanController=new AbortController();let expired=false;const deadlineTimer=setTimeout(()=>{expired=true;scanController.abort();client.close?.();},LIFECYCLE_PAGE_LIMITS.scan_ms);
 try{
  const namespace=inventory.begin(request.cursor),state=parseCursor(request.cursor,namespace.id),folders=await resolveMailboxFolders(client,configuredFolders),selected=folders[state.folder],policy=attachmentPolicy(request.attachments);
  const upserts=[],tombstones=[],puts=[],removed=[],budget={count:0,bytes:0},limit=request.max_items;let sourceBytes=0,hasMore=true,windows=0;
  const advance=()=>{state.folder++;state.after=0;state.validity=null;state.highwater=null;if(state.folder===3){state.folder=0;state.round++;hasMore=false;}};
  if(selected.path===null){advance();} // Missing folder proves nothing about old IDs.
  else{
   if(namespace.paths[selected.key]!==undefined&&namespace.paths[selected.key]!==selected.path)throw Error('EMAIL_MAILBOX_PATH_CHANGED_BASELINE_REQUIRED');namespace.paths[selected.key]=selected.path;
   const lock=await client.getMailboxLock(selected.path);try{
    const validity=String(client.mailbox.uidValidity),highwater=Math.max(0,client.mailbox.uidNext-1,inventory.highwater(namespace.id,selected.key,String(client.mailbox.uidValidity)));
    if(!/^\d{1,30}$/.test(validity))throw Error('EMAIL_SYNC_UID_INVALID');
    const assertEpoch=()=>{if(String(client.mailbox.uidValidity)!==validity)throw Error('EMAIL_MAILBOX_EPOCH_CHANGED');};
    if(state.validity!==validity){state.after=0;state.highwater=highwater;state.validity=validity;}if(state.highwater===null)state.highwater=highwater;
    const old=inventory.oldEpoch(namespace.id,selected.key,validity,limit);
    if(old.length){for(const row of old){tombstones.push(tombstone(namespace.id,selected.key,row));removed.push(row);}assertEpoch();}
    else{
     let stop=false;
     while(!stop&&state.after<state.highwater&&windows<LIFECYCLE_PAGE_LIMITS.windows&&upserts.length+tombstones.length<limit&&clock()<deadline){
     await onProgress?.(scanController.signal);assertEpoch();if(clock()>=deadline)break;
     const end=Math.min(state.highwater,state.after+MAIL_SYNC_LIMITS.uid_window),metadata=[];windows++;
     if(end>state.after)for await(const row of client.fetch(`${state.after+1}:${end}`,{uid:true,envelope:true,flags:true,size:true,internalDate:true,bodyStructure:true},{uid:true})){if(!Number.isSafeInteger(row.uid)||row.uid<=state.after||row.uid>end||metadata.some(item=>item.uid===row.uid))throw Error('EMAIL_SYNC_UID_INVALID');metadata.push(row);}
     assertEpoch();const known=new Map(inventory.range(namespace.id,selected.key,validity,state.after+1,end).map(row=>[row.uid,row])),present=new Map(metadata.map(row=>[row.uid,row])),uids=[...new Set([...known.keys(),...present.keys()])].sort((a,b)=>a-b);
     for(const uid of uids){
      if(upserts.length+tombstones.length>=limit||clock()>=deadline){stop=true;break;}const row=present.get(uid),prior=known.get(uid);
      if(!row){const item={...prior,folder:selected.key,validity};tombstones.push(tombstone(namespace.id,selected.key,item));removed.push(item);state.after=uid;continue;}
      const id=`${selected.key}:${validity}:${uid}`,flags=[...(row.flags??[])].sort(),metadataDigest=hash({projection:'email.metadata.v2',policy,id,size:row.size,envelope:row.envelope,flags,date:date(row.internalDate),structure:row.bodyStructure});
      if(prior?.digest===metadataDigest){state.after=uid;continue;}
      let parsed,source,bodyStatus='oversize';
      if(Number.isSafeInteger(row.size)&&row.size>=0&&row.size<=MAIL_SYNC_LIMITS.source_bytes){if(sourceBytes+row.size+1>MAIL_SYNC_LIMITS.page_source_bytes){stop=true;break;}const fetched=await client.fetchOne(uid,{source:{start:0,maxLength:row.size+1}},{uid:true});sourceBytes+=fetched?.source?.byteLength??0;assertEpoch();if(fetched?.uid===uid&&fetched.source?.byteLength===row.size){source=fetched.source;try{parsed=await simpleParser(source);bodyStatus='available';}catch{bodyStatus='unavailable';}}else bodyStatus='unavailable';}
      const trial={...budget},{attachments,skipped,original_downloadable_count,...body}=collectEmailAttachments(parsed,policy,trial),partCount=attachmentParts(row.bodyStructure);
      if(parsed&&body.body_truncated)bodyStatus='truncated';const attachmentCount=parsed?parsed.attachments.length:partCount??0;
      const data={subject:bounded(parsed?.subject??row.envelope?.subject??'(no subject)',200),...body,sender:bounded(parsed?.from?.text??address(row.envelope?.from),200),recipients:bounded(parsed?.to?.text??address(row.envelope?.to),200),message_id:bounded(parsed?.messageId??row.envelope?.messageId,200),in_reply_to:bounded(parsed?.inReplyTo??row.envelope?.inReplyTo,200),references:bounded(Array.isArray(parsed?.references)?parsed.references.join(' '):parsed?.references,1000),resource_id:id,uidvalidity:validity,mailbox:selected.path,folder:selected.key,date:date(parsed?.date??row.envelope?.date??row.internalDate),seen:flags.includes('\\Seen'),answered:flags.includes('\\Answered'),flagged:flags.includes('\\Flagged'),attachment_count:attachmentCount,downloadable_attachment_count:original_downloadable_count,skipped_attachment_count:parsed?skipped:attachmentCount,attachment_metadata_complete:parsed!==undefined||partCount!==null,body_status:bodyStatus};
      const revision=createHash('sha256').update(metadataDigest).update(source??Buffer.alloc(0)).digest('hex'),candidate={id,revision,data,attachments};
      if(Buffer.byteLength(JSON.stringify(stagedWireRow(candidate)))>MAIL_SYNC_LIMITS.record_bytes)throw Error('EMAIL_RECORD_WIRE_BUDGET');
      if(Buffer.byteLength(JSON.stringify({upserts:[...upserts,candidate].map(stagedWireRow),tombstones}))>MAIL_SYNC_LIMITS.page_bytes-4096){stop=true;break;}
      Object.assign(budget,trial);upserts.push(candidate);puts.push({folder:selected.key,validity,uid,digest:metadataDigest,revision});state.after=uid;await onProgress?.(scanController.signal);assertEpoch();
     }
     if(uids.every(uid=>uid<=state.after))state.after=end;assertEpoch();
     }
     if(state.after>=state.highwater)advance();assertEpoch();
    }
   }finally{lock.release();}
  }
  if(expired)throw Error('EMAIL_SYNC_SCAN_DEADLINE');
  state.step++;const next_cursor=JSON.stringify(state),pageId=inventory.prepare({namespace:namespace.id,paths:namespace.paths,input_cursor:request.cursor,next_cursor,upserts:puts,removed});
  let closed=false;const close=()=>{if(!closed){closed=true;inventory.close();}};
  return {upserts,tombstones,next_cursor,has_more:hasMore,source_bytes:sourceBytes,metadata_windows:windows,folder:selected.key,commit:()=>{try{inventory.acknowledge(pageId);}finally{close();}},close};
 }catch(error){inventory.close();throw error;}finally{clearTimeout(deadlineTimer);}
}
