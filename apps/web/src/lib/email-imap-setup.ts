export type ImapSetupTarget={account_id:string;resource_binding_id:string;credential_revision:number;display_label:string;primary_address:string;state:'available'|'active'|'needs_attention'};
export type ImapProfile={host:string;port:number;transport:'implicit_tls'|'starttls_required';username:string;password:string;identity:{primary_address:string;display_label:string};smtp?:{host:string;port:number;transport:'implicit_tls'|'starttls_required';username:string;password:string}};
export class ImapSetupError extends Error{constructor(readonly kind:'denied'|'conflict'|'unavailable'|'invalid'){super(kind==='denied'?'Account setup access changed. Reload Email settings.':kind==='conflict'?'This account setup changed. Reload its saved status before connecting again.':kind==='invalid'?'Check the server, account name and password. Use the secure ports shown.':'Account setup could not be confirmed. Reload its status before trying again.');}}
const id=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function parseImapSetupTargets(raw:unknown):{items:ImapSetupTarget[];has_more:boolean}{
 if(!object(raw)||Object.keys(raw).sort().join(',')!=='has_more,items'||typeof raw.has_more!=='boolean'||!Array.isArray(raw.items)||raw.items.length>50)throw new ImapSetupError('unavailable');
 const items=raw.items.map(value=>{
  if(!object(value)||Object.keys(value).sort().join(',')!=='account_id,credential_revision,display_label,primary_address,resource_binding_id,state'||!id(value.account_id)||typeof value.resource_binding_id!=='string'||!uuid.test(value.resource_binding_id)||!Number.isSafeInteger(value.credential_revision)||(value.credential_revision as number)<0||(value.credential_revision as number)>2147483645||typeof value.display_label!=='string'||value.display_label.length>256||typeof value.primary_address!=='string'||value.primary_address.length>320||/[\u0000-\u001f\u007f-\u009f]/u.test(value.primary_address+value.display_label)||!['available','active','needs_attention'].includes(String(value.state)))throw new ImapSetupError('unavailable');
  return value as ImapSetupTarget;
 });if(new Set(items.map(value=>value.account_id)).size!==items.length||new Set(items.map(value=>value.resource_binding_id)).size!==items.length)throw new ImapSetupError('unavailable');return {items,has_more:raw.has_more};
}
async function json(response:Response,signal:AbortSignal,max=65536){
 if(!response.body)throw Error();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{for(;;){signal.throwIfAborted();const item=await reader.read();signal.throwIfAborted();if(item.done)break;bytes+=item.value.byteLength;if(bytes>max)throw Error();text+=decoder.decode(item.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
type Ports={fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean};
async function request(path:string,ports:Ports,signal:AbortSignal,input?:unknown,max=65536){
 if(!ports.current())throw new ImapSetupError('denied');signal.throwIfAborted();
 const response=await ports.fetch(path,{method:input?'POST':'GET',cache:'no-store',signal,headers:{'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});
 if(!ports.current()){await response.body?.cancel().catch(()=>{});throw new ImapSetupError('denied');}signal.throwIfAborted();
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw new ImapSetupError([401,403].includes(response.status)?'denied':response.status===409?'conflict':response.status===400||response.status===422?'invalid':'unavailable');}
 const value=await json(response,signal,max);if(!ports.current())throw new ImapSetupError('denied');signal.throwIfAborted();return value;
}
export async function loadImapSetupTargets(ports:Ports,ownedSignal?:AbortSignal){try{return parseImapSetupTargets(await request('/api/email/imap-setup-targets',ports,AbortSignal.any([...(ownedSignal?[ownedSignal]:[]),AbortSignal.timeout(20000)])));}catch(error){if(error instanceof ImapSetupError)throw error;throw new ImapSetupError('unavailable');}}
export async function submitImapSetup(target:ImapSetupTarget,profile:ImapProfile,ports:Ports,ownedSignal?:AbortSignal){
 try{
  parseImapSetupTargets({items:[target],has_more:false});
  const validServer=(value:ImapProfile|NonNullable<ImapProfile['smtp']>,smtp=false)=>!!value.host&&value.host.length<=253&&!!value.username&&value.username.length<=512&&!!value.password&&value.password.length<=8192&&!value.password.includes('\u0000')&&(value.transport==='implicit_tls'&&value.port===(smtp?465:993)||value.transport==='starttls_required'&&value.port===(smtp?587:143));
  if(!validServer(profile)||profile.smtp&&!validServer(profile.smtp,true)||!profile.identity.primary_address||profile.identity.primary_address.length>320||!profile.identity.display_label||profile.identity.display_label.length>256)throw new ImapSetupError('invalid');
  const value=await request('/api/email/accounts/'+encodeURIComponent(target.account_id)+'/imap-setup',ports,AbortSignal.any([...(ownedSignal?[ownedSignal]:[]),AbortSignal.timeout(60000)]),{resource_binding_id:target.resource_binding_id,expected_revision:target.credential_revision,profile},8192);
  if(!object(value)||Object.keys(value).sort().join(',')!=='account_id,authority_revision,provider,state'||value.account_id!==target.account_id||value.provider!=='imap_smtp'||value.state!=='active'||!Number.isSafeInteger(value.authority_revision)||(value.authority_revision as number)<1)throw new ImapSetupError('unavailable');
  return {account_id:target.account_id,state:'active' as const};
 }catch(error){if(error instanceof ImapSetupError)throw error;throw new ImapSetupError('unavailable');}
 finally{profile.password='';if(profile.smtp)profile.smtp.password='';}
}
