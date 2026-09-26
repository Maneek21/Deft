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
type Metadata = { session_id: string; created_at: string; expires_at: string; revoked_at: string | null };
const management = '/api/app-resource-sync-management';
const channelUrl = `${(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '')}/api/app-resource-sync/channel`;
const live = (session: Metadata) => !session.revoked_at && new Date(session.expires_at).getTime() > Date.now();
async function result<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await appApiError(response, 'Operator session is unavailable.'));
  return response.json() as Promise<T>;
}

export function OperatorSessionClient({ bindingId }: { bindingId: string }) {
  const { user, sessionCacheScope } = useAuth();
  useSetPageContext(<span className="text-sm font-semibold">Private resource operator</span>, []);
  if (!user || !sessionCacheScope) return null;
  return <OperatorSession key={`${sessionCacheScope}:${bindingId}`} bindingId={bindingId} />;
}

function OperatorSession({ bindingId }: { bindingId: string }) {
  const [sessions, setSessions] = useState<Metadata[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [credential, setCredential] = useState<string | null>(null);
  const [credentialExpiry, setCredentialExpiry] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const clearCredential = useCallback(() => {
    generation.current += 1; setCredential(null); setCredentialExpiry(null); setBusy(false);
  }, []);
  const load = useCallback(async (cursor?: string) => {
    const request = ++generation.current;
    setBusy(true); setError(null); setLoaded(false);
    try {
      const body = await result<{ sessions: Metadata[]; next_after: string | null }>(await api.get(`${management}/bindings/${encodeURIComponent(bindingId)}/sessions?limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`));
      if (request !== generation.current || document.hidden) return;
      setSessions(previous => cursor ? [...previous, ...body.sessions.filter(item => !previous.some(old => old.session_id === item.session_id))] : body.sessions);
      setAfter(body.next_after); setLoaded(true);
    } catch (reason) {
      if (request === generation.current) { setSessions([]); setAfter(null); setCredential(null); setCredentialExpiry(null);
        setError(reason instanceof Error ? reason.message : 'Unable to discover sessions.'); }
    } finally { if (request === generation.current) setBusy(false); }
  }, [bindingId]);
  useEffect(() => {
    void load();
    const visibility = () => {
      if (document.hidden) { clearCredential(); setSessions([]); setLoaded(false); setNotice('Credential hidden. Refresh sessions to recover any interrupted issuance.'); }
      else void load();
    };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', clearCredential);
    return () => { generation.current += 1; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', clearCredential); };
  }, [load, clearCredential]);
  useEffect(() => {
    if (!credentialExpiry) return;
    const remaining = new Date(credentialExpiry).getTime() - Date.now();
    const timer = setTimeout(() => { clearCredential(); setNotice('Operator credential expired.'); void load(); }, Math.min(Math.max(0, remaining), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [credentialExpiry, clearCredential, load]);
  useEffect(() => {
    const expiries = sessions.filter(live).map(item => new Date(item.expires_at).getTime());
    if (!expiries.length) return;
    const timer = setTimeout(() => { clearCredential(); void load(); }, Math.min(Math.max(0, Math.min(...expiries) - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [sessions, clearCredential, load]);
  const issue = async () => {
    const request = ++generation.current;
    setBusy(true); setCredential(null); setError(null); setNotice(null);
    try {
      const body = await result<{ session: Session }>(await api.post(`${management}/bindings/${encodeURIComponent(bindingId)}/sessions`));
      if (request !== generation.current || document.hidden) return;
      if (!Number.isFinite(new Date(body.session.expires_at).getTime()) || new Date(body.session.expires_at).getTime() <= Date.now()) {
        setNotice('The session expired before delivery. Refresh sessions before requesting another.'); await load(); return;
      }
      // A response can arrive after consent/session revocation. Confirm current
      // assignment and this exact session before disclosing its one-time token.
      const confirmed = await result<{ sessions: Metadata[] }>(await api.get(`${management}/bindings/${encodeURIComponent(bindingId)}/sessions?session_id=${encodeURIComponent(body.session.session_id)}`));
      if (request !== generation.current || document.hidden) return;
      const current = confirmed.sessions.find(item => item.session_id === body.session.session_id && live(item));
      if (!current) throw new Error('The issued session is no longer active.');
      setSessions(previous => [current, ...previous.filter(item => item.session_id !== current.session_id)]);
      setCredentialExpiry(current.expires_at);
      setCredential(JSON.stringify({ session_id: body.session.session_id, session_token: body.session.session_token }, null, 2));
    } catch (reason) {
      if (request !== generation.current || document.hidden) return;
      setNotice(`${reason instanceof Error ? reason.message : 'Credential delivery was interrupted.'} Discover and revoke any active session before requesting a replacement.`);
      await load();
    } finally { if (request === generation.current) setBusy(false); }
  };
  const revoke = async (sessionId: string) => {
    const request = ++generation.current;
    setBusy(true); setCredential(null); setCredentialExpiry(null); setError(null);
    try {
      await result(await api.post(`${management}/sessions/${encodeURIComponent(sessionId)}/revoke`));
      if (request !== generation.current || document.hidden) return;
      setNotice('Operator session revoked. Its credential no longer works.'); await load();
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to revoke session.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const active = sessions.filter(live);
  return <div className={`${styles.workspace} flex h-full min-h-0 flex-1 flex-col overflow-hidden`}>
    <PageHeader title="Private resource operator" description="Issue a temporary credential for the provider you run." compact />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><section className="mx-auto max-w-3xl space-y-4">
      <Link className="deft-pill min-h-11" href="/settings/apps/private-resources">← Private resources</Link>
      <div className="space-y-4 rounded-xl border p-4 text-sm" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
        <p>Only the assigned operator can issue this connection’s credential. Give it directly to the provider process you run. Saved records remain private to their owner.</p>
        <p>The credential is shown once, cleared when you leave or hide this page, and lasts at most 15 minutes. Hiding it does not revoke the session.</p>
        <p>If delivery is interrupted, refresh sessions and revoke the unreceived session before issuing a replacement.</p>
        <label className="block space-y-1"><span>Sync channel URL</span><input aria-label="Sync channel URL" readOnly value={channelUrl} className="min-h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-xs" style={{ borderColor: 'var(--ghost-border)' }} /></label>
        {error && <p role="alert" className="break-words" style={{ color: 'var(--error)' }}>{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {busy && <p role="status">Updating operator sessions…</p>}
        {credential && <label className="block space-y-2"><span className="font-medium">Operator credential</span><textarea aria-label="Operator credential" readOnly autoComplete="off" spellCheck={false} rows={6} value={credential} className="w-full min-w-0 resize-none rounded-lg border bg-transparent p-3 font-mono text-xs" style={{ borderColor: 'var(--ghost-border)' }} /><span className="block text-xs">Keep this credential out of App content, messages and shared files.</span></label>}
        <section aria-label="Your operator sessions" className="space-y-3">
          <h2 className="font-semibold">Your operator sessions</h2>
          {loaded && active.length === 0 && <p>No active sessions on this page.</p>}
          {sessions.map(item => <div key={item.session_id} className="space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--ghost-border)' }}><p>{item.revoked_at ? 'Revoked' : live(item) ? 'Active' : 'Expired'} · Issued {new Date(item.created_at).toLocaleString()}. Expires {new Date(item.expires_at).toLocaleString()}.</p>{live(item) && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void revoke(item.session_id)}>Revoke operator session</button>}</div>)}
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" disabled={busy} onClick={() => { clearCredential(); void load(); }}>Refresh sessions</button>{after && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void load(after)}>Next sessions</button>}{loaded && !after && active.length === 0 && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void issue()}>Issue operator credential</button>}{credential && <button className="deft-pill min-h-11" disabled={busy} onClick={() => { clearCredential(); setNotice('Credential hidden. Revoke its session before requesting another.'); }}>Hide credential</button>}</div>
        </section>
      </div>
    </section></div>
  </div>;
}
