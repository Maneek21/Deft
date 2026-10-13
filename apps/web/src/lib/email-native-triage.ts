export type NativeTriageKind='mark_read'|'mark_unread'|'star'|'unstar'|'archive'|'trash'|'move'|'labels'|'spam'|'not_spam'|'restore';
export type NativeTriageLabels={accountId:string;action:'add'|'remove';tokens:string[]};
export type NativeTriageSelection={accountId:string;token:string}|NativeTriageLabels;
export type NativeTriageTarget={account_id:string;logical_message_id:string};
export type NativeTriageFolderAcknowledgement=NativeTriageTarget&{operation_id:string;folders:string[]};
export type NativeTriageResult={schema_version:'deft.email_native_triage_result.v1';account_id:string;operation_id:string;operation:NativeTriageKind;
 items:{logical_message_id:string;state:'prepared'|'succeeded'|'failed'|'unknown';code?:string;undo_supported:boolean;confirmed_folders?:string[]}[];undo_available:boolean;automatic_retry:false};
export type NativeTriageGroup={accountId:string;operationId:string;kind:NativeTriageKind;ids:string[];state:'pending'|'complete'|'uncertain'|'failed'|'denied';result:NativeTriageResult|null;undoOf?:string;notice:string};
export type NativeTriageState={busy:boolean;groups:NativeTriageGroup[];summary:string};
const kinds:NativeTriageKind[]=['mark_read','mark_unread','star','unstar','archive','trash','move','labels','spam','not_spam','restore'];
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v);
const logical=(v:unknown):v is string=>typeof v==='string'&&/^mail_[a-f0-9]{64}$/u.test(v);
const folders=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=100&&new Set(v).size===v.length&&v.every(value=>typeof value==='string'&&/^(?:inbox|sent|spam|trash|drafts|starred|archive|label:[a-f0-9]{64})$/u.test(value));
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(key=>keys.includes(key));
async function readResult(response:Response,signal:AbortSignal){
 if(!response.body)throw Error();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>256*1024)throw Error();text+=decoder.decode(next.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function parseNativeTriageResult(raw:unknown,expected:Pick<NativeTriageGroup,'accountId'|'operationId'|'kind'|'ids'>):NativeTriageResult{
 const fail=():never=>{throw Error('The action result could not be confirmed.');};
 if(!closed(raw,['schema_version','account_id','operation_id','operation','items','undo_available','automatic_retry'])||raw.schema_version!=='deft.email_native_triage_result.v1'||raw.account_id!==expected.accountId||raw.operation_id!==expected.operationId||raw.operation!==expected.kind||!uuid(raw.operation_id)||raw.automatic_retry!==false||typeof raw.undo_available!=='boolean'||!Array.isArray(raw.items)||raw.items.length!==expected.ids.length||!raw.items.length||raw.items.length>25)return fail();
 const seen=new Set<string>();for(const item of raw.items){if(!closed(item,['logical_message_id','state','code','undo_supported','confirmed_folders'])||!logical(item.logical_message_id)||!expected.ids.includes(item.logical_message_id)||seen.has(item.logical_message_id)||typeof item.state!=='string'||!['prepared','succeeded','failed','unknown'].includes(item.state)||typeof item.undo_supported!=='boolean'||item.undo_supported&&item.state!=='succeeded'||item.code!==undefined&&(typeof item.code!=='string'||!/^[A-Z0-9_]{1,100}$/u.test(item.code))||item.confirmed_folders!==undefined&&(item.state!=='succeeded'||!folders(item.confirmed_folders)))return fail();seen.add(item.logical_message_id);}
 if(raw.undo_available!==raw.items.some(item=>item.undo_supported))return fail();return structuredClone(raw) as NativeTriageResult;
}
export function groupNativeTriageTargets(targets:readonly NativeTriageTarget[],kind:NativeTriageKind,destination?:NativeTriageSelection):Array<{accountId:string;ids:string[]}>{
 if(!kinds.includes(kind)||!targets.length||targets.length>100||targets.some(row=>!id(row.account_id)||!logical(row.logical_message_id))||new Set(targets.map(row=>JSON.stringify([row.account_id,row.logical_message_id]))).size!==targets.length)throw Error('Select up to 100 distinct messages.');
 const accounts=new Map<string,string[]>();for(const row of targets)accounts.set(row.account_id,[...(accounts.get(row.account_id)??[]),row.logical_message_id]);
 if(kind==='labels'){
  if(accounts.size!==1||!closed(destination,['accountId','action','tokens'])||!('tokens'in destination)||destination.accountId!==targets[0].account_id||destination.action!=='add'&&destination.action!=='remove'||!Array.isArray(destination.tokens)||!destination.tokens.length||destination.tokens.length>16||new Set(destination.tokens).size!==destination.tokens.length||destination.tokens.some(token=>typeof token!=='string'||!token||token.length>8192||!/^[A-Za-z0-9_-]+$/u.test(token)))throw Error('Choose up to 16 current labels from the same Gmail account.');
 }else if(kind==='move'?(accounts.size!==1||!closed(destination,['accountId','token'])||!('token'in destination)||destination.accountId!==targets[0].account_id||typeof destination.token!=='string'||!destination.token||destination.token.length>8192||!/^[A-Za-z0-9_-]+$/u.test(destination.token)):destination!==undefined)throw Error('Move requires a current destination from the same account.');
 return [...accounts].flatMap(([accountId,ids])=>Array.from({length:Math.ceil(ids.length/25)},(_,index)=>({accountId,ids:ids.slice(index*25,index*25+25)})));
}
const summary=(groups:NativeTriageGroup[])=>{
 const counts={succeeded:0,failed:0,unknown:0,prepared:0};for(const group of groups){if(group.result)for(const item of group.result.items)counts[item.state]++;else if(['uncertain','denied'].includes(group.state))counts.unknown+=group.ids.length;else if(group.state==='failed')counts.failed+=group.ids.length;else counts.prepared+=group.ids.length;}
 return [counts.succeeded?`${counts.succeeded} updated`:'',counts.failed?`${counts.failed} not updated`:'',counts.unknown?`${counts.unknown} unconfirmed`:'',counts.prepared?`${counts.prepared} pending`:''].filter(Boolean).join(' · ');
};
/** Deliberate mutations execute once. Recovery only queries the retained
 * operation UUID; prepared/unknown results are never replayed by the host. */
export function createNativeEmailTriage(options:{current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;change:(state:NativeTriageState)=>void;
 denied:(account:string)=>void;succeeded:(accounts:string[],targets:NativeTriageTarget[],acknowledgements:NativeTriageFolderAcknowledgement[])=>void;uuid?:()=>string}){
 const controller=new AbortController(),newId=options.uuid??(()=>crypto.randomUUID());let active=true,busy=false,groups:NativeTriageGroup[]=[];
 const publishedSuccess=new Set<string>(),current=()=>active&&!controller.signal.aborted&&options.current();
 const publish=()=>{if(current())options.change({busy,groups:structuredClone(groups),summary:summary(groups)});};
 const execute=async(group:NativeTriageGroup,method:'apply'|'status'|'undo',destination?:NativeTriageSelection)=>{
  try{const base=`/api/email/accounts/${encodeURIComponent(group.accountId)}/operations`;
   const path=method==='apply'?base:method==='undo'?`${base}/${group.undoOf}/undo`:`${base}/${group.operationId}`;
   const body=method==='apply'?{operation_id:group.operationId,kind:group.kind,logical_message_ids:group.ids,...(destination?('tokens'in destination?{label_action:destination.action,destination_ids:destination.tokens}:{destination_id:destination.token}):{})}:method==='undo'?{undo_operation_id:group.operationId}:undefined;
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),response=await options.fetch(path,{method:method==='status'?'GET':'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal,...(body?{body:JSON.stringify(body)}:{})});if(!current()){await response.body?.cancel().catch(()=>{});return;}
   if([401,403].includes(response.status)){group.state='denied';group.result=null;group.notice='Account access changed; the action outcome is unconfirmed.';options.denied(group.accountId);return;}
   if(!response.ok){group.state=method==='status'||![400,404,413].includes(response.status)?'uncertain':'failed';if(method!=='status')group.result=null;group.notice=group.state==='uncertain'?'The result is unconfirmed. Check its status; do not repeat the action.':'The action could not be applied.';return;}
   const raw=await readResult(response,signal);if(!current())return;group.result=parseNativeTriageResult(raw,group);
   if(method==='status')group.result.items=group.result.items.map(({confirmed_folders:_folders,...item})=>item);
   group.state='complete';group.notice=group.result.items.some(item=>['unknown','prepared'].includes(item.state))?'Some results are pending or unconfirmed. Check status.':group.result.items.some(item=>item.state==='failed')?'Some messages were not updated.':'';
  }catch{if(current()){group.state='uncertain';if(method!=='status')group.result=null;group.notice='The result is unconfirmed. Check its status; do not repeat the action.';}}
 };
 const done=()=>{if(!current())return;const accounts=new Set<string>(),targets:NativeTriageTarget[]=[],acknowledgements:NativeTriageFolderAcknowledgement[]=[];for(const group of groups)for(const item of group.result?.items??[]){const key=JSON.stringify([group.accountId,group.operationId,item.logical_message_id]);if(item.state==='succeeded'&&!publishedSuccess.has(key)){publishedSuccess.add(key);accounts.add(group.accountId);targets.push({account_id:group.accountId,logical_message_id:item.logical_message_id});if(item.confirmed_folders)acknowledgements.push({account_id:group.accountId,logical_message_id:item.logical_message_id,operation_id:group.operationId,folders:[...item.confirmed_folders]});}}
  busy=false;publish();if(accounts.size)options.succeeded([...accounts],targets,acknowledgements);};
 return {async apply(kind:NativeTriageKind,targets:readonly NativeTriageTarget[],destination?:NativeTriageSelection){
   if(busy||!current())return;if(groups.some(group=>group.state==='uncertain'||group.result?.items.some(item=>['prepared','unknown'].includes(item.state))))throw Error('Check the previous action status before starting another action.');const nominated=groupNativeTriageTargets(targets,kind,destination);groups=nominated.map(row=>({...row,kind,operationId:newId(),state:'pending',result:null,notice:''}));if(groups.some(group=>!uuid(group.operationId)))throw Error('Operation identity is unavailable.');
   const nomination=destination?structuredClone(destination):undefined;
   busy=true;publish();for(const group of groups){if(!current())return;
    if(groups.some(previous=>previous.accountId===group.accountId&&previous.state==='denied')){group.state='failed';group.notice='Not submitted because account access changed.';publish();continue;}
    await execute(group,'apply',nomination);publish();}done();
  },async check(){if(busy||!current())return;busy=true;publish();for(const group of groups){if(!current())return;if(group.state==='uncertain'||group.result?.items.some(item=>['prepared','unknown'].includes(item.state)))await execute(group,'status');}done();},
  async undo(){if(busy||!current()||groups.some(group=>group.state==='uncertain'||group.result?.items.some(item=>['prepared','unknown'].includes(item.state))))return;const eligible=groups.filter(group=>group.result?.undo_available&&!group.undoOf);if(!eligible.length)return;
   groups=eligible.map(group=>({accountId:group.accountId,kind:group.kind,ids:group.result!.items.filter(item=>item.undo_supported).map(item=>item.logical_message_id),operationId:newId(),undoOf:group.operationId,state:'pending',result:null,notice:''}));if(groups.some(group=>!uuid(group.operationId)))throw Error('Operation identity is unavailable.');busy=true;publish();for(const group of groups){if(!current())return;await execute(group,'undo');publish();}done();},
  dispose(){active=false;controller.abort();groups=[];},snapshot:()=>({busy,groups:structuredClone(groups),summary:summary(groups)})};
}
