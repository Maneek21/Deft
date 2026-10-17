import {z} from 'zod';
import {parseMailboxList,formatMailboxList} from '../../../../packages/app-kit/src/mailbox-list.js';
import type {EmailActor,EmailAuthority,EmailScope,EmailCapability} from './email-mailbox-service.js';
const Id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export const EmailRecipientQuerySchema=z.strictObject({query:z.string().trim().min(1).max(240).refine(v=>!/[\u0000-\u001f\u007f-\u009f]/u.test(v)),limit:z.number().int().min(1).max(10).default(10)});
export type EmailRecipientSuggestion={address:string;name:string;provenance:('contacts'|'recent')[]};
export type EmailRecipientPage={account_id:string;query:string;items:EmailRecipientSuggestion[];sources:{contacts:'available'|'not_installed'|'unavailable';recent:'available'|'unavailable'};has_more:boolean};
export type EmailRecipientContacts={search(actor:EmailActor,scope:EmailScope,input:{query:string;limit:number},signal?:AbortSignal):Promise<{items:{address:string;name:string}[];status:'available'|'not_installed'|'unavailable';has_more:boolean}>};
export type EmailRecipientRecent={list(actor:EmailActor,scope:EmailScope,input:{limit:number;cursor:null},signal?:AbortSignal):Promise<{items:{account_id:string;state:string;to:string;cc:string;bcc:string}[];has_more:boolean}>};
export class EmailRecipientError extends Error{constructor(readonly code:'EMAIL_RECIPIENT_INVALID'|'EMAIL_RECIPIENT_ACCESS_DENIED'|'EMAIL_RECIPIENT_UNAVAILABLE'){super(code);}}
const denied=():never=>{throw new EmailRecipientError('EMAIL_RECIPIENT_ACCESS_DENIED');};
const canonical=(address:string)=>address.toLowerCase();
/** Account-scoped suggestions, not authority to send or disclose CRM records.
 * At most 20 contact records and 50 recent Outbox receipts are examined. */
export class EmailRecipientAssistance{
 constructor(private readonly authority:EmailAuthority,private readonly contacts:EmailRecipientContacts,private readonly recent:EmailRecipientRecent,private readonly now=Date.now){}
 async query(rawActor:EmailActor,rawScope:EmailScope,rawInput:unknown,signal?:AbortSignal):Promise<EmailRecipientPage>{
  let scope:EmailScope,actor:EmailActor,input:z.infer<typeof EmailRecipientQuerySchema>;
  try{scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id}).parse(rawScope);actor=z.strictObject({user_id:Id,web_session_id:Id,access_expires_at:z.number().finite()}).parse(rawActor);input=EmailRecipientQuerySchema.parse(rawInput);}catch{throw new EmailRecipientError('EMAIL_RECIPIENT_INVALID');}
  if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())return denied();
  const check=(cap:EmailCapability)=>{if(cap.scope.org_id!==scope.org_id||cap.scope.owner_user_id!==scope.owner_user_id||cap.scope.account_id!==scope.account_id||cap.expires_at<=this.now()||!Number.isFinite(cap.expires_at)||!Id.safeParse(cap.authority_version).success)return denied();};
  const current=async()=>{signal?.throwIfAborted();if(actor.access_expires_at<=this.now())return denied();try{const cap=await this.authority.current(actor,scope,'human_read',undefined,signal);signal?.throwIfAborted();check(cap);return cap;}catch(error){signal?.throwIfAborted();if(error instanceof EmailRecipientError)throw error;return denied();}};
  const first=await current(),sources:EmailRecipientPage['sources']={contacts:'unavailable',recent:'unavailable'},items=new Map<string,EmailRecipientSuggestion>();let hasMore=false;
  const add=(rawAddress:string,rawName:string,source:'contacts'|'recent')=>{try{
   const parsed=parseMailboxList(rawAddress,{maxItems:1})[0]!;if(parsed.displayName||typeof rawName!=='string')return;
   // Validate names through the same closed mailbox grammar; do not manufacture
   // headers or discard malformed input into a different recipient.
   const named=parseMailboxList(formatMailboxList([{address:parsed.address,displayName:rawName}]),{maxItems:1})[0]!;
   if(!`${named.displayName} ${named.address}`.toLowerCase().includes(input.query.toLowerCase()))return;
   const key=canonical(named.address),prior=items.get(key);if(prior){if(!prior.provenance.includes(source))prior.provenance.push(source);if(!prior.name&&named.displayName)prior.name=named.displayName;}else items.set(key,{address:named.address,name:named.displayName,provenance:[source]});
  }catch{/* A malformed row cannot become a guessed address. */}};
  const [contacts,recent]=await Promise.allSettled([this.contacts.search(actor,scope,{query:input.query,limit:20},signal),this.recent.list(actor,scope,{limit:50,cursor:null},signal)]);
  signal?.throwIfAborted();
  if(contacts.status==='fulfilled'){
   const page=contacts.value;if(!['available','not_installed','unavailable'].includes(page.status)||!Array.isArray(page.items)||page.items.length>20||typeof page.has_more!=='boolean'||page.status!=='available'&&(page.items.length>0||page.has_more))throw new EmailRecipientError('EMAIL_RECIPIENT_UNAVAILABLE');
   sources.contacts=page.status;hasMore||=page.has_more;for(const item of page.items)add(item.address,item.name,'contacts');
  }
  if(recent.status==='fulfilled'){
   const page=recent.value;if(!Array.isArray(page.items)||page.items.length>50||typeof page.has_more!=='boolean')throw new EmailRecipientError('EMAIL_RECIPIENT_UNAVAILABLE');sources.recent='available';hasMore||=page.has_more;
   for(const receipt of page.items){if(receipt.account_id!==scope.account_id)return denied();if(receipt.state!=='accepted')continue;for(const field of [receipt.to,receipt.cc,receipt.bcc]){try{for(const mailbox of parseMailboxList(field,{maxItems:32,allowEmpty:true}))add(mailbox.address,mailbox.displayName,'recent');}catch{/* Keep other well-formed receipt fields. */}}}
  }
  const final=await current();if(final.authority_version!==first.authority_version||final.resource_binding_id!==first.resource_binding_id)return denied();
  if(sources.contacts==='unavailable'&&sources.recent==='unavailable')throw new EmailRecipientError('EMAIL_RECIPIENT_UNAVAILABLE');
  return {account_id:scope.account_id,query:input.query,items:[...items.values()].slice(0,input.limit),sources,has_more:hasMore||items.size>input.limit};
 }
}
