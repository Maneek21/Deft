export type DirectEmailProvider='gmail'|'microsoft';
export type DirectEmailCapability='read'|'modify'|'send';
export type DirectEmailReconnect=Readonly<{account_id:string;provider:DirectEmailProvider;label:string;capabilities:readonly DirectEmailCapability[]}>;
export type DirectEmailIntent={request_id:string;provider:DirectEmailProvider;capabilities:DirectEmailCapability[];account_id?:string};
export type DirectEmailStatus={schema_version:'deft.email_connection.v1';request_id:string;provider:DirectEmailProvider;state:'preparing'|'pending'|'exchanging'|'connected'|'failed'|'unknown'|'expired';expires_at:string;account_id:string|null;capabilities:DirectEmailCapability[];authorization_url?:string;primary_address?:string;display_label?:string;error?:'provider_denied'|'connection_failed'|'connection_unknown'};
export type DirectEmailPending={schema_version:1;session_tag:string;intent:DirectEmailIntent;expected_state?:string};
export const DIRECT_EMAIL_PENDING_KEY='deft-email-connection-v1';
export type DirectEmailProviders={providers:{provider:DirectEmailProvider;capabilities:DirectEmailCapability[]}[]};
export type DirectEmailFlowState={providers:DirectEmailProviders['providers'];status:DirectEmailStatus|null;pending:DirectEmailPending|null;busy:boolean;denied:boolean;notice:string};
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type HttpPort={fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean};
export class DirectEmailConnectionError extends Error{
 constructor(readonly kind:'denied'|'unavailable'|'invalid'|'not_found'|'rejected'){
  super(kind==='denied'?'Your account session changed. Return to Email and sign in again.':kind==='invalid'?'This connection link could not be verified. Return to Email settings.':kind==='not_found'?'This connection request was not found. Its outcome is not confirmed.':kind==='rejected'?'This account setup is unavailable with the selected access.':'Connection setup was not confirmed. Check its status before trying again.');
 }
}
const fail=():never=>{throw new DirectEmailConnectionError('invalid');};
const record=(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const safeText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const validId=(v:unknown):v is string=>safeText(v,256)&&v.length>0&&v.trim()===v;
const validUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v);
const validProvider=(v:unknown):v is DirectEmailProvider=>v==='gmail'||v==='microsoft';
const validCaps=(v:unknown):v is DirectEmailCapability[]=>Array.isArray(v)&&v.length>=1&&v.length<=3&&v.includes('read')&&new Set(v).size===v.length&&v.every(c=>['read','modify','send'].includes(c));
const validNonce=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(v);
function parseIntent(raw:unknown):DirectEmailIntent{if(!record(raw,['request_id','provider','capabilities'],['account_id'])||!validUuid(raw.request_id)||!validProvider(raw.provider)||!validCaps(raw.capabilities)||raw.account_id!==undefined&&!validId(raw.account_id))return fail();return raw as DirectEmailIntent;}
/** A cache fence, never authority. Exclude the local auth epoch so the exact
 * verified human SID survives a full-page provider redirect/token refresh. */
