import {NativeDraftError} from './email-native-drafts';

export type NativeDraftSummary={draft_id:string;account_id:string;revision:number;content_revision:number;status:'draft'|'submitted';subject:string;updated_at:string};
export type NativeDraftSummaryPage={items:NativeDraftSummary[];next_cursor:string|null;has_more:boolean};
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const validDraftId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const SummaryKeys=['draft_id','account_id','revision','content_revision','status','subject','updated_at'];
const PageKeys=['items','next_cursor','has_more'];
const validTimestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

function parsePage(value:unknown,accountId:string):NativeDraftSummaryPage{
 if(!closed(value,PageKeys)||!Array.isArray(value.items)||value.items.length>50||!(value.next_cursor===null||typeof value.next_cursor==='string'&&value.next_cursor.length>0&&value.next_cursor.length<=8192)
   ||typeof value.has_more!=='boolean'||value.has_more!==(value.next_cursor!==null))throw new NativeDraftError('unavailable');
 const items=value.items.map(item=>{
  if(!closed(item,SummaryKeys)||!validDraftId(item.draft_id)||item.account_id!==accountId||!validId(item.account_id)
    ||typeof item.revision!=='number'||!Number.isSafeInteger(item.revision)||item.revision<1||item.revision>2147483646
    ||typeof item.content_revision!=='number'||!Number.isSafeInteger(item.content_revision)||item.content_revision<1||item.content_revision>2147483646
    ||!['draft','submitted'].includes(String(item.status))||typeof item.subject!=='string'||item.subject.length>998
    ||/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(item.subject)||!validTimestamp(item.updated_at))throw new NativeDraftError('unavailable');
  return {draft_id:item.draft_id,account_id:item.account_id,revision:item.revision,content_revision:item.content_revision,
   status:item.status as 'draft'|'submitted',subject:item.subject,updated_at:item.updated_at};
 });
 return {items,next_cursor:value.next_cursor,has_more:value.has_more};
}

type Fetch=(path:string,options:RequestInit)=>Promise<Response>;
async function readJson(response:Response,maxBytes:number,signal:AbortSignal):Promise<unknown>{
 if(!response.body)throw new NativeDraftError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw new NativeDraftError('unavailable');text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
export function createNativeDraftSummaryApi(fetch:Fetch,current:()=>boolean){
 const controller=new AbortController();
 return {query:async(accountId:string,cursor:string|null=null,limit=50):Promise<NativeDraftSummaryPage>=>{
  if(!validId(accountId)||!(cursor===null||typeof cursor==='string'&&cursor.length>0&&cursor.length<=8192)||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new NativeDraftError('invalid');
  if(!current())throw new NativeDraftError('denied');controller.signal.throwIfAborted();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),response=await fetch(`/api/email/accounts/${encodeURIComponent(accountId)}/draft-summaries/query`,
   {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cursor,limit}),signal});
  signal.throwIfAborted();if(!current())throw new NativeDraftError('denied');
  if(!response.ok)throw new NativeDraftError([401,403].includes(response.status)?'denied':response.status===409?'conflict':response.status===404?'missing':[400,413].includes(response.status)?'invalid':'unavailable');
  const page=parsePage(await readJson(response,128*1024,signal),accountId);signal.throwIfAborted();if(!current())throw new NativeDraftError('denied');return page;
 },dispose:()=>controller.abort()};
}

/** Merge account pages without duplicates and in a stable cross-account order. */
export function mergeNativeDraftSummaries(...groups:readonly NativeDraftSummary[][]):NativeDraftSummary[]{
 const byKey=new Map<string,NativeDraftSummary>();
 for(const group of groups)for(const item of group){const key=`${item.account_id}/${item.draft_id}`,previous=byKey.get(key);
  if(!previous||item.updated_at>previous.updated_at||item.updated_at===previous.updated_at&&item.revision>previous.revision)byKey.set(key,item);
 }
 return [...byKey.values()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||a.account_id.localeCompare(b.account_id)||a.draft_id.localeCompare(b.draft_id));
}
