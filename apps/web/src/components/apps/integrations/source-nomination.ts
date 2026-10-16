export type SourceNomination=Readonly<{account_ref:string;store_key:string;resource_key:string;record_id:string;content_digest:string}>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,key=/^[a-z][a-z0-9_]{0,47}$/u;
export function parseSourceNomination(query:URLSearchParams):SourceNomination|null{
 const names=['account_ref','source_store_key','source_resource_key','source_record_id','source_digest'];if(!names.some(n=>query.has(n)))return null;
 if(names.some(n=>query.getAll(n).length!==1))throw Error('Source nomination unavailable');
 const [account_ref,store_key,resource_key,record_id,content_digest]=names.map(n=>query.get(n)!);
 if(!/^[A-Za-z0-9_-]{1,512}$/u.test(account_ref)||![store_key,resource_key].every(v=>key.test(v)&&!['constructor','prototype','__proto__'].includes(v))||!uuid.test(record_id)||!/^sha256:[a-f0-9]{64}$/u.test(content_digest))throw Error('Source nomination unavailable');
 return {account_ref,store_key,resource_key,record_id,content_digest};
}
/** Query values select a candidate only. Current signed account/declarations
 * and existing reviewed read must succeed before returning any presentation. */
export async function openSourceNomination<T>(nomination:SourceNomination,ports:{current:()=>boolean;storeKeys:readonly string[];resourceKeys:readonly string[];select:(store:string,signal:AbortSignal)=>Promise<{account:{account_ref:string}}>;
 read:(ref:Omit<SourceNomination,'account_ref'>,signal:AbortSignal)=>Promise<T>},signal:AbortSignal){
 const check=()=>{signal.throwIfAborted();if(!ports.current()||!ports.storeKeys.includes(nomination.store_key)||!ports.resourceKeys.includes(nomination.resource_key))throw Error('Source account review required');};
 check();if((await ports.select(nomination.store_key,signal)).account.account_ref!==nomination.account_ref)throw Error('Source account review required');check();
 const {account_ref:unused,...ref}=nomination;void unused;const result=await ports.read(ref,signal);check();if((await ports.select(nomination.store_key,signal)).account.account_ref!==nomination.account_ref)throw Error('Source account changed');check();return result;
}

/** Nomination is only a selector. Each candidate must be admitted by the current
 * signed account router; the selected child keeps its independent authority. */
export async function resolveSourceNominationAccount<T extends {accountRef:string}>(nomination:SourceNomination,ports:{current:()=>boolean;catalog:(signal:AbortSignal)=>Promise<readonly {key:string}[]>;child:(key:string,signal:AbortSignal)=>Promise<T>},signal:AbortSignal):Promise<T>{
 const check=()=>{signal.throwIfAborted();if(!ports.current())throw Error('Source account review required');};
 check();const rows=await ports.catalog(signal);check();if(rows.length>32||new Set(rows.map(row=>row.key)).size!==rows.length)throw Error('Source account catalog invalid');
 let selected:T|undefined,selectedKey:string|undefined;
 for(const row of rows){check();let child:T;try{child=await ports.child(row.key,signal);}catch{check();continue;}check();if(child.accountRef!==nomination.account_ref)continue;if(selected)throw Error('Source account ambiguous');selected=child;selectedKey=row.key;}
 check();if(!selected||!selectedKey)throw Error('Source account review required');const current=await ports.child(selectedKey,signal);check();if(current.accountRef!==nomination.account_ref)throw Error('Source account changed');return current;
}

/** Retry only the readonly nomination. Every attempt re-enters current account
 * resolution and source authorization; no review/commit or authority is cached. */
export function createSourceNominationLoader(ports:{current:()=>boolean;signal:AbortSignal;load:(signal:AbortSignal)=>Promise<void>;change:(state:'pending'|'failed'|'opened')=>void}){
 let pending=false;const controller=new AbortController();
 const current=()=>ports.current()&&!ports.signal.aborted&&!controller.signal.aborted;
 return {async run(){
  if(pending||!current())return;pending=true;ports.change('pending');
  const signal=AbortSignal.any([ports.signal,controller.signal,AbortSignal.timeout(30000)]);
  let rejectAborted!:()=>void;const aborted=new Promise<never>((_,reject)=>{rejectAborted=()=>reject(signal.reason);signal.addEventListener('abort',rejectAborted,{once:true});});
  try{await Promise.race([ports.load(signal),aborted]);signal.throwIfAborted();if(current())ports.change('opened');}
  catch{if(current())ports.change('failed');}
  finally{signal.removeEventListener('abort',rejectAborted);pending=false;}
 },dispose(){controller.abort();}};
}
