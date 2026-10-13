'use client';
import {useEffect,useState} from 'react';
import {parseEmailAgentAccess,toggleEmailAgentOperation,type EmailAgentAccess,type EmailAgentOperation} from '@/lib/email-native-connected';
import {useEmailConnectedResource} from './use-email-connected-resource';

const pill='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
const operations:EmailAgentOperation[]=['read','draft','triage','send'];
const labels:Record<EmailAgentOperation,string>={read:'Read and search',draft:'Prepare drafts',triage:'Organize mail',send:'Send reviewed drafts'};
export function NativeEmailAgentAccess({accountId,sessionScope}:{accountId:string;sessionScope:string}) {
  const resource=useEmailConnectedResource(accountId,sessionScope,'/agent-access',parseEmailAgentAccess);
  const [principal,setPrincipal]=useState('defty'),[choice,setChoice]=useState<EmailAgentOperation[]>([]);
  const kind=principal==='defty'?'defty':'personal_mcp',principalId=principal==='defty'?resource.value?.defty_principal_id:principal;
  const grant=resource.value?.grants.find(row=>row.principal_kind===kind&&row.principal_id===principalId);
  useEffect(()=>{setChoice(grant&&!grant.revoked_at?grant.operations:[]);},[grant,principal]);
  useEffect(()=>{if(resource.value&&principal!=='defty'&&!resource.value.personal_tokens.some(token=>token.id===principal))setPrincipal('defty');},[resource.value,principal]);
  const save=(selected:EmailAgentOperation[])=>{if(principalId)void resource.save({principal_kind:kind,principal_id:principalId,operations:selected,expected_revision:grant?.revision??0});};
  if(!resource.current)return null;
  return <NativeEmailAgentAccessView value={resource.value} principal={principal} choice={choice} busy={resource.busy} uncertain={resource.uncertain} notice={resource.notice} onPrincipal={setPrincipal} onChoice={setChoice} onSave={()=>save(choice)} onRevoke={()=>save([])} onReload={resource.reload}/>;
}
export function NativeEmailAgentAccessView({value,principal,choice,busy,uncertain,notice,onPrincipal,onChoice,onSave,onRevoke,onReload}:{value:EmailAgentAccess|null;principal:string;choice:EmailAgentOperation[];busy:boolean;uncertain:boolean;notice:string;onPrincipal:(value:string)=>void;onChoice:(value:EmailAgentOperation[])=>void;onSave:()=>void;onRevoke:()=>void;onReload:()=>void}) {
  const principalId=principal==='defty'?value?.defty_principal_id:principal,kind=principal==='defty'?'defty':'personal_mcp';
  const grant=value?.grants.find(row=>row.principal_kind===kind&&row.principal_id===principalId),saved=grant&&!grant.revoked_at?grant.operations:[];
  const locked=!value||busy||uncertain,dirty=operations.some(op=>choice.includes(op)!==saved.includes(op));
  const activeGrants=value?.grants.filter(row=>!row.revoked_at&&row.operations.length>0&&(row.principal_kind==='defty'||value.personal_tokens.some(token=>token.id===row.principal_id)))??[];
  return <section aria-label="Email Defty and MCP access" className="space-y-3 pt-5 text-sm">
    <h4 className="font-medium">Defty and MCP access</h4><p className="text-xs leading-5 text-[var(--text-secondary)]">Choose who can use this account and which operations they can perform. Automatic Knowledge capture has its own setting.</p>
    <label className="block space-y-1"><span className="text-xs">Allow access for</span><select aria-label="Email agent or MCP credential" value={principal} disabled={locked} onChange={event=>onPrincipal(event.target.value)} className="min-h-10 w-full rounded-lg bg-[var(--surface)] px-3 text-sm focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><option value="defty">Defty</option>{value?.personal_tokens.map(token=><option key={token.id} value={token.id}>MCP · {token.name}</option>)}</select></label>
    <div role="group" aria-label="Allowed email operations" className="flex flex-wrap gap-x-4 gap-y-2">{operations.map(op=><label key={op} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={choice.includes(op)} disabled={locked} onChange={event=>onChoice(toggleEmailAgentOperation(choice,op,event.target.checked))}/>{labels[op]}</label>)}</div>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">Sending includes read and draft access and uses an exact saved draft review, including recipients and attachments.</p>
    <div className="flex flex-wrap items-center gap-2"><button type="button" className={pill+' bg-[var(--accent-light)] text-[var(--primary)]'} disabled={locked||!dirty} onClick={onSave}>{busy?'Saving…':'Save access'}</button>{saved.length>0&&<button type="button" className={pill} disabled={locked} onClick={onRevoke}>Revoke access</button>}<button type="button" className={pill} disabled={busy} onClick={onReload}>Reload saved access</button></div>
    {value&&<div className="space-y-1 text-xs text-[var(--text-secondary)]"><p>Active access</p>{activeGrants.map(row=><p key={row.id}>{row.principal_kind==='defty'?'Defty':`MCP · ${value.personal_tokens.find(token=>token.id===row.principal_id)?.name??'Credential'}`} · {row.operations.map(op=>labels[op]).join(', ')}</p>)}{!activeGrants.length&&<p>No active access for this account.</p>}{!value.personal_tokens.length&&<a href="/settings/mcp-access" className="inline-block py-1 text-[var(--primary)]">Create a personal MCP token in Settings</a>}</div>}
    {notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
  </section>;
}
