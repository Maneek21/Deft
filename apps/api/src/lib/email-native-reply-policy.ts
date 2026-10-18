import {parseNativeMailboxList,formatNativeMailboxList,type MailboxAddress} from '../../../../packages/app-kit/src/mailbox-list.js';
import type {EmailNativeReplyContext} from './email-native-outgoing-snapshot.js';

/** Current parent admission, independently of an older saved draft's recipients.
 * Received Bcc is never a reply seed. A missing/unsupported field cannot become
 * a valid trimmed list or be mistaken for an absent Reply-To. */
export function assertNativeReplyModeAvailable(parent:EmailNativeReplyContext,mode:string,ownAddresses:readonly string[]):void{
 if(mode!=='reply'&&mode!=='reply_all')return;
 const fail=():never=>{throw Error('EMAIL_SEND_REPLY_UNAVAILABLE');};
 try{
  const fields=['reply_from','reply_to','reply_to_list','reply_cc'],unavailable=parent.reply_seed_unavailable??[];
  const values={reply_from:parent.from,reply_to:parent.reply_to,reply_to_list:parent.to,reply_cc:parent.cc};
  if(!Array.isArray(unavailable)||unavailable.length>4||new Set(unavailable).size!==unavailable.length
   ||unavailable.some((key:unknown)=>typeof key!=='string'||!fields.includes(key)||values[key as keyof typeof values]!==''))return fail();
  const read=(key:keyof typeof values)=>{if(unavailable.includes(key))return fail();return parseNativeMailboxList(values[key],{allowEmpty:true});};
  const own=new Set(ownAddresses.map(value=>parseNativeMailboxList(value,{maxItems:1})[0]!.address.toLowerCase()));
  if(!own.size)return fail();const from=read('reply_from');if(!from.length)return fail();
  const ownSent=from.every(value=>own.has(value.address.toLowerCase())),seen=new Set(own);
  const select=(items:readonly MailboxAddress[])=>items.filter(value=>{const key=value.address.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
  const replyTo=ownSent?[]:read('reply_to');
  const to=select(ownSent?read('reply_to_list'):replyTo.length?replyTo:from);
  const cc=mode==='reply_all'?select(ownSent?read('reply_cc'):[...read('reply_to_list'),...read('reply_cc')]):[];
  if(!to.length||to.length+cc.length>200)return fail();
  formatNativeMailboxList(to);formatNativeMailboxList(cc);
 }catch{return fail();}
}
