export type NativeEmailCapability='read'|'modify'|'send';
export type NativeAccountLifecycle={schema_version:'deft.email_account_lifecycle.v1';account_id:string;provider:'gmail'|'microsoft'|'imap_smtp';authority_mode:'legacy'|'standalone';state:'active'|'paused'|'disconnected'|'revoked';revision:number;native_revision:number;credential_revision:number|null;capabilities:NativeEmailCapability[];available_capabilities:NativeEmailCapability[];adoption_available:boolean;connection_available:boolean};
export type NativeAccountManagement=Pick<NativeAccountLifecycle,'account_id'|'provider'|'authority_mode'|'state'|'revision'|'native_revision'>&{primary_address?:string;display_label?:string};
export function nativeManagedAccountIdentity(account:NativeAccountManagement,current:readonly {account_id:string;primary_address:string;display_label:string}[]):NativeAccountManagement{
 const known=current.find(row=>row.account_id===account.account_id);return {...account,primary_address:account.primary_address?.trim()?account.primary_address:known?.primary_address??'',display_label:account.display_label?.trim()?account.display_label:known?.display_label??''};
}
export type NativeLifecycleOperation='adopt'|'consent'|'pause'|'disconnect'|'reconnect'|'revoke';
export type NativeLifecycleState={value:NativeAccountLifecycle|null;busy:boolean;needsReload:boolean;denied:boolean;notice:string};
const identifier=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const revision=(v:unknown,min=1):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2147483646;
const caps=(v:unknown):v is NativeEmailCapability[]=>Array.isArray(v)&&v.length<=3&&new Set(v).size===v.length&&v.every(c=>['read','modify','send'].includes(c));
const fail=():never=>{throw Error('Email account settings could not be confirmed. Reload before making changes.');};
function base(raw:unknown):NativeAccountManagement{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const v=raw as NativeAccountManagement;
 if(!identifier(v.account_id)||!['gmail','microsoft','imap_smtp'].includes(v.provider)||!['legacy','standalone'].includes(v.authority_mode)||!['active','paused','disconnected','revoked'].includes(v.state)
  ||!revision(v.revision,0)||!revision(v.native_revision)||v.authority_mode==='legacy'&&v.revision!==0||v.authority_mode==='standalone'&&v.revision<1)return fail();return v;
}
export function parseNativeAccountLifecycle(raw:unknown,accountId:string):NativeAccountLifecycle{
 const v=base(raw) as NativeAccountLifecycle;
 if(Object.keys(v).some(k=>!['schema_version','account_id','provider','authority_mode','state','revision','native_revision','credential_revision','capabilities','available_capabilities','adoption_available','connection_available'].includes(k))||v.schema_version!=='deft.email_account_lifecycle.v1'||v.account_id!==accountId
  ||v.credential_revision!==null&&!revision(v.credential_revision)||!caps(v.capabilities)||!v.capabilities.includes('read')||!caps(v.available_capabilities)||typeof v.adoption_available!=='boolean'||typeof v.connection_available!=='boolean'||v.authority_mode==='standalone'&&v.adoption_available)return fail();
 return structuredClone(v);
}
export function parseNativeAccountManagement(raw:unknown):{accounts:NativeAccountManagement[];has_more:boolean}{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['accounts','has_more'].includes(k)))return fail();const v=raw as {accounts:unknown[];has_more:boolean};
 if(!Array.isArray(v.accounts)||v.accounts.length>50||typeof v.has_more!=='boolean')return fail();
 const accounts=v.accounts.map(row=>{const item=base(row);if(Object.keys(item).some(k=>!['account_id','provider','authority_mode','state','revision','native_revision','primary_address','display_label'].includes(k))||[item.primary_address,item.display_label].some(s=>s!==undefined&&(typeof s!=='string'||s.length>320||/[\u0000-\u001f\u007f-\u009f]/u.test(s))))return fail();return {...item};});
 if(new Set(accounts.map(a=>a.account_id)).size!==accounts.length)return fail();return {accounts,has_more:v.has_more};
}
type Options={current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>};
class LifecycleError extends Error{constructor(readonly status:number){super(status===403||status===401?'Account access ended.':status===409?'These settings changed elsewhere. Reload them before continuing.':status===422?'This connection or requested access is unavailable. Check the account connection, then reload.':'Account settings could not be confirmed. Reload before continuing.');}}
async function request(options:Options,path:string,controller:AbortController,body?:unknown){
 const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);if(!options.current())throw new LifecycleError(403);
 const response=await options.fetch(path,{method:body?'PATCH':'GET',cache:'no-store',signal,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 if(!options.current()||signal.aborted){await response.body?.cancel().catch(()=>{});throw new LifecycleError(signal.aborted?503:403);}if(response.status!==200){await response.body?.cancel().catch(()=>{});throw new LifecycleError(response.status);}
 if(!response.body)return fail();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{for(;;){signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();if(!options.current())throw new LifecycleError(403);if(chunk.done)break;size+=chunk.value.length;if(size>65536)return fail();text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();return JSON.parse(text) as unknown;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createNativeAccountLifecycle(options:Options&{accountId:string;change:(state:NativeLifecycleState)=>void;changed:(value:NativeAccountLifecycle)=>void;denied:()=>void}){
 if(!identifier(options.accountId))return fail();const controller=new AbortController();let active=true,held=false;
 let state:NativeLifecycleState={value:null,busy:false,needsReload:false,denied:false,notice:''};const current=()=>active&&!controller.signal.aborted&&options.current(),change=(patch:Partial<NativeLifecycleState>)=>{if(current()){state={...state,...patch};options.change(structuredClone(state));}};
 const error=(cause:unknown)=>{if(!current())return;if(cause instanceof LifecycleError&&[401,403].includes(cause.status)){change({value:null,denied:true,needsReload:true,notice:cause.message});options.denied();}else change({needsReload:true,notice:cause instanceof Error?cause.message:'Reload account settings before continuing.'});};
 const path=`/api/email/accounts/${encodeURIComponent(options.accountId)}/lifecycle`;
 return {snapshot:()=>structuredClone(state),load:async()=>{if(held||!current()||state.denied)return;held=true;change({busy:true,notice:'Checking account settings…'});
  try{const value=parseNativeAccountLifecycle(await request({...options,current},path,controller),options.accountId);change({value,needsReload:false,notice:''});if(current()&&value.state!=='active')options.changed(value);}
  catch(cause){error(cause);}finally{held=false;change({busy:false});}
 },apply:async(operation:NativeLifecycleOperation,selected?:NativeEmailCapability[])=>{
  const old=state.value;if(held||!current()||state.denied||state.needsReload||!old||old.state==='revoked'||!['adopt','consent','pause','disconnect','reconnect','revoke'].includes(operation))return;
  if(operation==='adopt'&&(old.authority_mode!=='legacy'||!old.adoption_available)||operation!=='adopt'&&old.authority_mode!=='standalone'||operation==='consent'&&old.state!=='active'||operation==='reconnect'&&(!['paused','disconnected'].includes(old.state)||!old.connection_available))return;
  if(['adopt','consent'].includes(operation)&&(!caps(selected)||!selected.includes('read')||selected.some(c=>!old.available_capabilities.includes(c))||!old.connection_available))return;
  held=true;change({busy:true,notice:'Updating this Email account…'});
  try{const value=parseNativeAccountLifecycle(await request({...options,current},path,controller,{expected_revision:old.revision,expected_native_revision:old.native_revision,operation,...(['adopt','consent'].includes(operation)?{capabilities:selected}:{})}),options.accountId);
   const expectedState=operation==='pause'?'paused':operation==='disconnect'?'disconnected':operation==='revoke'?'revoked':'active';
   if(value.provider!==old.provider||value.authority_mode!=='standalone'||value.state!==expectedState||value.revision!==old.revision+1||value.native_revision!==old.native_revision+1||selected&&['adopt','consent'].includes(operation)&&JSON.stringify([...value.capabilities].sort())!==JSON.stringify([...selected].sort()))return fail();
   change({value,notice:operation==='revoke'?'Email access revoked. Saved mail and drafts were not deleted.':operation==='pause'?'This Email account is paused.':operation==='disconnect'?'This account is disconnected from Email.':'Account settings saved.'});if(current())options.changed(value);
   // Stopping Email need not inspect provider custody in its write transaction.
   // A false connection proof on that acknowledgement is not a failed login.
   if(['pause','disconnect'].includes(operation)&&!value.connection_available&&current()){
    change({notice:'Account access stopped. Checking the retained connection…'});
    const refreshed=parseNativeAccountLifecycle(await request({...options,current},path,controller),options.accountId);
    if(refreshed.provider!==value.provider||refreshed.authority_mode!=='standalone'||refreshed.revision<value.revision||refreshed.native_revision<value.native_revision)return fail();
    change({value:refreshed,needsReload:false,notice:refreshed.connection_available?'Account access stopped. The retained connection is available.':'Account access stopped. Check account connections before reconnecting.'});if(current())options.changed(refreshed);
   }
  }catch(cause){error(cause);}finally{held=false;change({busy:false});}
 },dispose:()=>{active=false;controller.abort();state={...state,value:null};}};
}
export function createNativeAccountManagement(options:Options&{change:(state:{accounts:NativeAccountManagement[];has_more:boolean;busy:boolean;notice:string})=>void;denied?:()=>void}){
 const controller=new AbortController();let active=true,held=false;let state={accounts:[] as NativeAccountManagement[],has_more:false,busy:false,notice:''};const current=()=>active&&!controller.signal.aborted&&options.current();const emit=()=>{if(current())options.change(structuredClone(state));};
 return {load:async()=>{if(held||!current())return;held=true;state={...state,busy:true,notice:'Loading Email account management…'};emit();try{const page=parseNativeAccountManagement(await request({...options,current},'/api/email/accounts/lifecycle',controller));if(current())state={...state,...page,notice:''};}catch(cause){if(current()){const denied=cause instanceof LifecycleError&&[401,403].includes(cause.status);state={...state,...(denied?{accounts:[],has_more:false}:{}),notice:cause instanceof Error?cause.message:'Account management is unavailable.'};if(denied)options.denied?.();}}finally{held=false;state={...state,busy:false};emit();}},dispose:()=>{active=false;controller.abort();state={...state,accounts:[]};}};
}
