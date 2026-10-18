import {createHash} from 'node:crypto';
import {digest,fail,PROVIDER_LIMITS} from './contract.mjs';
import {triageDigest} from './triage-contract.mjs';
const MAX_MIME=35*1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safe=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const decimal=value=>/^[1-9]\d{0,29}$/u.test(value);
const uid=value=>Number.isSafeInteger(value)&&value>=1&&value<=4294967295;
/** Host-only accepted SMTP copy. A started/unknown APPEND is inspected only;
 * this module has no SMTP transport and cannot retransmit an accepted send. */
export function createNativeImapSentCopyBridge({host,runtime,now=Date.now}){
 return Object.freeze({
  async nativeEmailSentCopySettings(context){
   const value=await runtime(context,'read');await value.check();if(typeof host.sentCopyMode!=='function')fail('EMAIL_SENT_COPY_POLICY_INVALID');const mode=await host.sentCopyMode(context,value.native);await value.check();
   if(!['server_managed','append'].includes(mode))fail('EMAIL_SENT_COPY_POLICY_INVALID');const base={account_id:value.account.account_id,revision:value.native.connection_revision,sent_copy_mode:mode,provider:'imap_smtp'};
   if(!value.account.capabilities.includes('modify'))return {...base,append_available:false,reason:'modify_unavailable'};
   let available=false;try{available=await host.withAuthorizedClient(context,value.native,async client=>{
    if(!client.authenticated||client.secureConnection!==true)fail('EMAIL_NATIVE_IMAP_TLS_REQUIRED');await value.check();const rows=await client.list();await value.check();
    if(!Array.isArray(rows)||rows.length>512||Buffer.byteLength(JSON.stringify(rows))>1048576)fail('EMAIL_SENT_COPY_FOLDER_LIMIT');const sent=rows.filter(row=>safe(row?.path,2048)&&row.flags instanceof Set&&!row.flags.has('\\Noselect')&&!row.flags.has('\\NonExistent')&&(row.specialUse==='\\Sent'||row.flags.has('\\Sent')));if(sent.length!==1)return false;
    let lock;try{lock=await client.getMailboxLock(sent[0].path,{readOnly:false});await value.check();return client.mailbox?.path===sent[0].path&&client.mailbox.readOnly===false;}finally{lock?.release();}
   },'read');}catch{await value.check();return {...base,append_available:false,reason:'connection_unavailable'};}await value.check();return {...base,append_available:available,...(available?{}:{reason:'sent_folder_unavailable'})};
  },
  async nativeEmailSentCopy(input,context){
  if(!input||Object.keys(input).sort().join(',')!=='mime_bytes,mime_digest,operation_id'||!uuid(input.operation_id)||!(input.mime_bytes instanceof Uint8Array)
   ||!input.mime_bytes.length||input.mime_bytes.length>MAX_MIME||!/^[a-f0-9]{64}$/u.test(input.mime_digest??'')||typeof context?.sent_copy_before_append!=='function'
   ||!['load','create','change'].every(key=>typeof context?.sent_copy_journal?.[key]==='function')||typeof host.sentCopyMode!=='function')fail('EMAIL_SENT_COPY_INPUT_INVALID');
  const bytes=Buffer.from(input.mime_bytes);try{
   if(sha(bytes)!==input.mime_digest)fail('EMAIL_PROVIDER_MIME_CHANGED');const headerEnd=bytes.indexOf('\r\n\r\n');if(headerEnd<1||headerEnd>65536)fail('EMAIL_SENT_COPY_INPUT_INVALID');
   const headers=bytes.subarray(0,headerEnd).toString('utf8').replace(/\r\n[ \t]+/gu,' '),ids=[...headers.matchAll(/^message-id:[ \t]*(.+)$/gimu)];
   if(ids.length!==1||!/^<[^<>\s\u0000-\u001f\u007f]+>$/u.test(ids[0][1])||ids[0][1].length>256)fail('EMAIL_SENT_COPY_INPUT_INVALID');const messageId=ids[0][1];
   const value=await runtime(context,'sent_copy'),scope={org_id:context.org_id,owner_user_id:context.owner_user_id,account_id:context.account_id},journal=context.sent_copy_journal;
   const nomination={operation_id:input.operation_id,account_id:value.account.account_id,authority_epoch:value.account.authority_epoch,mime_digest:input.mime_digest};
   const guard=async()=>{await value.check();if(await context.sent_copy_before_append(nomination)!==true)fail('EMAIL_SENT_COPY_ACCEPTED_SEND_REQUIRED');await value.check();};
   await guard();const policy=await host.sentCopyMode(context,value.native);await guard();if(!['server_managed','append'].includes(policy))fail('EMAIL_SENT_COPY_POLICY_INVALID');
   const bindingDigest=digest([scope,context.installation_id,value.native.resource_binding_id,value.native.authority_epoch,value.native.connection_revision,value.native.principal_digest]);
   const result=outcome=>({schema_version:'deft.email_sent_copy_result.v1',account_id:scope.account_id,operation_id:input.operation_id,mime_digest:input.mime_digest,outcome});
   let previous=await journal.load(scope,input.operation_id);await guard();
   if(previous&&(previous.plan.principal_digest!==value.native.principal_digest||previous.plan.mime_digest!==input.mime_digest||previous.plan.byte_length!==bytes.length||previous.plan.message_id!==messageId
    ||previous.state==='prepared'&&(previous.plan.binding_digest!==bindingDigest||previous.plan.mode!==policy)))fail('EMAIL_SENT_COPY_PLAN_CONFLICT');
   if(previous&&['copied','failed','server_managed'].includes(previous.state))return result(previous.state);
   // Only inspection may cross a reviewed same-principal credential/preference
   // revision. It retains the original append plan and cannot append again.
   const mode=previous?.plan.mode??policy;
   if(mode==='server_managed'){
    const unsigned={schema_version:'deft.email_sent_copy_plan.v1',scope,operation_id:input.operation_id,binding_digest:bindingDigest,principal_digest:value.native.principal_digest,mime_digest:input.mime_digest,byte_length:bytes.length,mode,message_id:messageId,mailbox:null,uidvalidity:null,uidnext:null};
    await journal.create({...unsigned,digest:triageDigest(unsigned)});await guard();return result('server_managed');
   }
   const inspecting=previous&&['started','unknown'].includes(previous.state);
   if(!inspecting&&!value.account.capabilities.includes('modify'))fail('EMAIL_SENT_COPY_APPEND_UNAVAILABLE');
   const output=await host.withAuthorizedClient(context,value.native,async client=>{
    if(client?.secureConnection!==true||!client.authenticated)fail('EMAIL_NATIVE_IMAP_TLS_REQUIRED');let timer,onAbort,stream,lock;
    const interrupted=new Promise((_,reject)=>{const stop=()=>{try{stream?.destroy?.();client.close?.();}catch{}reject(Error('EMAIL_SENT_COPY_ABORTED'));};onAbort=stop;context.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(stop,Math.max(1,Math.min(PROVIDER_LIMITS.timeout_ms,context.expires_at-now())));});void interrupted.catch(()=>{});
    const bounded=async promise=>{context.signal?.throwIfAborted();const answer=await Promise.race([Promise.resolve(promise),interrupted]);context.signal?.throwIfAborted();return answer;};
    const check=async()=>bounded(guard());
    try{
     await check();const catalog=await bounded(client.list());await check();
     if(!Array.isArray(catalog)||catalog.length>512||Buffer.byteLength(JSON.stringify(catalog))>1048576)fail('EMAIL_SENT_COPY_FOLDER_LIMIT');
     const sent=catalog.filter(row=>safe(row?.path,2048)&&row.flags instanceof Set&&!row.flags.has('\\Noselect')&&!row.flags.has('\\NonExistent')&&(row.specialUse==='\\Sent'||row.flags.has('\\Sent')));
     if(sent.length!==1)return result('failed');const path=sent[0].path;lock=await bounded(client.getMailboxLock(path,{readOnly:Boolean(inspecting)}));await check();
     const validity=String(client.mailbox?.uidValidity),next=Number(client.mailbox?.uidNext);
     if(client.mailbox?.path!==path||!inspecting&&client.mailbox.readOnly!==false||!decimal(validity)||!Number.isSafeInteger(next)||next<1||next>4294967296)fail('EMAIL_SENT_COPY_MAILBOX_INVALID');
     if(!previous){const unsigned={schema_version:'deft.email_sent_copy_plan.v1',scope,operation_id:input.operation_id,binding_digest:bindingDigest,principal_digest:value.native.principal_digest,mime_digest:input.mime_digest,byte_length:bytes.length,mode,message_id:messageId,mailbox:path,uidvalidity:validity,uidnext:next};previous=await bounded(journal.create({...unsigned,digest:triageDigest(unsigned)}));await check();}
     if(previous.plan.mailbox!==path||previous.plan.uidvalidity!==validity){await journal.change(scope,input.operation_id,async(current,write)=>{if(current&&['started','unknown'].includes(current.state))await write({...current,state:'unknown',reason:'uidvalidity_changed'});});return result('unknown');}
     return bounded(journal.change(scope,input.operation_id,async(current,write)=>{
      if(!current||current.plan.digest!==previous.plan.digest)fail('EMAIL_SENT_COPY_PLAN_CONFLICT');if(['copied','failed','server_managed'].includes(current.state))return result(current.state);
      const save=async next=>{await write(next);current=structuredClone(next);};
      if(current.state==='prepared'){
       const limit=client.capabilities?.get?.('APPENDLIMIT');if(typeof limit==='number'&&(!Number.isSafeInteger(limit)||limit<bytes.length)){await save({...current,state:'failed',reason:'append_limit'});return result('failed');}
       await check();await save({...current,state:'started'});await check();let ack;
       try{ack=await bounded(client.append(path,bytes,['\\Seen']));}catch{await save({...current,state:'unknown',reason:'append_unknown'});return result('unknown');}
       await check();if(!ack||ack.path!==path||ack.uid!==undefined&&!uid(ack.uid)||ack.uidValidity!==undefined&&String(ack.uidValidity)!==validity){await save({...current,state:'unknown',reason:'append_unknown'});return result('unknown');}
       await save({...current,state:'copied',...(uid(ack.uid)?{copied_uid:ack.uid}:{})});await check();return result('copied');
      }
      // Inspect exact Message-ID candidates, then hash full BODY.PEEK bytes.
      // UID windows and candidates are persisted, so bounded continuation loses
      // neither earlier matches nor pending candidates after process restart.
      const scan=structuredClone(current.scan??{next_uid:current.plan.uidnext,end_uid:next-1,pending:[],matches:[]});scan.end_uid=Math.max(scan.end_uid,next-1);
      let windows=0,downloads=0;
      while(scan.matches.length<2&&(scan.pending.length||scan.next_uid<=scan.end_uid)&&windows<8&&downloads<4){
       await check();if(!scan.pending.length){const end=Math.min(scan.end_uid,scan.next_uid+4095),found=await bounded(client.search({uid:`${scan.next_uid}:${end}`,header:{'message-id':messageId}},{uid:true}));await check();
        if(!Array.isArray(found)||found.length>16||new Set(found).size!==found.length||found.some(id=>!uid(id)||id<scan.next_uid||id>end)){await save({...current,state:'unknown',reason:'inspection_limit',scan});return result('unknown');}
        scan.pending=found.sort((a,b)=>a-b);scan.next_uid=end+1;windows++;await save({...current,state:'unknown',scan});
       }
       if(!scan.pending.length)continue;const candidate=scan.pending[0];const row=await bounded(client.fetchOne(candidate,{uid:true,size:true},{uid:true}));await check();
       if(row&&row.uid===candidate&&row.size===bytes.length){const download=await bounded(client.download(candidate,undefined,{uid:true,maxBytes:MAX_MIME+1,chunkSize:65536}));stream=download?.content;
        if(download?.meta?.expectedSize!==row.size||typeof stream?.[Symbol.asyncIterator]!=='function'||typeof stream.destroy!=='function')fail('EMAIL_SENT_COPY_INSPECTION_INVALID');const hash=createHash('sha256');let size=0;
        const iterator=stream[Symbol.asyncIterator]();for(;;){await check();const chunk=await bounded(iterator.next());await check();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))fail('EMAIL_SENT_COPY_INSPECTION_INVALID');size+=chunk.value.length;if(size>row.size||size>MAX_MIME)fail('EMAIL_SENT_COPY_INSPECTION_INVALID');hash.update(chunk.value);chunk.value.fill(0);}
        stream.destroy();stream=null;if(size===row.size&&hash.digest('hex')===input.mime_digest&&!scan.matches.includes(candidate))scan.matches.push(candidate);
       }
       downloads++;scan.pending.shift();await save({...current,state:'unknown',scan});
      }
      await check();if(String(client.mailbox.uidValidity)!==validity)fail('EMAIL_SENT_COPY_MAILBOX_INVALID');
      if(scan.matches.length>1){await save({...current,state:'unknown',reason:'copy_ambiguous',scan});return result('unknown');}
      if(scan.pending.length||scan.next_uid<=scan.end_uid)return result('pending');
      if(scan.matches.length===1){await save({...current,state:'copied',copied_uid:scan.matches[0],scan});return result('copied');}
      await save({...current,state:'unknown',reason:'copy_not_found',scan});return result('unknown');
     }));
    }finally{clearTimeout(timer);context.signal?.removeEventListener('abort',onAbort);try{stream?.destroy?.();}finally{lock?.release();}}
   },inspecting?'read':'modify');await guard();return output;
  }finally{bytes.fill(0);}
 }});
}
