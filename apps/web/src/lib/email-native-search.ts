export type NativeEmailMessage={account_id:string;logical_message_id:string;revision:string;received_at:string|null;folders:string[];
  flags:{seen:boolean;flagged:boolean;answered:boolean};data:Record<string,string|number|boolean|null>};
type Unsupported={field:string|null;reason:string;index:number|null};
type Result={account_id:string;query:string;source:'provider';coverage:'complete'|'partial';complete:boolean;query_complete:boolean;exact_total:null;
  items:NativeEmailMessage[];next_cursor:string|null;unsupported:Unsupported[];provider_result_cap:1000|null;limitations:string[];failure_count:number;observed_at:string|null};
export type NativeSearchAccount={accountId:string;state:'pending'|'available'|'failed'|'denied';items:NativeEmailMessage[];nextCursor:string|null;
  complete:boolean;unsupported:Unsupported[];limited:boolean;failureCount:number;error:string};
export type NativeSearchState={query:string;busy:boolean;loading:'search'|'refresh'|'more'|null;items:NativeEmailMessage[];accounts:NativeSearchAccount[];complete:boolean};
/** A confirmed query rejection is different from an empty or partial search.
 * Pending, failed, denied and cached partitions must retain their own truth. */
export function nativeSearchUnsupported(state:NativeSearchState):boolean{
  return !state.busy&&!state.items.length&&state.accounts.length>0&&state.accounts.every(row=>row.state==='available'
    &&row.unsupported.length>0&&!row.items.length&&!row.failureCount&&row.nextCursor===null);
}
/** Refresh metadata for existing matches only. Neither account cursors nor the
 * original query membership change, and denied partitions remain cleared. */
export function reconcileNativeEmailSearchState(state:NativeSearchState,updated:readonly NativeEmailMessage[]):NativeSearchState{
  const byId=new Map(updated.map(row=>[row.account_id+'/'+row.logical_message_id,row]));
  const replace=(items:NativeEmailMessage[])=>items.map(row=>byId.get(row.account_id+'/'+row.logical_message_id)??row);
  return {...state,items:replace(state.items),accounts:state.accounts.map(account=>account.state==='denied'?account:{...account,items:replace(account.items)})};
}
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const fail=():never=>{throw Error('Search results could not be confirmed.');};
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))return fail();return v as Record<string,unknown>;};
const closed=(v:Record<string,unknown>,keys:string[])=>{if(Object.keys(v).some(key=>!keys.includes(key)))fail();};
export function parseNativeEmailMessage(value:unknown,accountId:string):NativeEmailMessage{
  const row=object(value);closed(row,['account_id','logical_message_id','revision','received_at','folders','flags','data']);
  if(row.account_id!==undefined&&row.account_id!==accountId||typeof row.logical_message_id!=='string'||!/^mail_[a-f0-9]{64}$/u.test(row.logical_message_id)
    ||!id(row.revision)||row.received_at!==null&&(typeof row.received_at!=='string'||!Number.isFinite(Date.parse(row.received_at)))
    ||!Array.isArray(row.folders)||row.folders.length>100||!row.folders.every(id))fail();
  const flags=object(row.flags);closed(flags,['seen','flagged','answered']);if(['seen','flagged','answered'].some(key=>typeof flags[key]!=='boolean'))fail();
  const data=object(row.data);if(Object.entries(data).some(([key,v])=>!key||key.length>128||v!==null
    &&(!['string','boolean','number'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))))fail();
  return {...row,account_id:accountId} as NativeEmailMessage;
}
function parse(raw:unknown,accountId:string,query:string):Result{
  const row=object(raw);closed(row,['account_id','query','source','coverage','complete','query_complete','exact_total','items','next_cursor','unsupported','provider_result_cap','limitations','failure_count','observed_at']);
  if(row.account_id!==accountId||row.query!==query||row.source!=='provider'||typeof row.coverage!=='string'||!['complete','partial'].includes(row.coverage)
    ||typeof row.complete!=='boolean'||typeof row.query_complete!=='boolean'||row.exact_total!==null
    ||!Array.isArray(row.items)||row.items.length>50||!(row.next_cursor===null||typeof row.next_cursor==='string'&&row.next_cursor.length>0&&row.next_cursor.length<=8192)
    ||!Array.isArray(row.unsupported)||row.unsupported.length>32||!Array.isArray(row.limitations)||row.limitations.length>32
    ||!row.limitations.every(v=>typeof v==='string'&&v.length<=256)||![null,1000].includes(row.provider_result_cap as null|1000)
    ||!Number.isSafeInteger(row.failure_count)||Number(row.failure_count)<0||Number(row.failure_count)>100
    ||row.observed_at!==null&&(typeof row.observed_at!=='string'||!Number.isFinite(Date.parse(row.observed_at))))fail();
  for(const raw of row.unsupported as unknown[]){const u=object(raw);closed(u,['field','reason','index']);
    if(!(u.field===null||typeof u.field==='string'&&u.field.length<=128)||typeof u.reason!=='string'||!u.reason||u.reason.length>128
      ||!(u.index===null||Number.isSafeInteger(u.index)&&Number(u.index)>=0))fail();}
  const unsupported=row.unsupported as unknown[],items=row.items as unknown[];
  if(row.complete&&(row.coverage!=='complete'||!row.query_complete||row.next_cursor!==null||unsupported.length||row.failure_count)
    ||unsupported.length&&items.length)fail();
  return {...row,items:items.map(item=>parseNativeEmailMessage(item,accountId))} as Result;
}

