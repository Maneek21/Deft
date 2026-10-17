import {validateTriageBinding,triageLocator,validateTriageOperation,sameTriageState} from './triage-contract.mjs';
import {fail,text,MailProviderError} from './contract.mjs';

/** Only deployment-declared capabilities backed by current server capabilities.
 * No fallback COPY+global EXPUNGE and no inferred special-folder names. */
export function createImapTriageAdapter({binding:raw,connect,withAuthorizedClient,assertAuthority,declaration,resolveDeclaration,beforeMove}){
 const binding=validateTriageBinding(raw);if(binding.account.provider!=='imap_smtp'||typeof connect!=='function'&&typeof withAuthorizedClient!=='function'||typeof assertAuthority!=='function')fail('EMAIL_TRIAGE_AUTHORITY_REQUIRED');
 if(!declaration||Object.keys(declaration).some(key=>!['flags','keywords','move','uid_expunge','folders'].includes(key))||!declaration.folders||!Array.isArray(declaration.keywords)||declaration.keywords.length>100||declaration.keywords.some(value=>typeof value!=='string'||!/^[-a-zA-Z0-9_.$]+$/.test(value)))fail('EMAIL_TRIAGE_IMAP_DECLARATION_INVALID');
 const declared=structuredClone(declaration);
 const authority=async operation=>{if(!binding.operations.includes(operation)||binding.account.health!=='connected'||await assertAuthority({binding:structuredClone(binding),operation})!==true)fail('EMAIL_TRIAGE_AUTHORITY_STALE');};
 async function withClient(operation,fn,resolveFolders=false){await authority(operation);let client;try{
  const work=async selected=>{if(selected?.secureConnection!==true)fail('EMAIL_TRIAGE_IMAP_TLS_REQUIRED');await authority(operation);const effective=resolveDeclaration&&resolveFolders?await resolveDeclaration(selected):declared;const result=await fn(selected,effective);await authority(operation);return result;};
  if(withAuthorizedClient)return await withAuthorizedClient({binding:structuredClone(binding),operation},work);
  client=await connect({binding:structuredClone(binding),operation});return await work(client);
 }catch(error){if(error instanceof MailProviderError)throw error;fail('EMAIL_TRIAGE_IMAP_UNKNOWN',{outcome:'uncertain'});}finally{try{await client?.logout();}catch{client?.close?.();}}}
 function capability(client,name){return client.capabilities?.has(name)===true;}
 async function selected(client,input,fn){const locator=triageLocator(input,'imap_smtp'),lock=await client.getMailboxLock(locator.mailbox);try{if(String(client.mailbox?.uidValidity)!==locator.uidvalidity)fail('EMAIL_TRIAGE_LOCATOR_STALE');if(client.mailbox?.readOnly===true)fail('EMAIL_TRIAGE_IMAP_READONLY');return await fn(locator);}finally{lock.release();}}
 async function read(client,locator){const row=await client.fetchOne(locator.uid,{uid:true,flags:true,modseq:true},{uid:true});if(!row||row.uid!==locator.uid||!(row.flags instanceof Set)||row.flags.size>100)fail('EMAIL_TRIAGE_NOT_FOUND');return {locator,flags:[...row.flags].map(value=>text(value,256)).sort(),modseq:row.modseq===undefined?null:String(row.modseq)};}
 async function readState(locator,operation,guard=async()=>{}){return withClient(operation,client=>selected(client,locator,async value=>{await guard();return read(client,value);}));}
 async function mutate({before,operation,guard=async()=>{},reserve,restore=null}){
  if(typeof reserve!=='function')fail('EMAIL_TRIAGE_RESERVATION_REQUIRED');
  return withClient(operation.kind,async(client,declared)=>{
   let destination=null,moved=null;
   const result=await selected(client,before.locator,async locator=>{
    const current=await read(client,locator);if(!sameTriageState(current,before))fail('EMAIL_TRIAGE_CONFLICT');await authority(operation.kind);
    if(operation.kind==='permanent_delete'){
     if(declared.uid_expunge!==true||!capability(client,'UIDPLUS'))fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');await guard();await reserve();const accepted=await client.messageDelete(locator.uid,{uid:true});if(accepted!==true)fail('EMAIL_TRIAGE_IMAP_UNKNOWN',{outcome:'uncertain'});await authority(operation.kind);await guard();return {after:null,undo_supported:false};
    }
    if(restore?.destination||['archive','trash','spam','restore','not_spam','move'].includes(operation.kind)){
     if(declared.move!==true||!capability(client,'MOVE')||!capability(client,'UIDPLUS'))fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');
     destination=restore?.destination??operation.destination??declared.folders[operation.kind==='restore'||operation.kind==='not_spam'?'inbox':operation.kind];
     text(destination,256);if(!Object.values(declared.folders).includes(destination))fail('EMAIL_TRIAGE_FOLDER_DENIED');
     await guard();if(beforeMove)await beforeMove({before_locator:locator,destination,declaration:declared});await reserve();moved=await client.messageMove(locator.uid,destination,{uid:true});await authority(operation.kind);await guard();
     const uid=moved?.uidMap?.get(locator.uid),validity=moved?.uidValidity;
     if(!Number.isSafeInteger(uid)||uid<1||!/^\d{1,30}$/.test(String(validity)))fail('EMAIL_TRIAGE_MOVE_RESULT_UNKNOWN',{outcome:'uncertain'});
     return {locator:{kind:'imap_smtp',mailbox:destination,uidvalidity:String(validity),uid}};
    }
    if(declared.flags!==true)fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');let add=[],remove=[];
    if(restore){add=restore.flags.filter(flag=>!before.flags.includes(flag));remove=before.flags.filter(flag=>!restore.flags.includes(flag));}
    else if(operation.kind==='mark_read')add=['\\Seen'];else if(operation.kind==='mark_unread')remove=['\\Seen'];else if(operation.kind==='flag')add=['\\Flagged'];else if(operation.kind==='unflag')remove=['\\Flagged'];else if(operation.kind==='labels'){add=operation.add_labels;remove=operation.remove_labels;if([...add,...remove].some(flag=>!declared.keywords.includes(flag)||!client.mailbox?.permanentFlags?.has('\\*')&&!client.mailbox?.permanentFlags?.has(flag)))fail('EMAIL_TRIAGE_LABEL_DENIED');}else fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');
    // One conditional STORE command; two independent writes would make partial
    // flag updates unknowable. It preserves all unrelated current flags.
    const flags=[...new Set([...before.flags.filter(flag=>!remove.includes(flag)),...add])].sort();
    if(current.modseq===null||!capability(client,'CONDSTORE'))fail('EMAIL_TRIAGE_CONDITIONAL_FLAGS_UNSUPPORTED');
    await guard();await reserve();const accepted=await client.messageFlagsSet(locator.uid,flags,{uid:true,unchangedSince:BigInt(current.modseq)});
    if(accepted!==true)fail('EMAIL_TRIAGE_IMAP_UNKNOWN',{outcome:'uncertain'});await authority(operation.kind);await guard();return {after:await read(client,locator),undo_supported:true};
   });
   if(destination){return selected(client,result.locator,async locator=>({after:await read(client,locator),undo_supported:true}));}
   return result;
  },!!restore?.destination||['archive','trash','spam','restore','not_spam','move'].includes(operation.kind));
 }
 async function apply(input){return mutate({...input,operation:validateTriageOperation(input.operation)});}
 async function undo({before,after,operation,guard,reserve}){const current=await readState(after.locator,operation.kind,guard);if(!sameTriageState(current,after))fail('EMAIL_TRIAGE_UNDO_CONFLICT');return mutate({before:current,operation,guard,reserve,restore:{flags:before.flags,...(before.locator.mailbox!==after.locator.mailbox?{destination:before.locator.mailbox}:{})}});}
 async function listDestinations(operation='move'){return withClient(operation,async(client,declared)=>{const rows=await client.list();if(!Array.isArray(rows)||rows.length>1000)fail('EMAIL_TRIAGE_RESPONSE_INVALID');const present=new Set(rows.map(row=>row.path)),folders=Object.fromEntries(Object.entries(declared.folders).filter(([,path])=>present.has(path)));return {special_folders:folders,destinations:[...new Set(Object.values(folders))].map(id=>({id,kind:'folder'})),complete:true};},true);}
 return Object.freeze({provider:'imap_smtp',readState,apply,undo,listDestinations});
}
