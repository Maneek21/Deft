export type EmailKnowledgePolicy = {
  enabled: boolean;
  destination: {scope: 'user'|'space'; space_id: string|null};
  history_days: number;
  include_bulk: boolean;
  excluded_senders: string[];
  excluded_folders: string[];
};
export type EmailKnowledgeSettings = EmailKnowledgePolicy & {
  revision: number;
  progress: {processed:number; captured:number; skipped:number; last_error_code:string|null};
};
export type EmailRelatedKnowledge = {
  items: {id:string; page_id:string; title:string; url:string; status:'captured'|'updated'}[];
  suppressed:boolean;
};
export type EmailAgentOperation = 'read'|'draft'|'triage'|'send';
export function toggleEmailAgentOperation(selected:EmailAgentOperation[],operation:EmailAgentOperation,enabled:boolean):EmailAgentOperation[] {
  const next=new Set(selected);
  if(enabled){next.add(operation);if(operation!=='read')next.add('read');if(operation==='send')next.add('draft');}
  else {next.delete(operation);if(operation==='read')next.clear();else if(operation==='draft')next.delete('send');}
  return (['read','draft','triage','send'] as const).filter(value=>next.has(value));
}
export type EmailAgentAccess = {
  defty_principal_id:string;
  grants:{id:string; principal_kind:'defty'|'personal_mcp'; principal_id:string; operations:EmailAgentOperation[]; revision:number; revoked_at:string|null}[];
  personal_tokens:{id:string; name:string}[];
};
export class EmailConnectedError extends Error {
  constructor(readonly kind:'denied'|'conflict'|'unavailable') {
    super(kind==='denied'?'Account access changed. Check the connection in Email settings.':kind==='conflict'?'These settings changed elsewhere. Reload the saved settings.':'The result could not be confirmed. Reload before making another change.');
  }
}
function record(raw:unknown):Record<string,unknown> {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new EmailConnectedError('unavailable');
  return raw as Record<string,unknown>;
}
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/u.test(value);
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function strings(raw:unknown):string[] {
  if(!Array.isArray(raw)||raw.length>500||raw.some(value=>!id(value)))throw new EmailConnectedError('unavailable');
  return [...raw];
}
export function parseEmailKnowledgeSettings(raw:unknown):EmailKnowledgeSettings {
  const row=record(raw),destination=record(row.destination),progress=record(row.progress);
  if(typeof row.enabled!=='boolean'||typeof row.include_bulk!=='boolean'||!count(row.revision)||!Number.isSafeInteger(row.history_days)||Number(row.history_days)<1||Number(row.history_days)>365||!['user','space'].includes(String(destination.scope))||(destination.scope==='user'?destination.space_id!==null:!id(destination.space_id))||!count(progress.processed)||!count(progress.captured)||!count(progress.skipped)||progress.last_error_code!==null&&!id(progress.last_error_code))throw new EmailConnectedError('unavailable');
  return {enabled:row.enabled,destination:{scope:destination.scope as 'user'|'space',space_id:destination.space_id as string|null},history_days:Number(row.history_days),include_bulk:row.include_bulk,excluded_senders:strings(row.excluded_senders),excluded_folders:strings(row.excluded_folders),revision:Number(row.revision),progress:{processed:Number(progress.processed),captured:Number(progress.captured),skipped:Number(progress.skipped),last_error_code:progress.last_error_code as string|null}};
}
export function parseEmailRelatedKnowledge(raw:unknown):EmailRelatedKnowledge {
  const row=record(raw);
  if(typeof row.suppressed!=='boolean'||!Array.isArray(row.items)||row.items.length>100)throw new EmailConnectedError('unavailable');
  const items=row.items.map(raw=>{
    const item=record(raw);
    if(!id(item.id)||!id(item.page_id)||typeof item.title!=='string'||item.title.length>2048||typeof item.url!=='string'||!['captured','updated'].includes(String(item.status)))throw new EmailConnectedError('unavailable');
    const url=new URL(item.url,'https://deft.invalid');
    if(!item.url.startsWith('/')||url.origin!=='https://deft.invalid'||url.pathname!=='/knowledge'||url.hash||[...url.searchParams.keys()].length!==1||!id(url.searchParams.get('slug')))throw new EmailConnectedError('unavailable');
    return {id:item.id,page_id:item.page_id,title:item.title,url:item.url,status:item.status as 'captured'|'updated'};
  });
  return {suppressed:row.suppressed,items:items.filter((item,index)=>items.findIndex(other=>other.page_id===item.page_id)===index)};
}
export function parseEmailAgentAccess(raw:unknown):EmailAgentAccess {
  const row=record(raw);
  if(!id(row.defty_principal_id)||!Array.isArray(row.grants)||row.grants.length>500||!Array.isArray(row.personal_tokens)||row.personal_tokens.length>500)throw new EmailConnectedError('unavailable');
  return {defty_principal_id:row.defty_principal_id,grants:row.grants.map(raw=>{
    const grant=record(raw),operations=strings(grant.operations);
    if(!id(grant.id)||!id(grant.principal_id)||!['defty','personal_mcp'].includes(String(grant.principal_kind))||!count(grant.revision)||operations.some(op=>!['read','draft','triage','send'].includes(op))||grant.revoked_at!==null&&typeof grant.revoked_at!=='string')throw new EmailConnectedError('unavailable');
    return {id:grant.id,principal_id:grant.principal_id,principal_kind:grant.principal_kind as 'defty'|'personal_mcp',operations:operations as EmailAgentOperation[],revision:Number(grant.revision),revoked_at:grant.revoked_at as string|null};
  }),personal_tokens:row.personal_tokens.map(raw=>{const token=record(raw);if(!id(token.id)||typeof token.name!=='string'||token.name.length>1024)throw new EmailConnectedError('unavailable');return {id:token.id,name:token.name};})};
}
/** One account and session own every request. Mutations are never retried here;
 * after a lost response callers must load the saved state before another write. */
