'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, isSameWebSession } from '@/lib/api';
import { APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';
import { appApiError } from '@/lib/apps';

type Assignment = { binding_id: string; installation_id: string; resource_key: string;
  owner_user_id: string; owner_name: string; consent_expires_at: string; attachment?:boolean };
export function OperatorAssignments() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [attachmentAfter,setAttachmentAfter]=useState<string|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async (cursor?: string,attachment=false) => {
    const request = ++generation.current;
    const token=api.getAccessToken();
    setBusy(true); setError(null); setAssignments([]);
    try {
      const base=attachment?'/api/apps/blob/sync':'/api/app-resource-sync-management';
      const response = await api.get(`${base}/operator/assignments?limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to load operator assignments.'));
      const body = await response.json() as { assignments: Assignment[]; next_after: string | null };
      let items=body.assignments.map(item=>({...item,attachment}));
      if(!cursor&&!attachment&&APP_ATTACHMENT_BROKER_ENABLED){
        const extra=await api.get('/api/apps/blob/sync/operator/assignments?limit=20');
        if(!extra.ok)throw new Error(await appApiError(extra,'Unable to load attachment assignments.'));
        const data=await extra.json() as {assignments:Assignment[];next_after:string|null};
        if(data.assignments.length>20)throw new Error('Attachment assignments exceeded the page limit.');
        items=items.concat(data.assignments.map(item=>({...item,attachment:true})));
        if(request===generation.current)setAttachmentAfter(data.next_after);
      }
      if (request !== generation.current || document.hidden || !isSameWebSession(token,localStorage.getItem('deft-access-token'))) return;
      setAssignments(items.filter(item => new Date(item.consent_expires_at).getTime() > Date.now()));
      if(attachment)setAttachmentAfter(body.next_after);else setAfter(body.next_after);
    } catch (reason) { if (request === generation.current) { setAfter(null); setError(reason instanceof Error ? reason.message : 'Unable to load assignments.'); } }
    finally { if (request === generation.current) setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    const visibility = () => { if (document.hidden) { generation.current += 1; setAssignments([]); setBusy(false); } else void load(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { generation.current += 1; document.removeEventListener('visibilitychange', visibility); };
  }, [load]);
  useEffect(() => {
    if (!assignments.length) return;
    const earliest = Math.min(...assignments.map(item => new Date(item.consent_expires_at).getTime()));
    const timer = setTimeout(() => void load(), Math.min(Math.max(0, earliest - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [assignments, load]);
  return <section aria-label="Your operator assignments" className="min-w-0 space-y-3 rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
    <h2 className="font-semibold">Your operator assignments</h2>
    <p className="text-sm">Run providers for these private connections. Saved records belong to their owner; this assignment grants no private read access.</p>
    {error && <p role="alert" className="break-words text-sm" style={{ color: 'var(--error)' }}>{error}</p>}
    {busy ? <p role="status" className="text-sm">Loading assignments…</p> : assignments.length === 0 && <p className="text-sm">No live operator assignments on this page.</p>}
    {assignments.map(item => <div key={item.binding_id} className="space-y-2 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--ghost-border)' }}>
      <p className="break-words"><strong>{item.resource_key}</strong> · Owned by {item.owner_name}</p>
      <p>Consent ends {new Date(item.consent_expires_at).toLocaleString()}.</p>
      <Link className="deft-pill min-h-11" style={{minHeight:44}} href={`/settings/apps/private-resources/${item.attachment?'attachment-operator':'operator'}/${encodeURIComponent(item.binding_id)}`}>Open operator setup</Link>
    </div>)}
    <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" style={{minHeight:44}} disabled={busy} onClick={() => void load()}>Refresh assignments</button>{after && <button className="deft-pill min-h-11" style={{minHeight:44}} disabled={busy} onClick={() => void load(after)}>Next assignments</button>}{attachmentAfter&&<button className="deft-pill" style={{minHeight:44}} disabled={busy} onClick={()=>void load(attachmentAfter,true)}>Next attachment assignments</button>}</div>
  </section>;
}
