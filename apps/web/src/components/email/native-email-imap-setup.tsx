'use client';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {loadImapSetupTargets,submitImapSetup,type ImapProfile,type ImapSetupTarget} from '@/lib/email-imap-setup';
const inputClass='min-h-10 w-full rounded-lg bg-[var(--surface-container-low)] px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const button='rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailImapFields({busy,smtp,onSmtp}:{busy:boolean;smtp:boolean;onSmtp:(value:boolean)=>void}){
 const id=useId();
 const field=(name:string,label:string,type='text',maxLength=253,defaultValue='')=><label className="block space-y-1 text-xs" htmlFor={id+name}><span>{label}</span><input id={id+name} name={name} type={type} autoComplete="off" required maxLength={maxLength} defaultValue={defaultValue} className={inputClass}/></label>;
 const server=(prefix:string,label:string,implicit:string,starttls:string)=><div className="space-y-3"><h5 className="text-sm font-medium">{label}</h5>{field(prefix+'host','Server address')}
  <label className="block space-y-1 text-xs" htmlFor={id+prefix+'transport'}><span>Secure connection</span><select id={id+prefix+'transport'} name={prefix+'transport'} className={inputClass} defaultValue="implicit_tls"><option value="implicit_tls">TLS · port {implicit}</option><option value="starttls_required">STARTTLS · port {starttls}</option></select></label>
  {field(prefix+'username','Account name','text',512)}{field(prefix+'password','App password or password','password',8192)}</div>;
 return <fieldset disabled={busy} className="space-y-4"><div className="grid gap-3 sm:grid-cols-2">{field('address','Email address','email',320)}{field('label','Account label','text',256)}</div>{server('imap_','Incoming mail · IMAP','993','143')}
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={smtp} onChange={event=>onSmtp(event.target.checked)} className="accent-[var(--primary)]"/>Set up outgoing mail too</label>
  {smtp&&server('smtp_','Outgoing mail · SMTP','465','587')}
  <p className="text-xs leading-5 text-[var(--text-secondary)]">Use the server details from your email provider. Passwords are sent for secure verification and stored encrypted by Deft. They are cleared from this form when you connect.</p>
 </fieldset>;
}
export function NativeEmailImapSetup({sessionScope,onConnected}:{sessionScope:string;onConnected:()=>void}){
 const [targets,setTargets]=useState<ImapSetupTarget[]|null>(null),[selection,setSelection]=useState(''),[reload,setReload]=useState(0),[notice,setNotice]=useState('Checking IMAP account setup…'),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[smtp,setSmtp]=useState(false);
 const generation=useRef(0),pending=useRef<AbortController|null>(null),connected=useRef(onConnected);useEffect(()=>{connected.current=onConnected;},[onConnected]);
 useEffect(()=>{const ticket=++generation.current,anchor=api.getAccessToken(),controller=new AbortController();let active=true;
  const current=()=>active&&!controller.signal.aborted&&ticket===generation.current&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  void loadImapSetupTargets({fetch:(path,options)=>api.fetch(path,options),current},controller.signal).then(value=>{if(current()){setTargets(value.items);setMore(value.has_more);setSelection(value.items[0]?.account_id??'');setUncertain(false);setNotice('');}}).catch(error=>{if(current()){setTargets(null);setNotice(error instanceof Error?error.message:'IMAP account setup is unavailable.');}});
  return()=>{active=false;controller.abort();pending.current?.abort();pending.current=null;};
 },[sessionScope,reload]);
 const target=targets?.find(value=>value.account_id===selection);
 const submit=async(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();if(!target||busy||uncertain||pending.current)return;
  const form=event.currentTarget,data=new FormData(form),text=(name:string)=>String(data.get(name)??''),server=(prefix:string,isSmtp=false)=>{const transport=text(prefix+'transport') as ImapProfile['transport'];return {host:text(prefix+'host'),transport,port:transport==='implicit_tls'?(isSmtp?465:993):(isSmtp?587:143),username:text(prefix+'username'),password:text(prefix+'password')};};
  const profile:ImapProfile={...server('imap_'),identity:{primary_address:text('address'),display_label:text('label')},...(smtp?{smtp:server('smtp_',true)}:{})};
  for(const element of Array.from(form.elements))if(element instanceof HTMLInputElement&&element.type==='password')element.value='';
  const ticket=generation.current,anchor=api.getAccessToken(),controller=new AbortController();pending.current=controller;setBusy(true);setNotice('Verifying account details…');
  const current=()=>!controller.signal.aborted&&ticket===generation.current&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  try{await submitImapSetup(target,profile,{fetch:(path,options)=>api.fetch(path,options),current},controller.signal);if(current()){setUncertain(true);setNotice('Account connected. Reload setup status to see the saved connection. Messages will appear as syncing completes.');connected.current();}}
  catch(error){if(current()){setUncertain(true);setNotice(error instanceof Error?error.message:'Setup was not confirmed. Reload its status before trying again.');}}
  finally{profile.password='';if(profile.smtp)profile.smtp.password='';if(current())setBusy(false);if(pending.current===controller)pending.current=null;}
 };
 return <section aria-label="IMAP account setup" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">IMAP account setup</h3><button type="button" disabled={busy} onClick={()=>{setTargets(null);setSelection('');setSmtp(false);setReload(value=>value+1);}} className={button}>Reload setup status</button></div>
  {notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
  {targets?.length===0&&<p className="text-xs text-[var(--text-secondary)]">No reviewed IMAP connection is available yet. Set up account access in Manage account connections first.</p>}
  {!!targets?.length&&<><label className="block space-y-1 text-xs"><span>Account connection</span><select value={selection} disabled={busy||uncertain} onChange={event=>{setSelection(event.target.value);setSmtp(false);}} className={inputClass}>{targets.map((value,index)=><option value={value.account_id} key={value.account_id}>{value.display_label||value.primary_address||`IMAP account ${index+1}`} · {value.state==='active'?'Connected':value.state==='needs_attention'?'Reconnect needed':'Ready to connect'}</option>)}</select></label>
   {target&&<form key={target.account_id+'/'+reload} autoComplete="off" onSubmit={event=>void submit(event)} className="space-y-4"><NativeEmailImapFields busy={busy||uncertain} smtp={smtp} onSmtp={setSmtp}/><button type="submit" disabled={busy||uncertain} className={button+' bg-[var(--accent-light)] text-[var(--primary)]'}>{busy?'Connecting…':target.state==='active'?'Update account connection':'Connect account'}</button></form>}</>}
  {more&&<p className="text-xs text-[var(--text-secondary)]">Only the first 50 reviewed account connections were checked. Additional connections are not shown.</p>}
 </section>;
}