export async function directEmailSessionTag(scope:string):Promise<string>{
 const parts=scope.split(':');if(parts.length!==4||parts.slice(0,3).some(v=>!v)||decodeURIComponent(parts[2])==='legacy')return fail();
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts.slice(0,3))));return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
export function directEmailAuthorization(url:string,selected:DirectEmailProvider):{url:string;state:string}{
 let parsed:URL;try{parsed=new URL(url);}catch{return fail();}
 if(parsed.protocol!=='https:'||parsed.port||parsed.username||parsed.password||parsed.hash||!/^https:\/\/(?:accounts\.google\.com|login\.microsoftonline\.com)\//iu.test(url))return fail();
 if(selected==='gmail'?parsed.hostname!=='accounts.google.com'||parsed.pathname!=='/o/oauth2/v2/auth':parsed.hostname!=='login.microsoftonline.com'||!/^\/[A-Za-z0-9._-]+\/oauth2\/v2\.0\/authorize$/u.test(parsed.pathname))return fail();
 if(parsed.searchParams.getAll('state').length!==1)return fail();const state=parsed.searchParams.get('state');if(!validNonce(state))return fail();return {url:parsed.href,state};
}
export function parseDirectEmailStatus(raw:unknown,intent:DirectEmailIntent):DirectEmailStatus{
 if(!record(raw,['schema_version','request_id','provider','state','expires_at','account_id','capabilities'],['authorization_url','primary_address','display_label','error'])||raw.schema_version!=='deft.email_connection.v1'||!validUuid(raw.request_id)||!validProvider(raw.provider)||!['preparing','pending','exchanging','connected','failed','unknown','expired'].includes(String(raw.state))||!safeText(raw.expires_at,40)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(raw.expires_at)||!Number.isFinite(Date.parse(raw.expires_at))||raw.account_id!==null&&!validId(raw.account_id)||!validCaps(raw.capabilities)||raw.authorization_url!==undefined&&!safeText(raw.authorization_url,16384)||raw.primary_address!==undefined&&(!safeText(raw.primary_address,320)||!/^\S+@[^\s@]+\.[^\s@]+$/u.test(raw.primary_address))||raw.display_label!==undefined&&!safeText(raw.display_label,256)||raw.error!==undefined&&!['provider_denied','connection_failed','connection_unknown'].includes(String(raw.error)))return fail();const value=raw as DirectEmailStatus;
 if(value.request_id!==intent.request_id||value.provider!==intent.provider||value.capabilities.some(v=>!intent.capabilities.includes(v))||(value.state==='connected')!==(value.account_id!==null)||value.state==='connected'&&intent.account_id&&value.account_id!==intent.account_id)return fail();
 if(value.state==='pending'){if(!value.authorization_url)return fail();directEmailAuthorization(value.authorization_url,value.provider);}else if(value.authorization_url!==undefined)return fail();
 if(value.state!=='connected'&&(value.primary_address!==undefined||value.display_label!==undefined))return fail();return value;
}
export function parseDirectEmailProviders(raw:unknown):DirectEmailProviders{
 if(!record(raw,['providers'])||!Array.isArray(raw.providers)||raw.providers.length>2||raw.providers.some(v=>!record(v,['provider','capabilities'])||!validProvider(v.provider)||!validCaps(v.capabilities)))return fail();const result=raw as DirectEmailProviders;if(new Set(result.providers.map(v=>v.provider)).size!==result.providers.length)return fail();return result;
}
export function readDirectEmailPending(storage:StoragePort,tag:string):DirectEmailPending|null{
 try{const raw=storage.getItem(DIRECT_EMAIL_PENDING_KEY);if(!raw)return null;if(raw.length>8192)throw Error('Invalid pointer');const value:unknown=JSON.parse(raw);if(!record(value,['schema_version','session_tag','intent'],['expected_state'])||value.schema_version!==1||value.session_tag!==tag||!/^[a-f0-9]{64}$/u.test(tag)||value.expected_state!==undefined&&!validNonce(value.expected_state))throw Error('Invalid pointer');parseIntent(value.intent);return value as DirectEmailPending;}catch{try{storage.removeItem(DIRECT_EMAIL_PENDING_KEY);}catch{}return null;}
}
export function directEmailCallback(search:string,pending:DirectEmailPending):{state:string;code:string}|{state:string;error:string}{
 const params=new URLSearchParams(search);if(params.getAll('state').length!==1||params.getAll('code').length>1||params.getAll('error').length>1||params.has('code')===params.has('error'))return fail();
 const state=params.get('state');if(!pending.expected_state||state!==pending.expected_state)return fail();
 if(params.has('code')){const code=params.get('code');if(!safeText(code,4096)||!code)return fail();return {state:state!,code};}const error=params.get('error');if(!safeText(error,128)||!error||!/^[a-zA-Z0-9_.-]+$/u.test(error))return fail();return {state:state!,error};
}
export function directEmailCallbackMatches(search:string,storage:StoragePort,tag:string):boolean{
 const pending=readDirectEmailPending(storage,tag),params=new URLSearchParams(search);return !!pending?.expected_state&&params.getAll('state').length===1&&params.get('state')===pending.expected_state;
}
async function json(ports:HttpPort,path:string,init:RequestInit):Promise<unknown>{
 if(!ports.current())throw new DirectEmailConnectionError('denied');const signal=AbortSignal.any([init.signal??new AbortController().signal,AbortSignal.timeout(15000)]);
 const response=await ports.fetch(path,{...init,cache:'no-store',signal});
 if(!ports.current()){await response.body?.cancel().catch(()=>{});throw new DirectEmailConnectionError('denied');}
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw new DirectEmailConnectionError([401,403].includes(response.status)?'denied':response.status===404?'not_found':[400,422].includes(response.status)?'rejected':'unavailable');}
 if(!response.body)throw new DirectEmailConnectionError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)throw new DirectEmailConnectionError('unavailable');text+=decoder.decode(part.value,{stream:true});}if(!ports.current())throw new DirectEmailConnectionError('denied');return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const base='/api/email/connections';
async function readStatus(ports:HttpPort,pending:DirectEmailPending,signal?:AbortSignal){return parseDirectEmailStatus(await json(ports,`${base}/requests/${encodeURIComponent(pending.intent.request_id)}`,{method:'GET',signal}),pending.intent);}
export const directEmailStatusNotice=(status:DirectEmailStatus)=>status.state==='connected'?'Account connected. New mail will appear as it syncs.':status.state==='pending'?'Ready to continue with your provider.':status.state==='preparing'?'Connection setup is being prepared. Check its status.':status.state==='exchanging'?'Your provider connection is being checked. Check its status before another action.':status.state==='unknown'?'The connection outcome is not confirmed. Check status; this request will not be repeated.':status.state==='expired'?'Connection setup expired. You can start a new connection.':status.error==='provider_denied'?'Connection was declined. You can choose different access and try again.':'Connection setup failed. You can start a new connection.';
/** One exact begin intent at a time. Persist its non-secret recovery pointer
 * before POST; interrupted requests are recovered by GET, never replayed. */
