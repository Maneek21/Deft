'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { PageHeader } from '@/components/page-header';
type Scope = { field_keys: string[]; label_field: string; consent_expires_at: string };
type Hit = { label: string; snippet: string; field_key: string; href: string; ref: unknown };
type Page = { schema_version: string; items: Hit[]; next_cursor: string | null;
  scan: { records_scanned: number; complete: boolean }; freshness: string; consent_expires_at: string };
const invalid = () => new Error('Private search is unavailable.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function scopeValue(value: unknown): Scope {
  const v = object(value);
  if (!Array.isArray(v.field_keys) || v.field_keys.length > 32 || !v.field_keys.every(k => typeof k === 'string' && /^[a-z][a-z0-9_]{0,47}$/u.test(k))
    || typeof v.label_field !== 'string' || typeof v.consent_expires_at !== 'string' || !Number.isFinite(Date.parse(v.consent_expires_at))) throw invalid();
  return { field_keys: v.field_keys, label_field: v.label_field, consent_expires_at: v.consent_expires_at };
}
function pageValue(value: unknown, fields: string[]): Page {
  const v = object(value), scan = object(v.scan);
  if (v.schema_version !== 'deft.app_private_search_page.v1' || v.freshness !== 'unknown'
    || typeof v.consent_expires_at !== 'string' || !Number.isFinite(Date.parse(v.consent_expires_at))
    || typeof scan.records_scanned !== 'number' || !Number.isInteger(scan.records_scanned) || scan.records_scanned < 0 || scan.records_scanned > 100
    || typeof scan.complete !== 'boolean' || !(v.next_cursor === null || typeof v.next_cursor === 'string' && v.next_cursor.length <= 2048)
    || scan.complete !== (v.next_cursor === null) || !Array.isArray(v.items) || v.items.length > 25
    || new TextEncoder().encode(JSON.stringify(v)).byteLength > 65536) throw invalid();
  const items = v.items.map(value => { const h = object(value);
    if (typeof h.label !== 'string' || h.label.length > 200 || typeof h.snippet !== 'string' || h.snippet.length > 240
      || typeof h.field_key !== 'string' || !fields.includes(h.field_key) || typeof h.href !== 'string'
      || !/^\/app-resources\/[a-f0-9-]{36}\/[a-z][a-z0-9_]{0,63}\/[a-f0-9-]{36}$/u.test(h.href)) throw invalid();
    return { label: h.label, snippet: h.snippet, field_key: h.field_key, href: h.href, ref: h.ref }; });
  return { schema_version: v.schema_version, items, scan: { records_scanned: scan.records_scanned, complete: scan.complete },
    next_cursor: v.next_cursor, freshness: v.freshness, consent_expires_at: v.consent_expires_at };
}
export function PrivateResourceSearch({ bindingId }: { bindingId: string }) {
  const { user, sessionCacheScope } = useAuth();
  if (!user || !sessionCacheScope) return null;
  return <SearchView key={`${sessionCacheScope}/${user.role}/${bindingId}`} bindingId={bindingId} />;
}
function SearchView({ bindingId }: { bindingId: string }) {
  const [scope, setScope] = useState<Scope | null>(null), [fields, setFields] = useState<string[]>([]);
  const [query, setQuery] = useState(''), [hits, setHits] = useState<Hit[]>([]), [page, setPage] = useState<Page | null>(null);
  const [scanned, setScanned] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const generation = useRef(0), alive = useRef(false), pending = useRef<AbortController | null>(null);
  const clear = () => { generation.current++; pending.current?.abort(); setHits([]); setPage(null); setScanned(0); setBusy(false); };
  useLayoutEffect(() => {
    alive.current = true; let timer: ReturnType<typeof setTimeout>;
    const clearPrivate = () => { clear(); setScope(null); };
    const onHide = () => { if (document.hidden) clearPrivate(); };
    const request = ++generation.current, token = api.getAccessToken();
    const controller = new AbortController(); pending.current = controller;
    void (async () => { try {
      const response = await api.fetch(`/api/app-resource-private/bindings/${encodeURIComponent(bindingId)}/search-scope`, { signal: controller.signal });
      if (!response.ok) throw new Error(await appApiError(response, 'Private search is unavailable.'));
      const value = scopeValue(await response.json()), deadline = Date.parse(value.consent_expires_at);
      if (!alive.current || request !== generation.current || document.hidden || !isSameWebSession(token, localStorage.getItem('deft-access-token')) || deadline <= Date.now()) return;
      setScope(value); setFields([value.label_field]);
      timer = setTimeout(() => { clearPrivate(); setError('Private resource consent expired.'); }, Math.min(deadline - Date.now(), 2147483647));
    } catch (e) { if (alive.current && request === generation.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Private search is unavailable.'); } })();
    document.addEventListener('visibilitychange', onHide); addEventListener('pagehide', clearPrivate);
    return () => { alive.current = false; generation.current++; pending.current?.abort(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHide); removeEventListener('pagehide', clearPrivate); };
  }, [bindingId]);
  const search = async (continuation = false) => {
    if (!scope || !fields.length || !query.trim() || document.hidden) return;
    if (!continuation) clear();
    const request = ++generation.current, token = api.getAccessToken(), controller = new AbortController();
    pending.current?.abort(); pending.current = controller; setBusy(true); setError(null);
    try {
      const response = await api.fetch(`/api/app-resource-private/bindings/${encodeURIComponent(bindingId)}/search`, { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ query, field_keys: fields, ...(continuation && page?.next_cursor ? { cursor: page.next_cursor } : {}) }) });
      if (!response.ok) { if (response.status === 409) clear(); throw new Error(await appApiError(response, 'Private search is unavailable.')); }
      const value = pageValue(await response.json(), fields);
      if (!alive.current || request !== generation.current || controller.signal.aborted || document.hidden
        || !isSameWebSession(token, localStorage.getItem('deft-access-token')) || Date.parse(value.consent_expires_at) <= Date.now()) return;
      setHits(value.items); setPage(value);
      setScanned(previous => continuation ? previous + value.scan.records_scanned : value.scan.records_scanned);
    } catch (e) { if (alive.current && request === generation.current && !controller.signal.aborted) { setHits([]); setPage(null); setError(e instanceof Error ? e.message : 'Private search is unavailable.'); } }
    finally { if (alive.current && request === generation.current) setBusy(false); }
  };
  return <div className="flex h-full min-h-0 flex-col overflow-hidden"><PageHeader title="Search saved App data" />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-6"><p className="mb-4 text-sm">Owner-only saved data. Provider freshness is unknown. Continue until the search is complete.</p>
      {error && <p role="alert" className="mb-4 break-words">{error}</p>}
      {scope && <form onSubmit={event => { event.preventDefault(); void search(); }} className="mb-4 space-y-3">
        <label className="block">Literal search<input aria-label="Literal search" maxLength={200} value={query} onChange={event => { clear(); setQuery(event.target.value); }} className="mt-1 block min-h-11 w-full rounded border p-2" /></label>
        <fieldset><legend>Approved fields</legend>{scope.field_keys.map(field => <label key={field} className="mr-4 inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={fields.includes(field)} onChange={() => { clear(); setFields(previous => previous.includes(field) ? previous.filter(key => key !== field) : [...previous, field]); }} />{field}</label>)}</fieldset>
        <button className="deft-pill min-h-11" style={{ minHeight: 44 }} disabled={busy || !query.trim() || !fields.length}>Search saved data</button>
      </form>}
      {busy && <p role="status">Searching this saved checkpoint…</p>}
      {page && <p role="status" className="mb-3">{page.scan.complete ? 'Search complete' : 'More saved records remain to scan'} · {scanned} records scanned · {hits.length} matches on this page</p>}
      <ul className="space-y-4">{hits.map(hit => <li key={hit.href} className="break-words [overflow-wrap:anywhere]"><Link href={hit.href} className="inline-flex min-h-11 items-center font-semibold underline">{hit.label}</Link><p className="whitespace-pre-wrap text-sm">{hit.snippet}</p><p className="text-xs">Field: {hit.field_key}</p></li>)}</ul>
      {page?.next_cursor && <button className="deft-pill mt-4 min-h-11" style={{ minHeight: 44 }} disabled={busy} onClick={() => void search(true)}>Continue search</button>}
    </div></div>;
}
