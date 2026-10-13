import type {SourceNomination} from './source-nomination';
type Reference=Readonly<{store_key:string;resource_key:string;record_id:string;content_digest:string}>;
/** This Host control captures a mounted, governed reference. The account router
 * resolves its retained owner; neither a view event nor the current picker supplies it. */
export function mountRecordTaskEntry<T extends {accountRef:string}>(ports:{wrapper:HTMLElement;reference:Reference;current:()=>boolean;signal:AbortSignal;
 owner:(ref:Reference,signal:AbortSignal)=>Promise<T>;
 open:(nomination:SourceNomination,owner:T,signal:AbortSignal)=>Promise<void>}){
 const {store_key,resource_key,record_id,content_digest}=ports.reference;
 const reference=Object.freeze({store_key,resource_key,record_id,content_digest}),controller=new AbortController(),signal=AbortSignal.any([ports.signal,controller.signal]);
 const current=()=>!signal.aborted&&ports.current()&&(['store_key','resource_key','record_id','content_digest'] as const).every(key=>ports.reference[key]===reference[key]);
 const section=document.createElement('div');section.className='ex-stack ex-stack-horizontal';
 const button=document.createElement('button');button.type='button';button.className='ex-button-ghost';button.textContent='Create task';
 const status=document.createElement('span');status.className='ex-text ex-text-caption';status.setAttribute('role','status');section.append(button,status);ports.wrapper.append(section);
 button.onclick=async()=>{if(!current()||button.disabled)return;button.disabled=true;status.textContent='';
  try{const owner=await ports.owner(reference,signal);if(!current()||!owner.accountRef)throw Error('Source unavailable');
   await ports.open({...reference,account_ref:owner.accountRef},owner,signal);
  }catch{if(current())status.textContent='This source is unavailable or its account needs review.';}
  finally{if(current())button.disabled=false;}};
 return()=>{controller.abort();button.onclick=null;section.remove();};
}
