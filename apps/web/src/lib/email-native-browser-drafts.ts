import {createNativeDraftApi,createNativeDraftWriter,NativeDraftError,nativeDraftTextCopy,parseNativeDraftContent} from './email-native-drafts';
import {createNativeEmailSend} from './email-native-send';
import {createNativeOutboxSend} from './email-native-outbox';
import type {NativeComposeSelection} from '../components/email/native-email-composer';
import type {NativeOfflineDraftMetadata,NativeOfflineDraftScope,NativeOfflineDraftSnapshot} from './email-native-offline-drafts';

type Journal={listAccount:()=>Promise<NativeOfflineDraftMetadata[]>;read:()=>Promise<NativeOfflineDraftSnapshot|null>;readConflict:(branchId:string)=>Promise<NativeOfflineDraftSnapshot>};
type SourceCheck='missing'|'human'|'agent'|'blocked';
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
/** Read-only source inspection preserves agent provenance and uncertain-send locks. */
export async function checkNativeBrowserDraftSource(accountId:string,draftId:string,ports:{current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>},signal:AbortSignal):Promise<SourceCheck>{
 const current=()=>ports.current()&&!signal.aborted,fetch=(path:string,init:RequestInit)=>ports.fetch(path,{...init,signal:init.signal?AbortSignal.any([signal,init.signal]):signal});
 const client=createNativeDraftApi(fetch,current);
 try{
  let source;try{source=await client.read(accountId,draftId);}catch(error){if(error instanceof NativeDraftError&&error.kind==='missing'&&current())return 'missing';throw error;}
  if(source.origin.kind==='agent')return 'agent';if(source.status!=='draft')return 'blocked';
  const writer=createNativeDraftWriter({accountId,draftId,api:client,initial:source,current,change:()=>{}});
  const legacy=createNativeEmailSend({accountId,draftId,current,fetch,writer:()=>writer,change:()=>{},denied:()=>{},accepted:()=>{}});
  const outbox=createNativeOutboxSend({accountId,draftId,current,fetch,writer:()=>writer,change:()=>{},rowChanged:()=>{},denied:()=>{},queued:()=>{},accepted:()=>{},cancelled:()=>{},legacyInspect:async(revision,submitted)=>{await legacy.inspect(revision,submitted);return legacy.snapshot();}});
  try{await outbox.inspect(source.content_revision??source.revision);if(!current())throw Error('Browser recovery access ended.');const status=outbox.snapshot();return status.state==='idle'&&!status.locked&&!status.busy?'human':'blocked';}
  finally{outbox.dispose();legacy.dispose();writer.dispose();}
 }finally{client.dispose();}
}

/** Discovery never writes a journal, overwrites a draft, or supplies send authority. */
export function createNativeBrowserDraftDiscovery(options:{owner:{orgId:string;userId:string};current:()=>boolean;prove:(accountId:string,signal:AbortSignal)=>Promise<void>;open:(scope:NativeOfflineDraftScope,authorize:()=>boolean)=>Promise<Journal>;checkSource:(accountId:string,draftId:string,signal:AbortSignal)=>Promise<SourceCheck>;deadlineMs?:number}){
 let active=true;const controllers=new Set<AbortController>(),current=()=>active&&options.current();
 const operation=async<T>(accountId:string,draftId:string,work:(journal:Journal,signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();controllers.add(controller);let proved=false,timer:ReturnType<typeof setTimeout>|undefined;
  const authorized=()=>current()&&proved&&!controller.signal.aborted,check=()=>{controller.signal.throwIfAborted();if(!current())throw Error('Browser recovery access ended.');};
  try{return await Promise.race([(async()=>{check();await options.prove(accountId,controller.signal);check();proved=true;const journal=await options.open({...options.owner,accountId,draftId},authorized);check();const result=await work(journal,controller.signal);check();return result;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Browser drafts could not be checked. Try Refresh.'));},options.deadlineMs??8000);})]);}
  finally{if(timer)clearTimeout(timer);controller.abort();controllers.delete(controller);}
 };
 return {
  list(accountId:string){return operation(accountId,'discovery',async journal=>(await journal.listAccount()).filter(row=>uuid(row.draftId)&&(row.dirty||row.sendOutcome==='unknown')).sort((a,b)=>b.updatedAt-a.updatedAt));},
  open(accountId:string,row:NativeOfflineDraftMetadata):Promise<NativeComposeSelection>{
   if(!uuid(row.draftId)||row.sendOutcome!=='none')return Promise.reject(Error('Check the saved draft’s sending outcome before opening a browser copy.'));
   return operation(accountId,row.draftId,async(journal,signal)=>{
    const source=await options.checkSource(accountId,row.draftId,signal);signal.throwIfAborted();if(!current())throw Error('Browser recovery access ended.');
    if(source==='agent')throw Error('This copy comes from an agent draft. Open the saved draft to review its recipients and message.');
    if(source==='blocked'||source==='missing'&&row.baseServerRevision!==0)throw Error('Open the saved draft and check its sending status before using this browser copy.');
    const saved=row.branchId?await journal.readConflict(row.branchId):await journal.read();
    if(!saved||saved.sendOutcome!=='none'||saved.localRevision!==row.localRevision||saved.baseServerRevision!==row.baseServerRevision)throw Error('This browser copy changed. Refresh Drafts before opening it.');
    const content=parseNativeDraftContent(saved.content);
    return {accountId,initialContent:nativeDraftTextCopy(content),notice:'Browser text opened as a new draft. Review recipients and message; add attachments again before sending.'};
   });
  },
  dispose(){active=false;for(const controller of controllers)controller.abort();controllers.clear();}
 };
}
