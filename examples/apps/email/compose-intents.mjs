import {parseMailboxList,formatMailboxList,plainTextToSafeComposeHtml,parseSafeComposeHtml} from '@deft/app-kit/experience';

const fail=()=>{throw Error('EMAIL_COMPOSE_INTENT_INVALID');};
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!controls.test(value);
const header=(value,max)=>text(value,max)&&!/[\r\n]/u.test(value);
const ref=value=>header(value,200)&&value.length>0;
const recordId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const bounded=(value,max)=>{if(!text(value,max))fail();return value;};
const unique=(rows,seen)=>rows.filter(row=>{const key=row.address.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});

/** Produces editable suggestions only. The capture host independently resolves
 * reply_record_id under the current account before authorizing reply headers. */
export function createEmailComposeIntent({mode,parent,verifiedOwnAliases,maxRecipients=32,maxBodyCharacters=4096}){
 if(!['reply','reply_all','forward'].includes(mode)||!parent||!ref(parent.account_id)||!recordId(parent.record_id)
  ||!Number.isInteger(maxRecipients)||maxRecipients<1||maxRecipients>32||!Number.isInteger(maxBodyCharacters)
  ||maxBodyCharacters<1||maxBodyCharacters>16384||parent.truncated!==false||!header(parent.subject,200)
  ||!text(parent.plain_text,maxBodyCharacters)||!Array.isArray(verifiedOwnAliases)||verifiedOwnAliases.length<1||verifiedOwnAliases.length>32)fail();
 const own=verifiedOwnAliases.flatMap(value=>parseMailboxList(value,{maxItems:1}));
 const from=parseMailboxList(parent.from,{maxItems:maxRecipients}),replyTo=parseMailboxList(parent.reply_to,{maxItems:maxRecipients,allowEmpty:true});
 const originalTo=parseMailboxList(parent.to,{maxItems:maxRecipients,allowEmpty:true}),originalCc=parseMailboxList(parent.cc,{maxItems:maxRecipients,allowEmpty:true});
 const ownAddresses=new Set(own.map(row=>row.address.toLowerCase()));
 const ownSent=from.length>0&&from.every(row=>ownAddresses.has(row.address.toLowerCase()));
 const seen=new Set(ownAddresses);
 const to=mode==='forward'?[]:unique(ownSent?originalTo:replyTo.length?replyTo:from,seen);
 const cc=mode==='reply_all'?unique(ownSent?originalCc:[...originalTo,...originalCc],seen):[];
 if(to.length+cc.length>maxRecipients||(mode!=='forward'&&to.length===0))fail();
 const hasPrefix=mode==='forward'?/^fwd?:\s/iu.test(parent.subject):/^re:\s/iu.test(parent.subject),prefix=mode==='forward'?'Fwd: ':'Re: ';
 const subject=hasPrefix?parent.subject:prefix+parent.subject;if(!header(subject,200))fail();
 const body=mode==='forward'?`\n\n---------- Forwarded message ----------\nFrom: ${formatMailboxList(from)}\nTo: ${formatMailboxList(originalTo)}${originalCc.length?`\nCc: ${formatMailboxList(originalCc)}`:''}\nSubject: ${parent.subject}\n\n${parent.plain_text}`
  :`\n\n${formatMailboxList(from)} wrote:\n${parent.plain_text.split('\n').map(line=>`> ${line}`).join('\n')}`;
 bounded(body,maxBodyCharacters);
 const toText=formatMailboxList(to),ccText=formatMailboxList(cc);if(!header(toText,2048)||!header(ccText,2048))fail();
 return Object.freeze({mode,to:toText,cc:ccText,subject,body,reply_record_id:mode==='forward'?'':parent.record_id});
}

/** Explicit saved draft edit. The Send path never appends a hidden signature. */
export function insertEmailSignature({body,body_html='',signature_text,maxCharacters=4096}){
 if(!Number.isInteger(maxCharacters)||maxCharacters<1||maxCharacters>16384||!text(body,maxCharacters)
  ||!text(signature_text,2048)||!signature_text.trim()||typeof body_html!=='string')fail();
 if(body_html!==''&&parseSafeComposeHtml(body_html).plainText!==body)fail();
 const suffix=`\n\n-- \n${signature_text}`;
 if(body.endsWith(suffix))return Object.freeze({body,body_html});
 const next=bounded(body+suffix,maxCharacters);
 if(body_html==='')return Object.freeze({body:next,body_html:''});
 const html=body_html+plainTextToSafeComposeHtml(suffix.slice(1));
 if(parseSafeComposeHtml(html).plainText!==next)fail();return Object.freeze({body:next,body_html:html});
}
