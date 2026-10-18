import {nativeOwnerCapabilities} from './native-owner-consent.mjs';
import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {createOutgoingSnapshotService} from '../outgoing-snapshot.mjs';
import {validateEmailAccount} from '../account-registry.mjs';
import {singleAddress} from '../account-config.mjs';
import {createNativeEmailTriageBridge} from './native-triage.mjs';
import {createImapTriageAdapter} from './triage-imap.mjs';
import {createNativeImapSentCopyBridge} from './native-imap-sent-copy.mjs';
import {digest,fail} from './contract.mjs';

export const NATIVE_SMTP_LIMITS=Object.freeze({mime_bytes:36*1024*1024,recipients:200,folders:512,folder_bytes:1048576});
const safe=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const exact=(value,fields)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))fail('EMAIL_NATIVE_AUTHORITY_DENIED');};
const nativeFields=['account_id','provider','resource_binding_id','authority_epoch','connection_revision','principal_digest','health','capabilities','primary_address','display_label'];
const scopeFields=['org_id','owner_user_id','installation_id'];
const accountFields=[...nativeFields,...scopeFields,'connection_target','action_binding_id','verified_sender_identities'];
const nativeView=account=>Object.fromEntries(nativeFields.map(key=>[key,structuredClone(account[key])]));

/** Host-only encrypted-custody ports:
 * current(context,purpose='read') -> native account + org/owner/installation;
 * modify/send additionally include connection_target, action_binding_id and
 * verified_sender_identities from the enrolled host descriptor.
 * withAuthorizedClient(context,nativeAccount,work,purpose='modify') owns TLS,
 * encrypted IMAP profile, pinned public DNS, deadlines and final cleanup.
 * withAuthorizedSmtp(context,nativeAccount,work) owns encrypted SMTP profile,
 * mandatory verified TLS, pinned DNS and cleanup; work receives {sendMail,close}.
 * Both ports recheck exact principal/revision before/after I/O. No legacy
 * plaintext account-config or HTTP caller envelope supplies credential authority.
 */
