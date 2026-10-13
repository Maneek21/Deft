export type EmailProviderDraftSetting={account_id:string;enabled:boolean;revision:number;supported:boolean};
export class EmailProviderDraftSettingError extends Error {constructor(readonly kind:'conflict'|'denied'|'unsupported'|'unavailable'){
 super(kind==='conflict'?'This choice changed elsewhere. Reload its saved value before trying again.':kind==='denied'?'Account access changed. Reconnect in Email settings.':kind==='unsupported'?'Provider draft syncing is not available for this account yet.':'The saved choice could not be confirmed. Reload it before trying again.');}}
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function parseEmailProviderDraftSetting(raw:unknown,accountId:string):EmailProviderDraftSetting {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='account_id,enabled,revision,supported')throw new EmailProviderDraftSettingError('unavailable');
 const value=raw as Record<string,unknown>;
 if(value.account_id!==accountId||typeof value.enabled!=='boolean'||typeof value.supported!=='boolean'||typeof value.revision!=='number'||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>2147483647)throw new EmailProviderDraftSettingError('unavailable');
 return {account_id:accountId,enabled:value.enabled,revision:value.revision,supported:value.supported};
}
async function readJson(response:Response,signal:AbortSignal){
 if(!response.body)throw new EmailProviderDraftSettingError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
 const aborted=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>8192)throw Error();text+=decoder.decode(next.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',aborted);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function emailProviderDraftSettingRequest(accountId:string,options:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean},
 input?:{enabled:boolean;expected_revision:number},ownedSignal?:AbortSignal):Promise<EmailProviderDraftSetting>{
 if(!id(accountId)||input&&(Object.keys(input).sort().join(',')!=='enabled,expected_revision'||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||input.expected_revision>2147483646))throw new EmailProviderDraftSettingError('unavailable');
 const signal=AbortSignal.any([...(ownedSignal?[ownedSignal]:[]),AbortSignal.timeout(20000)]);
 if(!options.current())throw new EmailProviderDraftSettingError('denied');signal.throwIfAborted();
 try{const response=await options.fetch('/api/email/accounts/'+encodeURIComponent(accountId)+'/provider-draft-sync',{method:input?'PATCH':'GET',cache:'no-store',signal,headers:{'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
  if(!options.current()){await response.body?.cancel().catch(()=>{});throw new EmailProviderDraftSettingError('denied');}signal.throwIfAborted();
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new EmailProviderDraftSettingError([401,403].includes(response.status)?'denied':response.status===409?'conflict':response.status===422?'unsupported':'unavailable');}
  const value=parseEmailProviderDraftSetting(await readJson(response,signal),accountId);if(!options.current())throw new EmailProviderDraftSettingError('denied');signal.throwIfAborted();
  if(input&&(value.enabled!==input.enabled||![input.expected_revision,input.expected_revision+1].includes(value.revision)||input.enabled&&!value.supported))throw new EmailProviderDraftSettingError('unavailable');
  return value;
 }catch(error){if(error instanceof EmailProviderDraftSettingError)throw error;throw new EmailProviderDraftSettingError('unavailable');}
}
