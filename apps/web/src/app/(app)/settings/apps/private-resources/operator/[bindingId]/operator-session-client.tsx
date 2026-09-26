'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';
import { useSetPageContext } from '@/components/app-header-context';
import styles from '../../private-resources.module.css';

type Session = { session_id: string; session_token: string; expires_at: string };
const management = '/api/app-resource-sync-management';
const channelUrl = `${(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '')}/api/app-resource-sync/channel`;

export function OperatorSessionClient({ bindingId }: { bindingId: string }) {
  const { user, sessionCacheScope } = useAuth();
  useSetPageContext(<span className="text-sm font-semibold">Private resource operator</span>, []);
  if (!user || !sessionCacheScope) return null;
  return <OperatorSession key={`${sessionCacheScope}:${bindingId}`} bindingId={bindingId} />;
}

function OperatorSession({ bindingId }: { bindingId: string }) {
  const [session, setSession] = useState<Omit<Session, 'session_token'> | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const issuing = useRef<number | null>(null);
  const clearCredential = useCallback(() => {
    generation.current += 1; setCredential(null); setBusy(false);
  }, []);
  useEffect(() => {
    const hide = () => { if (document.hidden) { clearCredential(); setNotice(issuing.current ? 'Credential delivery was interrupted. A session may remain active for up to 15 minutes. Revoke the connection from Private resources to invalidate all its sessions.' : 'The credential was hidden. Its session remains valid until expiry or revocation.'); } };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', clearCredential);
    return () => { generation.current += 1; document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', clearCredential); };
  }, [clearCredential]);
  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = new Date(session.expires_at).getTime() - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) { clearCredential(); setSession(null); setNotice('This operator session has expired.'); return; }
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [session, clearCredential]);
  const issue = async () => {
    const request = ++generation.current;
    issuing.current = request;
    setBusy(true); setCredential(null); setError(null); setNotice(null);
    try {
      const response = await api.post(`${management}/bindings/${encodeURIComponent(bindingId)}/sessions`);
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to issue an operator credential.'));
      const body = await response.json() as { session: Session };
      if (request !== generation.current || document.hidden) return;
      if (!Number.isFinite(new Date(body.session.expires_at).getTime()) || new Date(body.session.expires_at).getTime() <= Date.now()) { setNotice('The operator session expired before it arrived. Request a new credential.'); return; }
      setSession({ session_id: body.session.session_id, expires_at: body.session.expires_at });
      setCredential(JSON.stringify({ session_id: body.session.session_id, session_token: body.session.session_token }, null, 2));
    } catch (reason) { if (request === generation.current) { setError(reason instanceof Error ? reason.message : 'Unable to issue credential.'); setNotice('If issuance reached the server, an unreceived session may remain active for up to 15 minutes. Revoke the connection from Private resources to invalidate all its sessions.'); } }
    finally { if (issuing.current === request) issuing.current = null; if (request === generation.current) setBusy(false); }
  };
  const revoke = async () => {
    if (!session) return;
    const request = ++generation.current;
    setBusy(true); setCredential(null); setError(null);
    try {
      const response = await api.post(`${management}/sessions/${encodeURIComponent(session.session_id)}/revoke`);
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to revoke this operator session.'));
      if (request === generation.current) { setSession(null); setNotice('Operator session revoked. The connection remains available for a new session.'); }
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to revoke session.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <div className={`${styles.workspace} flex h-full min-h-0 flex-1 flex-col overflow-hidden`}>
    <PageHeader title="Private resource operator" description="Issue a temporary credential for the provider you run." compact />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><section className="mx-auto max-w-3xl space-y-4">
      <Link className="deft-pill min-h-11" href="/settings/apps/private-resources">← Private resources</Link>
      <div className="space-y-4 rounded-xl border p-4 text-sm" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
        <p>Only the assigned operator can issue this connection’s credential. Give it directly to the provider process you run. It permits the reviewed sync for this connection.</p>
        <p>The credential is shown once and is cleared when you leave or hide this page. It lasts at most 15 minutes, capped by consent expiry. Hiding it does not revoke the session.</p>
        <p>If delivery is interrupted, revoke the connection from Private resources to invalidate any session you did not receive.</p>
        <label className="block space-y-1"><span>Sync channel URL</span><input aria-label="Sync channel URL" readOnly value={channelUrl} className="min-h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-xs" style={{ borderColor: 'var(--ghost-border)' }} /></label>
        {error && <p role="alert" className="break-words" style={{ color: 'var(--error)' }}>{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {busy && <p role="status">Updating operator session…</p>}
        {session && <p>Session expires {new Date(session.expires_at).toLocaleString()}.</p>}
        {credential && <label className="block space-y-2"><span className="font-medium">Operator credential</span><textarea aria-label="Operator credential" readOnly autoComplete="off" spellCheck={false} rows={6} value={credential} className="w-full min-w-0 resize-none rounded-lg border bg-transparent p-3 font-mono text-xs" style={{ borderColor: 'var(--ghost-border)' }} /><span className="block text-xs" style={{ color: 'var(--on-surface-variant)' }}>Keep this credential out of App content, messages and shared files.</span></label>}
        <div className="flex flex-wrap gap-2">{!session && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void issue()}>Issue operator credential</button>}{credential && <button className="deft-pill min-h-11" disabled={busy} onClick={() => { clearCredential(); setNotice('Credential hidden. Revoke this session before requesting another.'); }}>Hide credential</button>}{session && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void revoke()}>Revoke operator session</button>}</div>
      </div>
    </section></div>
  </div>;
}
