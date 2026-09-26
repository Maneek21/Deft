'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, LockKeyhole, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { useSetPageContext } from '@/components/app-header-context';
import { api } from '@/lib/api';
import { appApiError } from '@/lib/apps';
import { useAuth } from '@/lib/auth-context';
import { useApps } from '@/hooks/use-apps';
import { PrivateResourceSetup } from './private-resource-setup';
import { OperatorAssignments } from './operator-assignments';
import styles from './private-resources.module.css';

type Binding = { binding_id: string; installation_id: string; resource_key: string; state: string; consent_expires_at: string };
type Status = { binding: Binding; checkpoint: { state: string; retained_record_count: number; last_applied_at: string | null } | null; latest_run: { state: string; terminal_at: string | null } | null };
type RecordPage = { items: Array<{ projection_id: string; label: string; data: Record<string, unknown> }>; next_cursor: string | null };
const management = '/api/app-resource-sync-management';
async function result<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await appApiError(response, 'This private resource is unavailable.'));
  return response.json() as Promise<T>;
}

export function PrivateResourcesClient() {
  const { user, sessionCacheScope } = useAuth();
  useSetPageContext(<span className="text-sm font-semibold">Private App resources</span>, []);
  if (!sessionCacheScope || !user) return null;
  if (user.role === 'guest') return <p className="p-6">Private App resources require an active workspace membership.</p>;
  if (user.role !== 'owner' && user.role !== 'admin') return <div key={sessionCacheScope} className={`${styles.workspace} flex h-full min-h-0 flex-1 flex-col overflow-hidden`}><PageHeader title="Private App resources" description="Your assigned provider connections." compact /><div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><OperatorAssignments /></div></div>;
  return <PrivateResourceWorkspace key={sessionCacheScope} />;
}

