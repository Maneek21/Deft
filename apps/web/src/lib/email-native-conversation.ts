import {parseNativeEmailMessage,type NativeEmailMessage} from './email-native-search';
export type NativeConversationPage={account_id:string;anchor_logical_message_id:string;items:NativeEmailMessage[];next_cursor:string|null;has_more:boolean;
 observed_at:string;source:'provider';consistency:'weak';complete:boolean;coverage:'complete'|'partial';failure_count:number;count:{returned:number;exact_total:null};thread_basis?:'message_headers';limitations?:string[]};
export type NativeConversationState={state:'idle'|'loading'|'available'|'failed'|'denied';busy:boolean;items:NativeEmailMessage[];nextCursor:string|null;complete:boolean;limited:boolean;failureCount:number;notice:string;threadBasis?:'message_headers';limitations?:string[]};
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const logical=(v:unknown):v is string=>typeof v==='string'&&/^mail_[a-f0-9]{64}$/u.test(v);
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const cursor=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256*1024&&/^[A-Za-z0-9_-]+$/u.test(v);
export function parseNativeConversationPage(raw:unknown,accountId:string,anchorId:string,headerRelated=false):NativeConversationPage{
 const fail=():never=>{throw Error('Related messages could not be confirmed.');};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const optional=['thread_basis','limitations'].filter(key=>Object.hasOwn(raw,key));
 if(!closed(raw,['account_id','anchor_logical_message_id','items','next_cursor','has_more','observed_at','source','consistency','complete','coverage','failure_count','count',...optional])||raw.account_id!==accountId||raw.anchor_logical_message_id!==anchorId||!logical(anchorId)||raw.source!=='provider'||raw.consistency!=='weak'||typeof raw.complete!=='boolean'||typeof raw.has_more!=='boolean'||!['complete','partial'].includes(String(raw.coverage))||!Array.isArray(raw.items)||raw.items.length>50||!(raw.next_cursor===null||cursor(raw.next_cursor))||raw.has_more!==(raw.next_cursor!==null)||typeof raw.observed_at!=='string'||!Number.isFinite(Date.parse(raw.observed_at))||typeof raw.failure_count!=='number'||!Number.isSafeInteger(raw.failure_count)||raw.failure_count<0||raw.failure_count>100000||!closed(raw.count,['returned','exact_total'])||raw.count.returned!==raw.items.length||raw.count.exact_total!==null)return fail();
 if((headerRelated||optional.length>0)&&(raw.thread_basis!=='message_headers'||raw.complete||raw.coverage!=='partial'||!Array.isArray(raw.limitations)||!raw.limitations.length||raw.limitations.length>32||raw.limitations.some(value=>typeof value!=='string'||!value||value.length>128||/[\u0000-\u001f\u007f-\u009f]/u.test(value))))return fail();
 if(raw.complete&&(raw.has_more||raw.failure_count>0||raw.coverage!=='complete')||!raw.complete&&raw.coverage==='complete')return fail();
 const items=raw.items.map(item=>parseNativeEmailMessage(item,accountId));if(new Set(items.map(item=>item.logical_message_id)).size!==items.length)return fail();
 return {...raw,items} as NativeConversationPage;
}
async function readJson(response:Response,signal:AbortSignal){
 if(!response.body)throw Error();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 const aborted=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>4*1024*1024)throw Error();text+=decoder.decode(next.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',aborted);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Explicit provider conversation reads keep their original account/anchor.
 * Selecting a sibling is solely the host reader's concern and cannot rebind
 * this continuation to the sibling or any other account. */
export function createNativeEmailConversation(options:{accountId:string;anchorId:string;headerRelated?:boolean;current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;
 change:(state:NativeConversationState)=>void;denied:()=>void}){
 if(!id(options.accountId)||!logical(options.anchorId))throw Error('Related messages are unavailable.');
 const controller=new AbortController();let active=true,started=false,pages=0;
 const used=new Set<string>();let value:NativeConversationState={state:'idle',busy:false,items:[],nextCursor:null,complete:false,limited:false,failureCount:0,notice:''};
 const current=()=>active&&!controller.signal.aborted&&options.current(),publish=()=>{if(current())options.change({...value,items:[...value.items]});};
 const read=async(append:boolean)=>{
  if(!current()||value.busy||append&&!value.nextCursor)return;
  const nextCursor=append?value.nextCursor:null;value={...value,busy:true,state:'loading',notice:''};publish();
  try{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]);
   const response=await options.fetch(`/api/email/accounts/${encodeURIComponent(options.accountId)}/messages/${options.anchorId}/conversation`,{method:'POST',signal,cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({cursor:nextCursor,limit:50})});
   if(!current()){await response.body?.cancel().catch(()=>{});return;}signal.throwIfAborted();
   if([401,403].includes(response.status)){await response.body?.cancel().catch(()=>{});value={...value,state:'denied',items:[],nextCursor:null,complete:false,notice:'Account access changed. Reconnect in Email settings.'};options.denied();return;}
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(response.status===409?'Conversation paging expired or changed. Reload the conversation.':response.status===404?'The original message is no longer available.':'Related messages could not be loaded.');}
   const result=parseNativeConversationPage(await readJson(response,signal),options.accountId,options.anchorId,options.headerRelated);if(!current())return;
   if(append&&result.next_cursor&&(result.next_cursor===nextCursor||used.has(result.next_cursor)))throw Error('Conversation paging could not continue. Reload the conversation.');
   const rows=new Map((append?value.items:[]).map(row=>[row.logical_message_id,row]));for(const item of result.items)rows.set(item.logical_message_id,item);
   if(rows.size>500)throw Error('The loaded conversation limit was reached.');
   if(nextCursor)used.add(nextCursor);if(!append){used.clear();pages=0;}pages++;
   const limited=pages>=10&&result.next_cursor!==null,failureCount=append?Math.max(value.failureCount,result.failure_count):result.failure_count;
   value={state:'available',busy:true,items:[...rows.values()].sort((a,b)=>(Date.parse(a.received_at??'')||0)-(Date.parse(b.received_at??'')||0)||a.logical_message_id.localeCompare(b.logical_message_id)),nextCursor:limited?null:result.next_cursor,complete:result.complete&&!failureCount&&!limited,limited,failureCount,notice:limited?'The first 10 pages are loaded. More messages may exist.':failureCount?'Some related messages could not be loaded.':'',...(result.thread_basis?{threadBasis:result.thread_basis,limitations:[...result.limitations!]}:{})};
  }catch(error){if(current())value={...value,state:'failed',complete:false,nextCursor:null,notice:error instanceof Error&&/^(Conversation|Related|The original|The loaded)/u.test(error.message)?error.message:'Related messages could not be confirmed.'};}
  finally{value.busy=false;publish();}
 };
 return {start(){if(started)return Promise.resolve();started=true;return read(false);},more:()=>read(true),reload:()=>read(false),snapshot:()=>({...value,items:[...value.items]}),dispose(){active=false;controller.abort();value={...value,items:[],nextCursor:null};}};
}
