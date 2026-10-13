import {nativeMessageUrl,type NativeMessageTarget} from './email-native-message-links';

export const emailKnowledgeTypes=['fact','concept','entity','decision','resource','procedure','preference'] as const;
export type EmailTransferDestination={kind:'note';visibility:'private'|'org';space_id?:never}|{kind:'note';visibility:'space';space_id:string}|{kind:'knowledge';space_id:string;type:typeof emailKnowledgeTypes[number]}|{kind:'chat';space_id:string};
export type EmailTransferInput={destination:EmailTransferDestination;title:string;mode:'source_link'|'excerpt';excerpt?:string};
export type EmailTransferReview={source_digest:string;review_digest:string;audience:{visibility:'private'|'org'|'space';label:string;member_count:number};source_url:string};
export type EmailTransferResult={destination_kind:'note'|'knowledge'|'chat';destination_id:string;destination_url:string;replayed:boolean};
export type EmailTransferIntent={input:EmailTransferInput;review:EmailTransferReview;requestId:string;body:string;result?:EmailTransferResult};
const retained=new Map<string,EmailTransferIntent>();
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('The transfer could not be confirmed.');return v as Record<string,unknown>;};
const id=(v:unknown):v is string=>typeof v==='string'&&!!v&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export class EmailTransferError extends Error{constructor(readonly code:string,readonly status:number){super(code==='EMAIL_TRANSFER_STALE'?'The email or audience changed. Review again.':code==='EMAIL_TRANSFER_CONFLICT'?'This creation request could not be reused.':status===401||status===403?'Email or destination access changed.':code==='EMAIL_TRANSFER_INVALID'?'Check the title, destination and selected excerpt.':'Creation could not be confirmed. Check creation before starting another.');}}

export function validateEmailTransferInput(raw:EmailTransferInput,plainText:string):EmailTransferInput{
 const destination=raw.destination,title=raw.title.trim();
 if(!title||title.length>512||!destination||!['note','knowledge','chat'].includes(destination.kind))throw Error('Choose a destination and a title.');
 if(destination.kind==='note'&&!['private','org','space'].includes(destination.visibility))throw Error('Choose who can see this note.');
 if((destination.kind!=='note'||destination.visibility==='space')&&!id(destination.space_id))throw Error('Choose a space.');
 if(destination.kind==='note'&&destination.visibility!=='space'&&destination.space_id!==undefined)throw Error('Choose a valid note destination.');
 if(destination.kind==='knowledge'&&!emailKnowledgeTypes.includes(destination.type))throw Error('Choose a Knowledge type.');
 if(raw.mode==='excerpt'){if(!raw.excerpt||raw.excerpt.length>20000||raw.excerpt.includes('\0')||!plainText.includes(raw.excerpt))throw Error('Select an excerpt from this email, up to 20,000 characters.');}
 else if(raw.mode!=='source_link'||raw.excerpt!==undefined)throw Error('Choose a source link or selected excerpt.');
 const chosen:EmailTransferDestination=destination.kind==='chat'?{kind:'chat',space_id:destination.space_id}:destination.kind==='knowledge'?{kind:'knowledge',space_id:destination.space_id,type:destination.type}:destination.visibility==='space'?{kind:'note',visibility:'space',space_id:destination.space_id}:{kind:'note',visibility:destination.visibility};
 return {destination:chosen,title,mode:raw.mode,...(raw.mode==='excerpt'?{excerpt:raw.excerpt}:{})};
}
export function parseEmailTransferReview(raw:unknown,target:NativeMessageTarget,input:EmailTransferInput):EmailTransferReview{
 const row=object(raw),audience=object(row.audience),expected=input.destination.kind==='note'?input.destination.visibility:'space';
 if(!digest(row.source_digest)||!digest(row.review_digest)||row.source_url!==nativeMessageUrl(target)||audience.visibility!==expected||typeof audience.label!=='string'||!audience.label||audience.label.length>1024||!Number.isSafeInteger(audience.member_count)||Number(audience.member_count)<1)throw Error('The destination audience could not be confirmed.');
 return {source_digest:row.source_digest,review_digest:row.review_digest,source_url:row.source_url,audience:{visibility:expected,label:audience.label,member_count:Number(audience.member_count)}};
}
export function parseEmailTransferResult(raw:unknown,kind:EmailTransferResult['destination_kind'],spaceId?:string):EmailTransferResult{
 const row=object(raw);if(row.destination_kind!==kind||!id(row.destination_id)||typeof row.destination_url!=='string'||typeof row.replayed!=='boolean')throw Error('Creation could not be confirmed.');
 const url=new URL(row.destination_url,'https://deft.invalid');
 if(kind==='chat'){
  if(!id(spaceId)||!row.destination_url.startsWith('/')||url.origin!=='https://deft.invalid'||url.pathname!=='/chat'||url.hash||[...url.searchParams.keys()].length!==2||url.searchParams.get('space')!==spaceId||url.searchParams.get('message')!==row.destination_id)throw Error('Creation could not be confirmed.');
  return {destination_kind:kind,destination_id:row.destination_id,destination_url:row.destination_url,replayed:row.replayed};
 }
 const key=kind==='note'?'id':'slug',value=url.searchParams.get(key);
 if(!row.destination_url.startsWith('/')||url.origin!=='https://deft.invalid'||url.pathname!==(kind==='note'?'/notes':'/knowledge')||url.hash||[...url.searchParams.keys()].length!==1||!id(value)||kind==='note'&&value!==row.destination_id)throw Error('Creation could not be confirmed.');
 return {destination_kind:kind,destination_id:row.destination_id,destination_url:row.destination_url,replayed:row.replayed};
}
export function parseEmailTransferSpaces(raw:unknown):{id:string;name:string}[]{
 if(!Array.isArray(raw)||raw.length>10000)throw Error('Spaces could not be loaded.');
 return raw.flatMap(value=>{const row=object(value);return id(row.id)&&typeof row.name==='string'&&row.name.length<=1024&&!row.is_archived?[{id:row.id,name:row.name}]:[];});
}
/** Keep an uncertain exact creation intent in this tab's memory across reader
 * remounts. No mail content is persisted in browser storage. A scope change
 * drops the prior session's intents; no automatic mutation retry is allowed. */