function PrivateResourceWorkspace() {
  const { apps } = useApps();
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Status | null>(null);
  const [page, setPage] = useState<RecordPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeReview, setRevokeReview] = useState(false);
  const [consentExpired, setConsentExpired] = useState(false);
  const [setupGeneration, setSetupGeneration] = useState(0);
  const generation = useRef(0);
  const clearContent = useCallback(() => { generation.current += 1; setPage(null); setBusy(false); }, []);

  const loadBindings = useCallback(async (cursor?: string) => {
    const request = ++generation.current;
    setBusy(true); setError(null); setPage(null); setSelected(null); setRevokeReview(false);
    try {
      const body = await result<{ bindings: Binding[]; next_after: string | null }>(await api.get(`${management}/bindings?limit=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`));
      if (request !== generation.current) return;
      setBindings(body.bindings); setAfter(body.next_after);
    } catch (reason) {
      if (request === generation.current) { setBindings([]); setAfter(null); setError(reason instanceof Error ? reason.message : 'Unable to load resources.'); }
    } finally { if (request === generation.current) setBusy(false); }
  }, []);
  useEffect(() => {
    void loadBindings();
    const hide = () => { if (document.hidden) clearContent(); else void loadBindings(); };
    document.addEventListener('visibilitychange', hide);
    return () => { generation.current += 1; document.removeEventListener('visibilitychange', hide); };
  }, [loadBindings, clearContent]);
  useEffect(() => {
    if (!selected) return;
    const expiresAt = new Date(selected.binding.consent_expires_at).getTime();
    let timer: ReturnType<typeof setTimeout>;
    setConsentExpired(false);
    const check = () => {
      const remaining = expiresAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        clearContent(); setConsentExpired(true); return;
      }
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [selected, clearContent]);

  const open = async (binding: Binding) => {
    const request = ++generation.current;
    setBusy(true); setError(null); setPage(null); setSelected(null); setRevokeReview(false);
    try {
      const status = await result<Status>(await api.get(`${management}/bindings/${encodeURIComponent(binding.binding_id)}`));
      if (request === generation.current) setSelected(status);
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to load status.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const read = async (cursor?: string) => {
    if (!selected) return;
    const expiresAt = new Date(selected.binding.consent_expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearContent(); setConsentExpired(true); return;
    }
    const request = ++generation.current;
    setBusy(true); setError(null); setPage(null);
    try {
      const body = await result<RecordPage>(await api.get(`/api/app-resource-private/bindings/${encodeURIComponent(selected.binding.binding_id)}/records?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      if (request === generation.current) {
        if (expiresAt <= Date.now()) { clearContent(); setConsentExpired(true); }
        else setPage(body);
      }
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to read records.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const revoke = async () => {
    if (!selected) return;
    const request = ++generation.current;
    setBusy(true); setPage(null); setError(null); setRevokeReview(false);
    try {
      await result(await api.post(`${management}/bindings/${encodeURIComponent(selected.binding.binding_id)}/revoke`));
      if (request === generation.current) { setSetupGeneration(value => value + 1); await loadBindings(); }
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to revoke access.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const readable = !consentExpired && selected?.binding.state === 'active' && new Date(selected.binding.consent_expires_at).getTime() > Date.now();
  return <div className={`${styles.workspace} flex h-full min-h-0 flex-1 flex-col overflow-hidden`}>
    <PageHeader title="Your private App resources" description="Review your connections, sync activity, and saved records." compact />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2"><Link className="deft-pill min-h-11" href="/settings/apps">← Apps</Link><button className="deft-pill min-h-11" disabled={busy} onClick={() => void loadBindings()}><RefreshCw size={14} /> Refresh connections</button></div>
      <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--on-surface-variant)' }}><LockKeyhole size={16} className="mt-0.5 shrink-0" />Only resources you explicitly connected are shown here. Reading them does not share them with your workspace.</p>
      <PrivateResourceSetup key={setupGeneration} apps={apps} onChanged={() => void loadBindings()} />
      <OperatorAssignments />
      {error && <p role="alert" className="rounded-lg border p-3 text-sm" style={{ color: 'var(--error)', borderColor: 'var(--ghost-border)' }}>{error}</p>}
      {busy && <div role="status" className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" /> Loading…</div>}
      {!busy && !error && bindings.length === 0 && <p className="rounded-xl border p-5 text-sm" style={{ borderColor: 'var(--ghost-border)' }}>You have no private App connections. A connection appears here after you review and activate its consent.</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section aria-label="Your connections" className="min-w-0 space-y-2">{bindings.map((binding) => <button key={binding.binding_id} onClick={() => void open(binding)} disabled={busy} aria-pressed={selected?.binding.binding_id === binding.binding_id} className="w-full rounded-xl border p-4 text-left" style={{ borderColor: selected?.binding.binding_id === binding.binding_id ? 'var(--primary)' : 'var(--ghost-border)', background: 'var(--surface-container-low)' }}><span className="block break-words text-sm font-semibold">{binding.resource_key}</span><span className="mt-1 block break-words text-xs">{apps.find(app => app.id === binding.installation_id)?.name ?? 'Connected App'}</span><span className="mt-1 block text-xs capitalize" style={{ color: 'var(--on-surface-variant)' }}>{binding.state} · Consent ends {new Date(binding.consent_expires_at).toLocaleDateString()}</span></button>)}{after && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void loadBindings(after)}>Next connections</button>}</section>
        {selected && <section aria-label="Connection details" className="min-w-0 space-y-4 rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
          <h2 className="break-words text-base font-semibold">{selected.binding.resource_key}</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Saved records</dt><dd>{selected.checkpoint?.retained_record_count ?? 0}</dd></div><div><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Latest sync</dt><dd className="capitalize">{selected.latest_run?.state.replaceAll('_', ' ') ?? 'Not started'}</dd></div><div className="sm:col-span-2"><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Last saved update</dt><dd>{selected.checkpoint?.last_applied_at ? new Date(selected.checkpoint.last_applied_at).toLocaleString() : 'No update saved yet'}</dd></div></dl>
          <p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Saved records may differ from the source. Source freshness has not been verified.</p>
          {consentExpired && <p role="status" className="text-sm">Consent has expired. Review a new connection before reading more records.</p>}
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" disabled={busy || !readable} onClick={() => void read()}>Read saved records</button>{selected.binding.state === 'active' && <button className="deft-pill min-h-11" disabled={busy} onClick={() => { clearContent(); setRevokeReview(true); }}>Revoke access</button>}</div>
          {revokeReview && <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--ghost-border)' }}><p className="text-sm">Revoke this connection? Future syncs and private reads will be denied. Previously delivered copies cannot be recalled.</p><div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" disabled={busy} onClick={() => void revoke()}>Confirm revocation</button><button className="deft-pill min-h-11" onClick={() => setRevokeReview(false)}>Keep connection</button></div></div>}
          {page && <section aria-label="Saved records" className="space-y-2">{page.items.length === 0 ? <p className="py-3 text-sm">No saved records are available.</p> : page.items.map((item) => <details key={item.projection_id} className="rounded-lg border p-3" style={{ borderColor: 'var(--ghost-border)' }}><summary className="cursor-pointer break-words text-sm font-medium">{item.label}</summary><dl className="mt-3 space-y-3">{Object.entries(item.data).map(([key, value]) => <div key={key}><dt className="break-words text-xs font-medium" style={{ color: 'var(--on-surface-variant)' }}>{key}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl></details>)}{page.next_cursor && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void read(page.next_cursor!)}>Next records</button>}</section>}
        </section>}
      </div>
    </div></div>
  </div>;
}