export function createNativeImapEffectsBridge({host,now=Date.now,monotonic=()=>performance.now()}){
 if(typeof host?.current!=='function'||typeof host?.withAuthorizedClient!=='function'||typeof host?.withAuthorizedSmtp!=='function')fail('EMAIL_NATIVE_IMAP_HOST_REQUIRED');
 async function runtime(context,purpose='modify'){
  nativeOwnerCapabilities(context);
  const fields=[...scopeFields,'account_id','resource_binding_id','authority_version','expires_at','recheck','signal','provider_state','imap_aliases','owner_capabilities',
   ...(purpose==='modify'?['triage_journal','triage_before_reserve']:purpose==='send'?['send_before_reserve']:purpose==='sent_copy'?['sent_copy_journal','sent_copy_before_append']:[])];
  exact(context,fields);if([...scopeFields,'account_id','resource_binding_id','authority_version'].some(key=>!safe(context[key]))||typeof context.recheck!=='function'
   ||!Number.isSafeInteger(context.expires_at)||context.expires_at<=now()||context.signal!==undefined&&!(context.signal instanceof AbortSignal))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
  const started=now(),received=monotonic(),live=()=>{context.signal?.throwIfAborted();if(context.expires_at<=Math.max(now(),started+Math.max(0,monotonic()-received)))fail('EMAIL_NATIVE_AUTHORITY_DENIED');};
  const checkSql=async()=>{live();await context.recheck();live();};
  // Accepted-copy policy and uncertain-copy inspection are reads. The APPEND
  // branch acquires the separate modify host port immediately before effect.
  const hostPurpose=purpose==='sent_copy'?'read':purpose;
  const current=async()=>{await checkSql();const row=structuredClone(await host.current(context,hostPurpose));await checkSql();exact(row,accountFields);
   if([...scopeFields,'account_id','resource_binding_id'].some(key=>row[key]!==context[key])||row.provider!=='imap_smtp'||row.health!=='connected'
    ||!Number.isSafeInteger(row.authority_epoch)||row.authority_epoch<1||!Number.isSafeInteger(row.connection_revision)||row.connection_revision<1
    ||!/^[a-f0-9]{64}$/u.test(row.principal_digest??'')||!Array.isArray(row.capabilities)||row.capabilities.length>6||new Set(row.capabilities).size!==row.capabilities.length
    ||row.capabilities.some(value=>!['read','search','thread','send','modify','permanent_delete'].includes(value))
    ||!row.capabilities.includes(hostPurpose==='modify'?'modify':hostPurpose==='send'?'send':'read')||!singleAddress(row.primary_address)||!safe(row.display_label))fail('EMAIL_NATIVE_AUTHORITY_DENIED');
   if(hostPurpose!=='read')validateEmailAccount(Object.fromEntries(['account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch','health','capabilities','primary_address','display_label','verified_sender_identities'].map(key=>[key,row[key]])));
   return row;
  };
  const descriptor=await current(),fingerprint=digest(descriptor),check=async()=>{if(digest(await current())!==fingerprint)fail('EMAIL_NATIVE_AUTHORITY_DENIED');};
  const account=hostPurpose==='read'?nativeView(descriptor):validateEmailAccount(Object.fromEntries(['account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch','health','capabilities','primary_address','display_label','verified_sender_identities'].map(key=>[key,descriptor[key]])));
  return {account,descriptor,native:nativeView(descriptor),check,scope:{org_id:context.org_id,owner_id:context.owner_user_id,installation_id:context.installation_id}};
 }
 const triage=createNativeEmailTriageBridge({runtime,now,adapterFor:async({binding,value,context,input})=>createImapTriageAdapter({binding,
  declaration:{flags:true,keywords:[],move:true,uid_expunge:false,folders:{}},assertAuthority:async()=>{await value.check();return true;},
  beforeMove:async({before_locator,destination,declaration})=>{
   if(typeof context.imap_aliases?.reserve!=='function'||!declaration.folder_roles?.[destination])fail('EMAIL_IMAP_MOVE_ALIAS_REQUIRED');
   await value.check();try{await context.imap_aliases.reserve({operation_id:input.mode==='undo'?input.undo_operation_id:input.operation_id,before_locator,destination_mailbox:destination,destination_folders:declaration.folder_roles[destination]});}
   catch(error){if(['EMAIL_IMAP_MOVE_ALIAS_LIMIT','EMAIL_IMAP_MOVE_BUSY','EMAIL_IMAP_MOVE_SOURCE_CHANGED','EMAIL_IMAP_MOVE_PROOF_INVALID'].includes(error?.code))fail(error.code,{outcome:'no_effect'});throw error;}await value.check();
  },
  withAuthorizedClient:async(_request,work)=>host.withAuthorizedClient(context,value.native,async client=>{if(!client?.authenticated||client.secureConnection!==true)fail('EMAIL_NATIVE_IMAP_TLS_REQUIRED');await value.check();const result=await work(client);await value.check();return result;},'modify'),
  resolveDeclaration:async client=>{await value.check();const rows=await client.list();await value.check();
   if(!Array.isArray(rows)||rows.length>NATIVE_SMTP_LIMITS.folders||Buffer.byteLength(JSON.stringify(rows))>NATIVE_SMTP_LIMITS.folder_bytes)fail('EMAIL_TRIAGE_RESPONSE_INVALID');
   const folders={},folder_roles={},paths=new Set();for(const row of rows){if(!row||!safe(row.path,256)||row.flags!==undefined&&(!(row.flags instanceof Set)||row.flags.size>100))fail('EMAIL_TRIAGE_RESPONSE_INVALID');if(row.flags?.has('\\Noselect')||row.flags?.has('\\NonExistent'))continue;
    if(paths.has(row.path))fail('EMAIL_TRIAGE_RESPONSE_INVALID');paths.add(row.path);folders['folder_'+digest(row.path)]=row.path;
    const roles=new Set([row.specialUse,...(row.flags??[])]);for(const [role,name]of [['\\Archive','archive'],['\\Trash','trash']])if(roles.has(role)){if(folders[name]&&folders[name]!==row.path)fail('EMAIL_TRIAGE_FOLDER_DENIED');folders[name]=row.path;}
    if(row.path.toUpperCase()==='INBOX')folders.inbox=row.path;
    const normalized=[];if(row.path.toUpperCase()==='INBOX')normalized.push('inbox');for(const [role,name]of [['\\Sent','sent'],['\\Junk','spam'],['\\Trash','trash'],['\\Drafts','drafts'],['\\Archive','archive'],['\\All','all'],['\\Flagged','starred']])if(roles.has(role))normalized.push(name);
    folder_roles[row.path]=normalized.length?normalized:['folder:'+digest({kind:'native_imap_folder_v1',path:row.path})];
   }return {flags:true,keywords:[],move:true,uid_expunge:false,folders,folder_roles};
  }} )});
 return Object.freeze({
  ...triage,
  ...createNativeImapSentCopyBridge({host,runtime,now}),
  async nativeEmailAccount(context){return nativeView((await runtime(context,'read')).descriptor);},
  nativeEmailSnapshotFactory(ports){exact(ports,['resolve','seal','verify','reserve']);if(['resolve','seal','verify','reserve'].some(key=>typeof ports[key]!=='function'))fail('EMAIL_NATIVE_SEND_INPUT_INVALID');return createOutgoingSnapshotService({...ports,profile:'native'});},
  async nativeEmailSendIdentity(context){const value=await runtime(context,'send');await value.check();if(!value.account.action_binding_id||!value.account.verified_sender_identities.length)fail('EMAIL_NATIVE_SEND_AUTHORITY_DENIED');return {...value.descriptor};},
  async nativeEmailSend(input,context){
   exact(input,['operation_id','mime_bytes','mime_digest','from_address','envelope']);
   if(typeof input.operation_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(input.operation_id)
    ||!(input.mime_bytes instanceof Uint8Array)||!input.mime_bytes.length||input.mime_bytes.length>NATIVE_SMTP_LIMITS.mime_bytes||!/^[a-f0-9]{64}$/u.test(input.mime_digest??'')
    ||typeof context?.send_before_reserve!=='function'||!singleAddress(input.from_address))fail('EMAIL_NATIVE_SEND_INPUT_INVALID');
   exact(input.envelope,['from','to']);const envelope=structuredClone(input.envelope);
   if(envelope.from!==input.from_address||!Array.isArray(envelope.to)||!envelope.to.length||envelope.to.length>NATIVE_SMTP_LIMITS.recipients
    ||envelope.to.some(value=>!singleAddress(value))||new Set(envelope.to.map(value=>value.toLowerCase())).size!==envelope.to.length)fail('EMAIL_NATIVE_SEND_INPUT_INVALID');
   const bytes=Buffer.from(input.mime_bytes);let parsed;
   try{
    if(createHash('sha256').update(bytes).digest('hex')!==input.mime_digest)fail('EMAIL_PROVIDER_MIME_CHANGED');const value=await runtime(context,'send');await value.check();
    if(!value.account.verified_sender_identities.includes(input.from_address))fail('EMAIL_NATIVE_SEND_SENDER_DENIED');
    parsed=await simpleParser(bytes,{skipHtmlToText:true,skipTextToHtml:true});
    if(parsed.headerLines?.filter(row=>row.key==='from').length!==1||parsed.from?.value?.length!==1||parsed.from.value[0].address!==input.from_address
     ||parsed.sender?.value?.some(row=>row.address!==input.from_address)||parsed.headerLines?.some(row=>row.key==='bcc')
     ||[parsed.to,parsed.cc].flatMap(field=>field?.value??[]).some(row=>!singleAddress(row.address)||!envelope.to.includes(row.address)))fail('EMAIL_NATIVE_SEND_SENDER_DENIED');
    await value.check();const nomination=Object.freeze({account_id:value.account.account_id,authority_epoch:value.account.authority_epoch,operation_id:input.operation_id,mime_digest:input.mime_digest});
    // No automatic retry. The host callback verifies its already reserved sealed
    // snapshot, including this envelope; it does not create another reservation.
    const result=await host.withAuthorizedSmtp(context,value.native,async transport=>{
     if(typeof transport?.sendMail!=='function')fail('EMAIL_NATIVE_SMTP_HOST_REQUIRED');await value.check();
     if(await context.send_before_reserve(nomination)!==true)fail('EMAIL_PROVIDER_SEND_ALREADY_RESERVED');await value.check();let accepted;
     try{accepted=await transport.sendMail({raw:bytes,envelope});}catch{fail('EMAIL_NATIVE_SEND_RESULT_UNKNOWN',{outcome:'uncertain'});}
     await value.check();if(!Array.isArray(accepted?.accepted)||accepted.accepted.length!==envelope.to.length||accepted.rejected?.length||accepted.pending?.length
      ||new Set(accepted.accepted.map(row=>typeof row==='string'?row.toLowerCase():null)).size!==envelope.to.length
      ||accepted.accepted.some(row=>typeof row!=='string'||!envelope.to.some(to=>to.toLowerCase()===row.toLowerCase())))fail('EMAIL_NATIVE_SEND_RESULT_UNKNOWN',{outcome:'uncertain'});
     return {schema_version:'deft.email_send_result.v1',account_id:value.account.account_id,provider:'imap_smtp',operation_id:input.operation_id,
      provider_message_id:null,transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'};
    });await value.check();return result;
   }finally{bytes.fill(0);for(const part of parsed?.attachments??[])part.content?.fill(0);}
  }
 });
}
