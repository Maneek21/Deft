import {sha256Hex} from './worker-sha256.mjs';
// Browser nominations only. Reviewed host and Runtime authority remain decisive.
export const EMAIL_TRIAGE_KINDS=Object.freeze(['mark_read','mark_unread','flag','unflag','archive','trash','restore','spam','not_spam','labels','move','permanent_delete']);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const fail=()=>{throw Error('EMAIL_TRIAGE_SELECTION_INVALID');};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\r\n\0,]/u.test(value);
function labels(values){if(!Array.isArray(values)||values.length>16||new Set(values).size!==values.length||values.some(value=>!id(value)))fail();return values.join(',');}
export async function workerTriageInput(operation,recordIds,mailFor,{destination='',add_labels=[],remove_labels=[],undo_of=null}={}){
 if(!EMAIL_TRIAGE_KINDS.includes(operation)&&operation!=='undo'||!Array.isArray(recordIds)||!recordIds.length||recordIds.length>25||new Set(recordIds.map(value=>String(value).toLowerCase())).size!==recordIds.length||recordIds.some(value=>!uuid(value))||typeof mailFor!=='function')fail();
 const account=mailFor(recordIds[0])?.account_id;
 if(typeof account!=='string'||!account||recordIds.some(value=>mailFor(value)?.account_id!==account))fail();
 let add='',remove='';
 if(operation==='labels'){add=labels(add_labels);remove=labels(remove_labels);if(!add&&!remove||add_labels.some(value=>remove_labels.includes(value))||destination||undo_of!==null)fail();}
 else if(add_labels.length||remove_labels.length)fail();
 if(operation==='undo'){if(!uuid(undo_of)||destination)fail();destination=undo_of.toLowerCase();}
 else if(undo_of!==null||destination&&!['move','restore','not_spam'].includes(operation))fail();
 if(operation==='move'&&!destination||destination&&!id(destination))fail();
 const input=Object.freeze({record_ids:recordIds.map(value=>value.toLowerCase()).sort().join(','),operation,destination,add_labels:add,remove_labels:remove});
 const digest=sha256Hex(JSON.stringify(input));
 return Object.freeze({input,action_key:operation==='permanent_delete'?'permanent_delete_message':'triage_message',summary:`${operation.replaceAll('_',' ')} · ${recordIds.length} message(s) · ${digest}`});
}