/** Each opaque continuation stays attached to its original human query and
 * exact account. Only explicit More loads another page; fan-out is at most two. */
export function createNativeEmailSearch(input:{accountIds:readonly string[];query:string;current:()=>boolean;
  fetch:(path:string,init:RequestInit)=>Promise<Response>;change:(state:NativeSearchState)=>void;denied:(accountId:string)=>void;previous?:NativeSearchState|null;}){
  if(!input.accountIds.length||input.accountIds.length>16||!input.accountIds.every(id)||new Set(input.accountIds).size!==input.accountIds.length
    ||!input.query.trim()||input.query.length>2048||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(input.query))throw Error('Enter a search query of up to 2,048 characters.');
  const query=input.query,accountIds=[...input.accountIds],controller=new AbortController();let active=true,busy=false,started=false,loading:NativeSearchState['loading']=null;
  const previous=input.previous,retain=previous?.query===query&&previous.accounts.length===accountIds.length&&new Set(previous.accounts.map(row=>row.accountId)).size===accountIds.length&&previous.accounts.every(row=>accountIds.includes(row.accountId));
  const rows:NativeSearchAccount[]=accountIds.map(accountId=>({accountId,state:'pending',items:retain?structuredClone(previous.accounts.find(row=>row.accountId===accountId&&row.state!=='denied')?.items??[]):[],nextCursor:null,complete:false,unsupported:[],limited:false,failureCount:0,error:''}));
  const reads=new Map<string,AbortController>(),seen=new Map<string,Set<string>>(),current=()=>active&&!controller.signal.aborted&&input.current();
  const snapshot=():NativeSearchState=>{const items=rows.flatMap(row=>row.items).sort((a,b)=>(Date.parse(b.received_at??'')||0)-(Date.parse(a.received_at??'')||0)||a.account_id.localeCompare(b.account_id)||a.logical_message_id.localeCompare(b.logical_message_id));
    return {query,busy,loading,items,accounts:rows.map(row=>({...row,items:[...row.items]})),complete:rows.every(row=>row.state==='available'&&row.complete&&!row.limited)};};
  const publish=()=>{if(current())input.change(snapshot());};
  async function read(row:NativeSearchAccount,append:boolean){
    if(!current()||row.state==='denied')return;const cursor=append?row.nextCursor:null,request=new AbortController(),signal=AbortSignal.any([controller.signal,request.signal,AbortSignal.timeout(20_000)]);reads.set(row.accountId,request);
    try{
      const response=await input.fetch(`/api/email/accounts/${encodeURIComponent(row.accountId)}/search`,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
        signal,body:JSON.stringify({query,limit:50,cursor})});
      signal.throwIfAborted();
      if(!current())return;
      if([401,403].includes(response.status)){row.state='denied';row.items=[];row.nextCursor=null;row.complete=false;row.error='Account access changed.';input.denied(row.accountId);return;}
      if(!response.ok)throw Error(response.status===409?'Search paging expired. Run the search again.':'Search is unavailable for this account.');
      const raw:unknown=await response.json();signal.throwIfAborted();if(!current())return;const result=parse(raw,row.accountId,query);
      const history=seen.get(row.accountId)??new Set<string>();
      if(result.next_cursor&&(result.next_cursor===cursor||history.has(result.next_cursor)))throw Error('Search paging could not continue. Run the search again.');
      if(cursor)history.add(cursor);seen.set(row.accountId,history);
      const indexed=new Map((append?row.items:[]).map(item=>[item.logical_message_id,item]));for(const item of result.items)indexed.set(item.logical_message_id,item);
      if(indexed.size>500)throw Error('The loaded search limit was reached. Narrow the query to continue.');
      Object.assign(row,{state:'available',items:[...indexed.values()],nextCursor:result.next_cursor,complete:result.complete,
        unsupported:result.unsupported,limited:result.provider_result_cap!==null,failureCount:result.failure_count,error:''});
    }catch(error){if(current()&&(row.state as NativeSearchAccount['state'])!=='denied'){row.state='failed';row.complete=false;row.nextCursor=null;row.error=error instanceof Error&&error.message.startsWith('Search')||error instanceof Error&&error.message.startsWith('The loaded')?error.message:'Search results could not be confirmed.';}}
    finally{if(reads.get(row.accountId)===request)reads.delete(row.accountId);publish();}
  }
  async function start(){if(started||busy||!current())return;started=true;busy=true;loading=retain?'refresh':'search';publish();let cursor=0;
    const consume=async()=>{for(;;){const row=rows[cursor++];if(!row||!current())return;await read(row,false);}};
    try{await Promise.all([consume(),consume()]);}finally{busy=false;loading=null;publish();}}
  async function more(accountId:string){const row=rows.find(row=>row.accountId===accountId);if(!row?.nextCursor||busy||!current())return;
    busy=true;loading='more';publish();try{await read(row,true);}finally{busy=false;loading=null;publish();}}
  return {start,more,reconcile(updated:readonly NativeEmailMessage[]){if(!current())return false;const next=reconcileNativeEmailSearchState(snapshot(),updated);for(let index=0;index<rows.length;index++)rows[index].items=next.accounts[index].items;publish();return true;},revoke(accountId:string){const row=rows.find(value=>value.accountId===accountId);if(!row||!current())return;Object.assign(row,{state:'denied',items:[],nextCursor:null,complete:false,error:'Account access changed.'});reads.get(accountId)?.abort();publish();},dispose(){active=false;controller.abort();}};
}