export function createEmailConnectedClient(options:{accountId:string; current:()=>boolean; fetch:(path:string,init:RequestInit)=>Promise<Response>}) {
  if(!id(options.accountId))throw new EmailConnectedError('unavailable');
  let active=true;
  const pending=new Set<AbortController>();
  return {
    async request<T>(suffix:string,parse:(raw:unknown)=>T,body?:unknown):Promise<T> {
      const controller=new AbortController();pending.add(controller);
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
      const current=()=>active&&options.current()&&!signal.aborted;
      try {
        if(!current())throw new EmailConnectedError('denied');
        const response=await options.fetch('/api/email/accounts/'+encodeURIComponent(options.accountId)+suffix,{method:body===undefined?'GET':'PUT',cache:'no-store',signal,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
        if(!current()){await response.body?.cancel();throw new EmailConnectedError('denied');}
        if(!response.ok){await response.body?.cancel();throw new EmailConnectedError([401,403].includes(response.status)?'denied':response.status===409?'conflict':'unavailable');}
        if(!response.body)throw new EmailConnectedError('unavailable');
        const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
        const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
        try {for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;bytes+=part.value.length;if(bytes>128*1024)throw new EmailConnectedError('unavailable');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
        finally {signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
        if(!current())throw new EmailConnectedError('denied');
        const raw:unknown=JSON.parse(text);
        if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&'account_id' in raw&&(raw as {account_id:unknown}).account_id!==options.accountId)throw new EmailConnectedError('unavailable');
        return parse(raw);
      } catch(error) {if(error instanceof EmailConnectedError)throw error;throw new EmailConnectedError('unavailable');}
      finally {pending.delete(controller);}
    },
    dispose(){active=false;for(const controller of pending)controller.abort();pending.clear();},
  };
}