export function createDirectEmailConnections(ports:HttpPort&{storage:StoragePort;sessionTag:string;change:(value:DirectEmailFlowState)=>void;connected:()=>void;uuid?:()=>string;now?:()=>number}){
 const controller=new AbortController();let active=true;
 let value:DirectEmailFlowState={providers:[],status:null,pending:readDirectEmailPending(ports.storage,ports.sessionTag),busy:false,denied:false,notice:''};
 const current=()=>active&&!controller.signal.aborted&&ports.current();const http={fetch:ports.fetch,current};
 const publish=()=>{if(current())ports.change(structuredClone(value));};
 const removePointer=()=>{try{ports.storage.removeItem(DIRECT_EMAIL_PENDING_KEY);}catch{}};
 const unavailable=(error:unknown)=>{value.notice=error instanceof DirectEmailConnectionError?error.message:new DirectEmailConnectionError('unavailable').message;if(error instanceof DirectEmailConnectionError&&error.kind==='denied'){value.denied=true;value.status=null;value.pending=null;removePointer();}};
 const accept=(status:DirectEmailStatus)=>{if(status.state==='pending'&&value.pending){const state=directEmailAuthorization(status.authorization_url!,status.provider).state;if(value.pending.expected_state&&value.pending.expected_state!==state)return fail();const next={...value.pending,expected_state:state};ports.storage.setItem(DIRECT_EMAIL_PENDING_KEY,JSON.stringify(next));value.pending=next;}value.status=status;value.notice=directEmailStatusNotice(status);if(status.state==='connected'){try{ports.connected();}catch{}}};
 const check=async()=>{if(!value.pending)return false;try{const result=await readStatus(http,value.pending,controller.signal);if(current())accept(result);return false;}catch(error){if(current())unavailable(error);return error instanceof DirectEmailConnectionError&&error.kind==='not_found';}};
 return {
  async load(){if(!current()||value.busy||value.denied)return;value.busy=true;publish();try{const providers=await json(http,`${base}/providers`,{method:'GET',signal:controller.signal});if(current())value.providers=parseDirectEmailProviders(providers).providers;}catch(error){if(current())unavailable(error);}if(current()&&!value.denied)await check();value.busy=false;publish();},
  async begin(selected:DirectEmailProvider,caps:DirectEmailCapability[],accountId?:string){
   if(!current()||value.busy||value.denied||value.pending)return;const configured=value.providers.find(v=>v.provider===selected);if(!configured||caps.some(v=>!configured.capabilities.includes(v)))return;
   let intent:DirectEmailIntent;try{intent=parseIntent({request_id:(ports.uuid??(()=>crypto.randomUUID()))(),provider:selected,capabilities:caps,...(accountId?{account_id:accountId}:{})});}catch{return;}
   value.pending={schema_version:1,session_tag:ports.sessionTag,intent};value.busy=true;value.notice='Preparing account setup…';
   try{ports.storage.setItem(DIRECT_EMAIL_PENDING_KEY,JSON.stringify(value.pending));}catch{value.pending=null;value.busy=false;value.notice='This browser could not retain connection status. Account setup was not started.';publish();return;}publish();
   try{const result=await json(http,`${base}/begin`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(intent)});if(current())accept(parseDirectEmailStatus(result,intent));}
   catch(error){if(current()){unavailable(error);if(!value.denied){const missing=await check();if(current()&&missing&&error instanceof DirectEmailConnectionError&&error.kind==='rejected'){removePointer();value.pending=null;value.status=null;value.notice='This account setup is unavailable with the selected access. You can choose another connection.';}}}}finally{value.busy=false;publish();}
  },
  async check(){if(!current()||value.busy||value.denied||!value.pending)return;value.busy=true;publish();await check();value.busy=false;publish();},
  continuation(){if(!current()||value.busy||!value.pending||value.status?.state!=='pending'||Date.parse(value.status.expires_at)<=(ports.now??Date.now)())return null;return directEmailAuthorization(value.status.authorization_url!,value.status.provider).url;},
  reset(){if(!current()||value.busy||!value.status||!['connected','failed','expired'].includes(value.status.state))return;removePointer();value={...value,status:null,pending:null,notice:''};publish();},
  snapshot:()=>structuredClone(value),dispose(){active=false;controller.abort();value.status=null;},
 };
}
/** The caller shares this single promise across effect replay. A removed query
 * on reload means GET recovery only. Codes live only in this call's memory. */
export async function completeDirectEmailConnection(ports:HttpPort&{storage:StoragePort;sessionTag:string;search:string}):Promise<DirectEmailStatus>{
 try{
 const pending=readDirectEmailPending(ports.storage,ports.sessionTag);if(!pending)throw new DirectEmailConnectionError('invalid');
 if(!ports.search)return await readStatus(ports,pending);
 const input=directEmailCallback(ports.search,pending);
 try{return parseDirectEmailStatus(await json(ports,`${base}/callback`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),pending.intent);}
 catch(error){if(error instanceof DirectEmailConnectionError&&['invalid','denied'].includes(error.kind))throw error;return await readStatus(ports,pending);}
 }catch(error){if(error instanceof DirectEmailConnectionError)throw error;throw new DirectEmailConnectionError('unavailable');}
}
