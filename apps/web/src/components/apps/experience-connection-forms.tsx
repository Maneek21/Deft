'use client';
import {useEffect,useRef,useState} from 'react';
import type {AppConnectionFormContext} from '../../../../../packages/app-kit/src/connection-form';
import {api,isSameWebSession} from '@/lib/api';
import {createConnectionFormFlow} from '@/lib/app-connection-form-flow';
import {ExperienceInitialConnectCompletion} from './experience-initial-connect-consent';

type Props={installationId:string;ownerId:string;orgId:string;sessionScope:string;targetKey?:string;disabled:boolean;onBusy:(busy:boolean)=>void;onSetupComplete?:(target:string)=>void};
export function ExperienceConnectionForms(props:Props){
 const [context,setContext]=useState<AppConnectionFormContext|null>(null),[selected,setSelected]=useState(props.targetKey??''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const client=useRef<ReturnType<typeof createConnectionFormFlow>|null>(null),alive=useRef(false),working=useRef(false),generation=useRef(0);
 useEffect(()=>{alive.current=true;const ticket=++generation.current,anchor=api.getAccessToken();let active=true;
  const current=()=>active&&alive.current&&generation.current===ticket&&!document.hidden&&isSameWebSession(anchor,api.getAccessToken());
  const hidden=()=>{if(document.hidden){active=false;setContext(null);setNotice('');working.current=false;setBusy(false);props.onBusy(false);}else setReload(value=>value+1);};
  const flow=createConnectionFormFlow({installationId:props.installationId,ownerId:props.ownerId,orgId:props.orgId,current,fetch:(path,init)=>api.fetch(path,init)});client.current=flow;
  void flow.load().then(value=>{if(current()){setContext(value);setSelected(previous=>value.targets.some(row=>row.target_key===(props.targetKey??previous))?props.targetKey??previous:value.targets[0]?.target_key??'');}}).catch(()=>{if(current())setNotice('Additional account connections could not be loaded.');});
  document.addEventListener('visibilitychange',hidden);
  return()=>{active=false;alive.current=false;client.current=null;working.current=false;props.onBusy(false);document.removeEventListener('visibilitychange',hidden);};
 },[props.installationId,props.ownerId,props.orgId,props.sessionScope,props.targetKey,props.onBusy,reload]);
 const target=context?.targets.find(value=>value.target_key===selected),state=target?.session?.state;
 async function act(kind:'begin'|'status'|'disconnect'){
  if(!target||!client.current||working.current||props.disabled||document.hidden)return;
  const flow=client.current,ticket=generation.current;working.current=true;setBusy(true);props.onBusy(true);setNotice('');
  const current=()=>alive.current&&ticket===generation.current&&client.current===flow&&!document.hidden;
  try{
   if(kind==='begin'){
    const result=await flow.begin(target,crypto.randomUUID());if(!current())return;
    if(result.url){window.location.assign(result.url);return;}
    setNotice('Setup started. Check connection status to continue.');
   }else if(target.session){const result=await flow.manage(target,kind,target.session.session_id);if(!current())return;setNotice(result.state==='connected'?'Account connected.':result.state==='disconnected'?'Account disconnected.':result.state==='awaiting_input'?'Finish account setup in its original tab, then check status.':'Setup is not confirmed. Check status before starting again.');}
   const value=await flow.load();if(current())setContext(value);
  }catch{if(current()){setNotice('Account setup was not confirmed. Check status; setup is not repeated automatically.');await flow.load().then(value=>{if(current())setContext(value);}).catch(()=>undefined);}}
  finally{if(current()){working.current=false;setBusy(false);props.onBusy(false);}}
 }
 if(!context?.targets.length)return notice?<div className="text-sm text-[var(--on-surface-variant)]"><p role="status">{notice}</p><button className="deft-pill min-h-11" disabled={props.disabled||busy} onClick={()=>setReload(value=>value+1)}>Reload connections</button></div>:null;
 return <section aria-label="Server account connections" className="space-y-3">
  <h4 className="text-sm font-medium">Server accounts</h4>
  {context.targets.length>1&&<label className="block text-sm">Account<select className="mt-1 min-h-11 w-full rounded-xl bg-[var(--surface-container-high)] px-3" value={selected} disabled={busy||props.disabled} onChange={event=>{setSelected(event.target.value);setNotice('');}}>{context.targets.map(value=><option key={value.target_key} value={value.target_key}>{value.session?.account?.label??value.candidate?.account.label??value.profile.label}</option>)}</select></label>}
  {target&&<><p>{target.session?.account?.label??target.candidate?.account.label??target.profile.label}</p>
   {target.session?.account&&<p className="text-sm text-[var(--on-surface-variant)]">{target.session.account.address}</p>}
   <p className="text-sm text-[var(--on-surface-variant)]">{state==='connected'?'Connected':state==='awaiting_input'?'Waiting for account setup':state==='indeterminate'?'Check setup status':state==='disconnected'?'Disconnected':'Connect using your mail server details.'}</p>
   {notice&&<p role="status" className="text-sm">{notice}</p>}
   {target.session?.state==='connected'&&target.session.account&&<ExperienceInitialConnectCompletion {...props} target={{target_key:target.target_key,scope:target.scope,
    session:{schema_version:'deft.app_connection_session.v1',session_id:target.session.session_id,state:'connected',scope:target.scope,
     expires_at:target.scope.consent_expires_at,account:{account_ref:target.session.account.account_ref,label:target.session.account.label}}}}/>}
   <div className="flex flex-wrap gap-2">
    {(!state||state==='not_connected'||state==='disconnected')&&<button className="deft-pill min-h-11" disabled={busy||props.disabled||!target.runtime_ready} onClick={()=>void act('begin')}>{target.candidate?'Reconnect existing account':'Connect account'}</button>}
    {target.session&&<button className="deft-pill min-h-11" disabled={busy||props.disabled||!target.runtime_ready} onClick={()=>void act('status')}>Check connection status</button>}
    {state==='connected'&&props.onSetupComplete&&<button className="deft-pill min-h-11" disabled={busy||props.disabled} onClick={()=>props.onSetupComplete?.(target.target_key)}>Use account</button>}
   </div>
   {state==='connected'&&<details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">Manage connection</summary><button className="deft-pill min-h-11 text-[var(--error)]" disabled={busy||props.disabled} onClick={()=>void act('disconnect')}>Disconnect account</button></details>}
   {!target.runtime_ready&&<p className="text-sm">Your workspace needs to finish configuring this account connection.</p>}
  </>}
 </section>;
}