export function createNativeEmailContextTransfer(options:{target:NativeMessageTarget;sessionScope:string;plainText:string;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;uuid?:()=>string}){
 nativeMessageUrl(options.target);for(const key of retained.keys())if(JSON.parse(key)[0]!==options.sessionScope)retained.delete(key);
 const key=JSON.stringify([options.sessionScope,options.target.account_id,options.target.logical_message_id]);
 const path='/api/email/accounts/'+encodeURIComponent(options.target.account_id)+'/messages/'+options.target.logical_message_id+'/context-transfer';
 let active=true,busy=false,reviewed:{input:EmailTransferInput;review:EmailTransferReview}|null=null;
 const current=()=>active&&options.current();
 const request=async(suffix:string,body:string,requestId?:string)=>{
  if(!current())throw Error('Email access changed.');const signal=AbortSignal.timeout(12000);
  const response=await options.fetch(path+suffix,{method:'POST',headers:{'Content-Type':'application/json',...(requestId?{'Idempotency-Key':requestId}:{})},body,cache:'no-store',signal});
  signal.throwIfAborted();const text=await response.text();signal.throwIfAborted();if(new TextEncoder().encode(text).length>64*1024)throw Error('The transfer could not be confirmed.');
  const value:unknown=JSON.parse(text);if(!response.ok){const error=object(value);throw new EmailTransferError(typeof error.code==='string'?error.code:'EMAIL_TRANSFER_UNAVAILABLE',response.status);}return value;
 };
 return {
  retained:()=>current()?retained.get(key)??null:null,
  invalidate:()=>{reviewed=null;},
  review:async(raw:EmailTransferInput)=>{
   if(busy||retained.has(key))throw Error('Check the previous creation before starting another.');if(!current())throw Error('Email access changed.');busy=true;
   try{const input=validateEmailTransferInput(raw,options.plainText),review=parseEmailTransferReview(await request('/review',JSON.stringify(input)),options.target,input);if(!current())throw Error('Email access changed.');reviewed={input,review};return reviewed;}finally{busy=false;}
  },
  commit:async()=>{
   if(busy||!current())throw Error('Email access changed.');let intent=retained.get(key);
   if(!intent){if(!reviewed)throw Error('Review the destination first.');const requestId=(options.uuid??(()=>crypto.randomUUID()))();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId))throw Error('Creation could not start.');intent={...reviewed,requestId,body:JSON.stringify({...reviewed.input,source_digest:reviewed.review.source_digest,review_digest:reviewed.review.review_digest})};retained.set(key,intent);}
   if(intent.result)return intent.result;busy=true;
   try{const result=parseEmailTransferResult(await request('',intent.body,intent.requestId),intent.input.destination.kind,intent.input.destination.space_id);intent.result=result;if(!current())throw Error('Email access changed.');return result;}
   catch(error){if(error instanceof EmailTransferError&&['EMAIL_TRANSFER_STALE','EMAIL_TRANSFER_INVALID'].includes(error.code)){retained.delete(key);reviewed=null;}throw error;}finally{busy=false;}
  },
  reset:()=>{if(!current())throw Error('Email access changed.');const intent=retained.get(key);if(intent&&!intent.result)throw Error('Check the previous creation before starting another.');retained.delete(key);reviewed=null;},
  dispose:()=>{active=false;reviewed=null;},
 };
}
