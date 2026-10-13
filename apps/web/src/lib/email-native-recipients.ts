import {formatNativeMailboxList,parseNativeMailboxList,type MailboxAddress} from '../../../../packages/app-kit/src/mailbox-list';
export type NativeRecipient={address:string;name:string;provenance:('contacts'|'recent')[]};
export type NativeRecipientPage={account_id:string;query:string;items:NativeRecipient[];sources:{contacts:'available'|'not_installed'|'unavailable';recent:'available'|'unavailable'};has_more:boolean};
export function nativeRecipientProvenanceLabel(item:NativeRecipient):string{
 return [item.provenance.includes('contacts')?'Contact':'',item.provenance.includes('recent')?'Recent':''].filter(Boolean).join(' · ');
}
/** Only partial source failures, bounded results, or an empty checked set need
 * visible copy. Account scope and keyboard guidance remain accessible without
 * repeating a notice beside every recipient field. */
export function nativeRecipientAssistanceStatus(page:NativeRecipientPage):{text:string;actionable:boolean}{
 const unavailable:string[]=[];if(page.sources.contacts==='unavailable')unavailable.push('Contacts');if(page.sources.recent==='unavailable')unavailable.push('Recent recipients');
 if(unavailable.length)return {text:`${unavailable.join(' and ')} unavailable. You can still enter an address.`,actionable:true};
 if(!page.items.length)return {text:'No suggestions found. Enter an email address.',actionable:true};
 if(page.has_more)return {text:'More suggestions may be available. Keep typing to narrow.',actionable:true};
 return {text:'Suggestions for the selected sending account. Use arrow keys and Enter to choose, or enter an address.',actionable:false};
}
export function nativeRecipientKey(key:string,index:number,count:number):{action:'navigate'|'choose'|'close'|'none';index:number}{
 if(key==='Escape')return {action:'close',index:0};if(count<1)return {action:'none',index:0};
 if(key==='ArrowDown'||key==='ArrowUp')return {action:'navigate',index:(index+(key==='ArrowDown'?1:-1)+count)%count};
 return {action:key==='Enter'?'choose':'none',index:Math.max(0,Math.min(index,count-1))};
}
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
export function parseNativeRecipientPage(raw:unknown,accountId:string,query:string):NativeRecipientPage{
 if(!closed(raw,['account_id','query','items','sources','has_more'])||raw.account_id!==accountId||raw.query!==query||typeof raw.has_more!=='boolean'||!Array.isArray(raw.items)||raw.items.length>10||!closed(raw.sources,['contacts','recent'])||!['available','not_installed','unavailable'].includes(String(raw.sources.contacts))||!['available','unavailable'].includes(String(raw.sources.recent)))throw Error('Recipient suggestions could not be confirmed.');
 const sources=raw.sources;const seen=new Set<string>();for(const item of raw.items){if(!closed(item,['address','name','provenance'])||typeof item.address!=='string'||typeof item.name!=='string'||!Array.isArray(item.provenance)||item.provenance.length<1||item.provenance.length>2||new Set(item.provenance).size!==item.provenance.length||!item.provenance.every(p=>p==='contacts'||p==='recent'))throw Error('Recipient suggestions could not be confirmed.');
  const mailbox=parseNativeMailboxList(item.address,{maxItems:1})[0]!;if(mailbox.displayName||mailbox.address!==item.address||seen.has(item.address.toLowerCase()))throw Error('Recipient suggestions could not be confirmed.');
  parseNativeMailboxList(formatNativeMailboxList([{address:mailbox.address,displayName:item.name}]),{maxItems:1});seen.add(item.address.toLowerCase());
  if(item.provenance.some(p=>sources[p as 'contacts'|'recent']!=='available'))throw Error('Recipient suggestions could not be confirmed.');
 }return raw as NativeRecipientPage;
}
/** A suggestion is a user choice; it never changes recipients by itself. */
export function selectNativeRecipient(addresses:readonly MailboxAddress[],suggestion:NativeRecipient,otherFields:readonly string[]=[]):MailboxAddress[]{
 const candidate=parseNativeMailboxList(formatNativeMailboxList([{address:suggestion.address,displayName:suggestion.name}]),{maxItems:1})[0]!;
 const existing=[...addresses];for(const field of otherFields){try{existing.push(...parseNativeMailboxList(field,{allowEmpty:true}));}catch{/* Incomplete other fields stay visible and must be corrected before send. */}}
 if(existing.some(v=>v.address.toLowerCase()===candidate.address.toLowerCase()))throw Error('This address is already a recipient.');
 if(existing.length>=200)throw Error('Recipient fields are full. Use at most 200 recipients across To, Cc, and Bcc.');
 const selected=[...addresses,candidate];formatNativeMailboxList(selected);return selected;
}
/** Validate supplied rows before transport deliberately deduplicates them. */
export function nativeRecipientLimitNotice(fields:readonly string[]):string{
 try{
  const count=fields.reduce((total,field)=>total+parseNativeMailboxList(field,{allowEmpty:true}).length,0);
  return count>200?'Use at most 200 recipients across To, Cc, and Bcc. Your input is kept for correction.':'';
 }catch{return 'Check the recipient fields before sending. Your input is kept for correction.';}
}
export function createNativeRecipientQuery(options:{accountId:string;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;change:(page:NativeRecipientPage|null,notice:string)=>void;denied?:()=>void}){
 let active=true,held:AbortController|null=null;const current=()=>active&&options.current();
 const clear=()=>{held?.abort();held=null;if(current())options.change(null,'');};
 return {clear,query:async(raw:string)=>{
  clear();const query=raw.trim();if(!current()||!query||query.length>240||/[\u0000-\u001f\u007f-\u009f]/u.test(query))return;
  const own=new AbortController();held=own;const timer=setTimeout(()=>own.abort(Error('Suggestions took too long.')),5000);
  try{const response=await options.fetch('/api/email/accounts/'+encodeURIComponent(options.accountId)+'/recipients/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,limit:10}),signal:own.signal});
   if(!current()||held!==own)return;own.signal.throwIfAborted();if([401,403].includes(response.status)){options.denied?.();throw Error('Recipient suggestions are unavailable for this account.');}if(!response.ok)throw Error('Recipient suggestions are unavailable. You can enter an address.');
   const text=await response.text();if(new TextEncoder().encode(text).length>16384)throw Error('Recipient suggestions could not be confirmed.');const page=parseNativeRecipientPage(JSON.parse(text),options.accountId,query);
   if(current()&&held===own&&!own.signal.aborted)options.change(page,'');
  }catch(cause){if(current()&&held===own)options.change(null,cause instanceof Error?cause.message:'Recipient suggestions are unavailable.');}finally{clearTimeout(timer);if(held===own)held=null;}
 },dispose:()=>{active=false;held?.abort();held=null;}};
}
