import {createTriageApiTransport,triageLocator,validateTriageOperation,sameTriageState} from './triage-contract.mjs';
import {fail,pathId,text} from './contract.mjs';
const base='https://gmail.googleapis.com/gmail/v1/users/me';
const reserved=new Set(['INBOX','UNREAD','STARRED','TRASH','SPAM','SENT','DRAFT','IMPORTANT','CHAT']);
function state(locator,data){if(data.id!==locator.message_id||!Array.isArray(data.labelIds)||data.labelIds.length>100||data.labelIds.some(value=>typeof value!=='string'||!value||value.length>256)||new Set(data.labelIds).size!==data.labelIds.length)fail('EMAIL_TRIAGE_RESPONSE_UNKNOWN',{outcome:'uncertain'});return {locator:{...locator,label_ids:[...data.labelIds].sort()},label_ids:[...data.labelIds].sort()};}
export function createGmailTriageAdapter(options){
 const api=createTriageApiTransport(options);if(api.binding.account.provider!=='gmail')fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');
 const locator=input=>triageLocator(input,'gmail');
 async function readState(input,operation,guard){const value=locator(input);return state(value,await api.request(`${base}/messages/${pathId(value.message_id)}?format=minimal`,{operation,guard}));}
 async function labels(operation){const data=await api.request(`${base}/labels`,{operation});if(!Array.isArray(data.labels)||data.labels.length>10000)fail('EMAIL_TRIAGE_RESPONSE_INVALID');return new Set(data.labels.filter(row=>row.type==='user').map(row=>text(row.id,256)));}
 async function modify(before,add,remove,operation,guard,reserve){const value=before.locator,data=await api.request(`${base}/messages/${pathId(value.message_id)}/modify`,{operation,method:'POST',body:{addLabelIds:add,removeLabelIds:remove},headers:{'Content-Type':'application/json'},guard,reserve});return {after:state(value,data),undo_supported:true};}
 async function apply({operation:input,before,guard,reserve}){
  const operation=validateTriageOperation(input),kind=operation.kind,value=locator(before.locator);let add=[],remove=[];
  if(kind==='permanent_delete'){await api.request(`${base}/messages/${pathId(value.message_id)}`,{operation:kind,method:'DELETE',guard,reserve});return {after:null,undo_supported:false};}
  if(kind==='trash'||kind==='restore'){if(operation.destination!==undefined)fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');const data=await api.request(`${base}/messages/${pathId(value.message_id)}/${kind==='trash'?'trash':'untrash'}`,{operation:kind,method:'POST',guard,reserve});return {after:state(value,data),undo_supported:true};}
  if(kind==='mark_read')remove=['UNREAD'];else if(kind==='mark_unread')add=['UNREAD'];else if(kind==='flag')add=['STARRED'];else if(kind==='unflag')remove=['STARRED'];else if(kind==='archive')remove=['INBOX'];else if(kind==='spam'){add=['SPAM'];remove=['INBOX'];}else if(kind==='not_spam'){if(operation.destination!==undefined)fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');add=['INBOX'];remove=['SPAM'];}
  else if(kind==='labels'){const allowed=await labels(kind);if([...operation.add_labels,...operation.remove_labels].some(label=>reserved.has(label)||!allowed.has(label)))fail('EMAIL_TRIAGE_LABEL_DENIED');add=operation.add_labels;remove=operation.remove_labels;}
  else if(kind==='move'){const allowed=await labels(kind);if(operation.destination!=='INBOX'&&!allowed.has(operation.destination))fail('EMAIL_TRIAGE_LABEL_DENIED');add=[operation.destination];if(operation.destination!=='INBOX')remove=['INBOX'];}
  return modify(before,add,remove,kind,guard,reserve);
 }
 async function undo({before,after,operation,guard,reserve}){const current=await readState(after.locator,operation.kind,guard);if(!sameTriageState(current,after))fail('EMAIL_TRIAGE_UNDO_CONFLICT');return modify(current,before.label_ids.filter(label=>!after.label_ids.includes(label)),after.label_ids.filter(label=>!before.label_ids.includes(label)),operation.kind,guard,reserve);}
 async function listDestinations(operation='move'){const allowed=await labels(operation);return {special_folders:{inbox:'INBOX',trash:'TRASH',spam:'SPAM',archive:null},destinations:[...allowed].sort().map(id=>({id,kind:'label'})),complete:true};}
 return Object.freeze({provider:'gmail',readState,apply,undo,listDestinations});
}
