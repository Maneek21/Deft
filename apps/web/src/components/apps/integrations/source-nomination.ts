import {traceExperienceRead} from '../../../lib/app-experience-read-trace';
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
type SourceReference=Omit<SourceNomination,'account_ref'>;
type SourceReadPorts<T>={current:()=>boolean;storeKeys:readonly string[];resourceKeys:readonly string[]}&(
 {readCurrent:(ref:SourceReference,signal:AbortSignal)=>Promise<{account_ref:string;result:T}>;select?:never;read?:never}|
 {select:(store:string,signal:AbortSignal)=>Promise<{account:{account_ref:string}}>;read:(ref:SourceReference,signal:AbortSignal)=>Promise<T>;readCurrent?:never});
export async function openSourceNomination<T>(nomination:SourceNomination,ports:SourceReadPorts<T>,signal:AbortSignal){
 const check=()=>{signal.throwIfAborted();if(!ports.current()||!ports.storeKeys.includes(nomination.store_key)||!ports.resourceKeys.includes(nomination.resource_key))throw Error('Source account review required');};
 check();const ref={store_key:nomination.store_key,resource_key:nomination.resource_key,record_id:nomination.record_id,content_digest:nomination.content_digest};
 // This trusted port owns fresh dispatch/disclosure checks in one operation.
 if(ports.readCurrent){const value=await ports.readCurrent(ref,signal);check();if(value.account_ref!==nomination.account_ref)throw Error('Source account changed');return value.result;}
 const select=ports.select;
 if((await traceExperienceRead(signal,'source.select',()=>select(nomination.store_key,signal))).account.account_ref!==nomination.account_ref)throw Error('Source account review required');check();
 const result=await ports.read(ref,signal);check();if((await traceExperienceRead(signal,'source.select',()=>select(nomination.store_key,signal))).account.account_ref!==nomination.account_ref)throw Error('Source account changed');check();return result;
}

/** Nomination is only a selector. Each candidate must be admitted by the current
 * signed account router; the selected child keeps its independent authority. */
export async function resolveSourceNominationAccount<T extends {accountRef:string}>(nomination:SourceNomination,ports:{current:()=>boolean;catalog:(signal:AbortSignal)=>Promise<readonly {key:string}[]>;child:(key:string,signal:AbortSignal)=>Promise<T>},signal:AbortSignal):Promise<T>{
 const check=()=>{signal.throwIfAborted();if(!ports.current())throw Error('Source account review required');};
 check();const rows=await traceExperienceRead(signal,'source.catalog',()=>ports.catalog(signal));check();if(rows.length>32||new Set(rows.map(row=>row.key)).size!==rows.length)throw Error('Source account catalog invalid');
 let selected:T|undefined,selectedKey:string|undefined;
 for(let offset=0;offset<rows.length;offset+=2){
  const candidates=await Promise.all(rows.slice(offset,offset+2).map(async row=>{check();try{const child=await traceExperienceRead(signal,'source.candidate',()=>ports.child(row.key,signal));check();return {key:row.key,child};}catch{check();return null;}}));
  for(const candidate of candidates){check();if(!candidate||candidate.child.accountRef!==nomination.account_ref)continue;if(selected)throw Error('Source account ambiguous');selected=candidate.child;selectedKey=candidate.key;}
 }
 check();if(!selected||!selectedKey)throw Error('Source account review required');const current=await traceExperienceRead(signal,'source.selected',()=>ports.child(selectedKey!,signal));check();if(current.accountRef!==nomination.account_ref)throw Error('Source account changed');return current;
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
  try{await Promise.race([traceExperienceRead(signal,'source.open',()=>ports.load(signal)),aborted]);signal.throwIfAborted();if(current())ports.change('opened');}
  catch{if(current())ports.change('failed');}
  finally{signal.removeEventListener('abort',rejectAborted);pending=false;}
 },dispose(){controller.abort();}};
}

/** Keep URL nomination lifetime separate from the Experience/Worker lifetime. */
const sourceQueryNames=['account_ref','source_store_key','source_resource_key','source_record_id','source_digest'] as const;
export function sourceNominationQuery(query:Pick<URLSearchParams,'getAll'>){const exact=new URLSearchParams();for(const name of sourceQueryNames)for(const value of query.getAll(name))exact.append(name,value);return exact.toString();}
export function createSourceNominationNavigation(ports:{current:()=>boolean;signal:AbortSignal;clear:()=>void;change:(state:'pending'|'failed'|'opened')=>void;
 load:(nomination:SourceNomination,signal:AbortSignal,lifetime:AbortSignal)=>Promise<void>}){
 let query:string|undefined,controller:AbortController|undefined,loader:ReturnType<typeof createSourceNominationLoader>|undefined,closed=false;
 return {reset(value:string){if(closed)return;const next=sourceNominationQuery(new URLSearchParams(value));if(next===query)return;query=next;controller?.abort();loader?.dispose();loader=undefined;ports.clear();if(!next)return;
   controller=new AbortController();const lifetime=AbortSignal.any([ports.signal,controller.signal]);
   loader=createSourceNominationLoader({current:()=>!closed&&ports.current(),signal:lifetime,change:ports.change,load:async signal=>{const nomination=parseSourceNomination(new URLSearchParams(next));if(!nomination)throw Error('Source unavailable');await ports.load(nomination,signal,lifetime);}});void loader.run();
  },run(){return loader?.run()??Promise.resolve();},dispose(){closed=true;controller?.abort();loader?.dispose();loader=undefined;}};
}
