import {parseNativeMailboxList,formatNativeMailboxList,type MailboxAddress} from '../../../../packages/app-kit/src/mailbox-list';
import {emptyNativeDraft,parseNativeDraftContent,type NativeDraftContent} from './email-native-drafts';
import {parseNativeEmailPresentation,type NativeReaderPresentation} from './email-native-reader';
import {nativeForwardFiles,type NativeForwardFiles} from './email-native-forward-files';
export type NativeReplyMode='reply'|'reply_all'|'forward';
export type NativeReplyCompose={accountId:string;initialContent:NativeDraftContent;notice:string;forwardFiles?:NativeForwardFiles};
const clip=(text:string,limit:number)=>{let result=text.slice(0,limit);if(/[\ud800-\udbff]$/u.test(result))result=result.slice(0,-1);return result;};
function originalQuotedHeaders(value:NativeReaderPresentation):{text:string;incomplete:boolean}{
 const fields={From:'reply_from',To:'reply_to_list',Cc:'reply_cc'} as const,unavailable=new Set(value.reply_seed_unavailable??[]),seen=new Set<string>();let incomplete=false;
 const marker=(label:string,missing:boolean)=>{incomplete=true;const description=label==='From'?(missing?'Original sender information unavailable':'Original sender information may be incomplete'):(missing?'Complete original recipient list unavailable':'Original recipient list may be incomplete');return `${label}: [${description}. Check the original message.]`;};
 const lines=value.presentation.headers.filter(item=>['From','To','Cc','Date','Subject'].includes(item.label)).map(item=>{
  seen.add(item.label);const key=fields[item.label as keyof typeof fields];if(!key)return `${item.label}: ${item.value}`;
  if(unavailable.has(key))return marker(item.label,true);
  const scalar=value.presentation.metadata[key];if(scalar?.trim()){try{const complete=formatNativeMailboxList(parseNativeMailboxList(scalar));return `${item.label}: ${complete}`;}catch{/* Keep short display-only headers; a capped display cannot prove completeness. */}}
  return item.value.length>=2048?marker(item.label,false):`${item.label}: ${item.value}`;
 });
 for(const [label,key] of Object.entries(fields))if(unavailable.has(key)&&!seen.has(label))lines.push(marker(label,true));
 return {text:lines.join('\n'),incomplete};
}

/** Fit through the existing draft validator, so quoting accounts for every
 * header/recipient/prefix cost without introducing another size policy. */
function quotedDraft(base:NativeDraftContent,text:string,body:(excerpt:string)=>string):{content:NativeDraftContent;excerpt:string}{
 const draft=(excerpt:string)=>parseNativeDraftContent({...base,body:body(excerpt)});
 // Validate fixed fields/headers first. Budget fitting must never conceal an
 // unsupported source character after the selected prefix.
 draft('');for(let offset=0;offset<text.length;offset+=65536)parseNativeDraftContent({...emptyNativeDraft(),body:text.slice(offset,offset+65536)});
 try{return {content:draft(text),excerpt:text};}catch{/* Only the existing body/JSON budget can remain after validation above. */}
 let low=0,high=text.length;
 while(low<high){const middle=Math.ceil((low+high)/2);try{draft(clip(text,middle));low=middle;}catch{high=middle-1;}}
 const excerpt=clip(text,low);return {content:draft(excerpt),excerpt};
}

/** Seed only from the host's validated MIME presentation. The server rechecks
 * this logical parent and current sender identity when preparing outgoing MIME. */
export function createNativeReplyCompose(raw:NativeReaderPresentation,mode:NativeReplyMode):NativeReplyCompose{
 const value=parseNativeEmailPresentation(raw,raw.account_id,raw.logical_message_id),metadata=value.presentation.metadata;
 const fail=():never=>{throw Error('Reply recipients could not be confirmed. Check the original message and this account in Email settings.');};
 if(!['reply','reply_all','forward'].includes(mode))return fail();
 const subject=metadata.subject??value.presentation.headers.find(item=>item.label==='Subject')?.value??'';
 if(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(subject))return fail();
 const prefix=mode==='forward'?'Fwd: ':'Re: ',originalSubject=new RegExp(mode==='forward'?'^fwd?:':'^re:','iu').test(subject)?subject:prefix+subject;
 let to='',cc='';
 if(mode!=='forward'){
  try{
   const addresses:unknown=JSON.parse(metadata.verified_sender_identities??'');if(!Array.isArray(addresses)||!addresses.length||addresses.length>32)return fail();
   const own=new Set(addresses.map(item=>{if(typeof item!=='string')return fail();const parsed=parseNativeMailboxList(item,{maxItems:1});if(parsed[0]!.displayName)return fail();return parsed[0]!.address.toLowerCase();}));
   const primary=parseNativeMailboxList(metadata.primary_address??'',{maxItems:1})[0]!;if(!own.has(primary.address.toLowerCase()))return fail();
   const read=(key:string)=>parseNativeMailboxList(metadata[key]??'',{allowEmpty:true});
   const from=read('reply_from'),replyTo=read('reply_to'),originalTo=read('reply_to_list'),originalCc=read('reply_cc');
   if(!from.length||value.reply_seed_unavailable?.includes('reply_from'))return fail();const ownSent=from.every(item=>own.has(item.address.toLowerCase())),seen=new Set(own);
   if(value.reply_seed_unavailable?.includes(ownSent?'reply_to_list':'reply_to')
     ||mode==='reply_all'&&value.reply_seed_unavailable?.some(key=>key==='reply_to_list'||key==='reply_cc'))return fail();
   const select=(items:readonly MailboxAddress[])=>items.filter(item=>{const key=item.address.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
   const selectedTo=select(ownSent?originalTo:replyTo.length?replyTo:from),selectedCc=mode==='reply_all'?select(ownSent?originalCc:[...originalTo,...originalCc]):[];
   if(!selectedTo.length||selectedTo.length+selectedCc.length>200)return fail();to=formatNativeMailboxList(selectedTo);cc=formatNativeMailboxList(selectedCc);
  }catch{return fail();}
 }
 const text=value.presentation.plain_text,headers=originalQuotedHeaders(value);
 const base={...emptyNativeDraft(),mode,to,cc,subject:clip(originalSubject,998),reply_record_id:value.logical_message_id};
 const fitted=quotedDraft(base,text,excerpt=>mode==='forward'?`\n\n---------- Forwarded message ----------\n${headers.text}\n\n${excerpt}`:`\n\n${headers.text}\n\n${excerpt.split('\n').map(line=>'> '+line).join('\n')}`),excerpt=fitted.excerpt;
 const notes=['Review the recipients and message before sending.'];if(value.files.some(item=>item.disposition==='attachment'))notes.push(mode==='forward'?'Original attachments are not included until you choose Include selected originals.':'Original attachments are not included. Add any files you want to send.');if(value.presentation.truncated||excerpt!==text)notes.push('Only part of the original message is quoted.');if(originalSubject.length>998)notes.push('The subject was shortened to fit the draft limit.');
 if(headers.incomplete)notes.push('Some original address headers could not be quoted completely. Download the original message to review them.');
 const forwardFiles=mode==='forward'?nativeForwardFiles(value):undefined;
 return {accountId:value.account_id,initialContent:fitted.content,notice:notes.join(' '),...(forwardFiles?{forwardFiles}:{})};
}
