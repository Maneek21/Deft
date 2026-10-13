export type NativeFolder={folder_id:string;label:string;kind:'label'|'folder';parent_folder_id:string|null;canonical_role:string|null;destination_id:string|null;labels_allowed:boolean;rename_id?:string|null};
export type NativeFolderAccount={accountId:string;items:NativeFolder[];nextCursor:string|null;state:'pending'|'available'|'failed'|'denied';notice:string;complete:boolean;createAllowed?:boolean};
export type NativeFolderState={busy:boolean;accounts:NativeFolderAccount[]};
export function nativeFolderLabel(folder:NativeFolder,items:readonly NativeFolder[]){
 const parts=[folder.label],seen=new Set([folder.folder_id]);let parent=folder.parent_folder_id;
 while(parent&&parts.length<8){if(seen.has(parent)){parts.unshift('…');break;}seen.add(parent);const row=items.find(item=>item.folder_id===parent);if(!row){parts.unshift('…');break;}parts.unshift(row.label);parent=row.parent_folder_id;}
 return parts.join(' / ');
}
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const token=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9_-]+$/u.test(value);
async function readPage(response:Response,signal:AbortSignal){
 if(!response.body)throw Error();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1048576)throw Error();text+=decoder.decode(next.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function parseNativeFolderPage(raw:unknown,account:string,management=false):{items:NativeFolder[];nextCursor:string|null;complete:boolean;createAllowed?:boolean}{
 const fail=():never=>{throw Error('Folders could not be confirmed.');};
 if(!closed(raw,['account_id','provider','items','next_cursor','has_more','observed_at','coverage','consistency','exact_total',...(management?['create_allowed']:[])])||management&&typeof raw.create_allowed!=='boolean'||raw.account_id!==account||!['gmail','microsoft'].includes(String(raw.provider))||!Array.isArray(raw.items)||raw.items.length>50||typeof raw.has_more!=='boolean'||!(raw.next_cursor===null||token(raw.next_cursor,256*1024))||raw.has_more!==(raw.next_cursor!==null)||raw.coverage!==(raw.has_more?'partial':'complete')||raw.consistency!=='weak'||raw.exact_total!==null||typeof raw.observed_at!=='string'||!Number.isFinite(Date.parse(raw.observed_at)))return fail();
 const seen=new Set<string>();for(const row of raw.items){if(!closed(row,['folder_id','label','kind','parent_folder_id','canonical_role','destination_id','labels_allowed',...(management?['rename_id']:[])])||management&&!(row.rename_id===null||token(row.rename_id,8192))||!id(row.folder_id)||!/^(?:inbox|sent|spam|trash|drafts|starred|archive|label:[a-f0-9]{64}|folder:[a-f0-9]{64})$/u.test(row.folder_id)||seen.has(row.folder_id)||typeof row.label!=='string'||!row.label||row.label.length>512||/[\u0000-\u001f\u007f-\u009f]/u.test(row.label)||row.kind!==(raw.provider==='gmail'?'label':'folder')||!(row.parent_folder_id===null||id(row.parent_folder_id))||!(row.canonical_role===null||['inbox','sent','spam','trash','drafts','starred','archive'].includes(String(row.canonical_role)))||!(row.destination_id===null||token(row.destination_id,8192))||typeof row.labels_allowed!=='boolean')return fail();seen.add(row.folder_id);}
 return {items:structuredClone(raw.items) as NativeFolder[],nextCursor:raw.next_cursor as string|null,complete:!raw.has_more,...(management?{createAllowed:raw.create_allowed as boolean}:{})};
}
export function createNativeEmailFolders(options:{accountIds:readonly string[];management?:boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean;change:(state:NativeFolderState)=>void;denied:(account:string)=>void}){
 if(!options.accountIds.length||options.accountIds.length>16||!options.accountIds.every(id)||new Set(options.accountIds).size!==options.accountIds.length)throw Error('Select a connected account.');
 const controller=new AbortController();let active=true,busy=false,started=false;const rows:NativeFolderAccount[]=options.accountIds.map(accountId=>({accountId,items:[],nextCursor:null,state:'pending',notice:'',complete:false}));
 const seen=new Map<string,Set<string>>(),current=()=>active&&!controller.signal.aborted&&options.current();
 const publish=()=>{if(current())options.change({busy,accounts:structuredClone(rows)});};
 const read=async(row:NativeFolderAccount,append=false)=>{const cursor=append?row.nextCursor:null;
  try{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),response=await options.fetch(`/api/email/accounts/${encodeURIComponent(row.accountId)}/folders/query`,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal,body:JSON.stringify({cursor,limit:50,...(options.management?{management:true}:{})})});if(!current()){await response.body?.cancel().catch(()=>{});return;}
   if([401,403].includes(response.status)){row.state='denied';row.items=[];row.nextCursor=null;row.complete=false;row.notice='Account access changed.';options.denied(row.accountId);return;}
   if(!response.ok)throw Error(response.status===409?'Folder paging expired. Reload folders.':'Folders are unavailable for this account.');
   const raw=await readPage(response,signal);if(!current())return;const page=parseNativeFolderPage(raw,row.accountId,options.management),cursors=seen.get(row.accountId)??new Set<string>();
   if(cursor)cursors.add(cursor);if(page.nextCursor&&cursors.has(page.nextCursor))throw Error('Folder paging expired. Reload folders.');seen.set(row.accountId,cursors);
   const next=append?[...row.items,...page.items.filter(folder=>!row.items.some(old=>old.folder_id===folder.folder_id))]:page.items;
   if(next.length>500)throw Error('Only 500 folders can be shown. Narrow the account selection.');Object.assign(row,{items:next,nextCursor:page.nextCursor,state:'available',notice:'',complete:page.complete,...(options.management?{createAllowed:page.createAllowed}:{})});
  }catch(error){if(current()){row.state='failed';row.nextCursor=null;row.complete=false;const message=error instanceof Error?error.message:'';row.notice=['Folder paging expired. Reload folders.','Folders are unavailable for this account.','Only 500 folders can be shown. Narrow the account selection.'].includes(message)?message:'Folders are unavailable for this account. Reload folders.';}}
 };
 return {async start(){if(started||!current())return;started=true;busy=true;publish();let cursor=0;const worker=async()=>{while(cursor<rows.length&&current()){await read(rows[cursor++]);publish();}};await Promise.all([worker(),worker()]);busy=false;publish();},
  async more(account:string){const row=rows.find(value=>value.accountId===account);if(!row?.nextCursor||busy||!current())return;busy=true;publish();await read(row,true);busy=false;publish();},dispose(){active=false;controller.abort();for(const row of rows)row.items=[];}};
}
