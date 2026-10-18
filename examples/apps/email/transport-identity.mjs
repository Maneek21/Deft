// This adapter accepts only the trusted Runtime claim identity, never an input field.
export function withTransportIdentity(runId, action, input) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw Error('EXACT_MAIL_RUN_INVALID');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('EXACT_MAIL_INPUT_INVALID');
  if (!['send_message','reply_message'].includes(action)) return input;
  if (Object.hasOwn(input,'message_id')) throw Error('SUPPLIED_TRANSPORT_ID_NOT_ALLOWED');
  return {...input,message_id:`<deft-${runId.toLowerCase()}@email-lite.test>`};
}

export function withReplyParent(input, parent) {
  if (!parent || typeof parent.message_id !== 'string' || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(parent.message_id) || parent.message_id.length>200) throw Error('STALE_MAIL_PARENT');
  if (['parent_message_id','in_reply_to','references'].some(key=>Object.hasOwn(input,key))) throw Error('SUPPLIED_REPLY_HEADERS_NOT_ALLOWED');
  const references=[typeof parent.references==='string'?parent.references:'',parent.message_id].filter(Boolean).join(' ');
  if(references.length>1000)throw Error('REPLY_REFERENCES_TOO_LONG');
  return {...input,parent_message_id:parent.message_id,in_reply_to:parent.message_id,references};
}
