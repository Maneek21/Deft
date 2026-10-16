'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/page-header';

type Identity = { registrationId: string; resourceType: string; projectionId: string };
type Operation = 'cite' | 'read' | 'search';
type Review = { review_token: string; review_digest: string; custody_notice: string;
  selected_data: Record<string, string | number | boolean>; snapshot: {
    app_installation_id: string; app_label: string; token_label: string; subject_label: string; field_keys: string[]; operations: Operation[];
    destination: { kind: 'personal_mcp' | 'employee_mcp'; token_id: string }; expires_at: string; review_expires_at: string;
  } };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const control = 'min-h-11 rounded border border-border px-3 py-2 text-sm';
const notice = 'Anyone holding this exact credential may receive these fields in an external MCP client. Revocation stops future Deft access and cannot recall copies already delivered.';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Private MCP access unavailable.');
  return value as Record<string, unknown>;
}
function normalize(value: unknown, tokenId: string, kind: string, fields: string[], operations: Operation[], identity: Identity): Review {
  const r = object(value), s = object(r.snapshot), destination = object(s.destination), data = object(r.selected_data);
  const ref = object(s.ref), provider = object(ref.provider);
  if (new TextEncoder().encode(JSON.stringify(r)).byteLength > 131072
    || Object.keys(r).some(k => !['snapshot', 'selected_data', 'custody_notice', 'review_digest', 'review_token'].includes(k))
    || s.schema_version !== 'deft.app_private_mcp_snapshot.v1' || s.purpose !== 'mcp_private_context'
    || typeof s.app_installation_id !== 'string' || !uuid.test(s.app_installation_id)
    || ref.schema_version !== 'deft.resource_ref.v2' || provider.kind !== 'app_runtime' || provider.provider_instance_id !== identity.registrationId
    || ref.resource_type !== identity.resourceType || ref.resource_id !== identity.projectionId
    || destination.kind !== kind || destination.token_id !== tokenId || r.custody_notice !== notice
    || typeof r.review_token !== 'string' || r.review_token.length > 16384
    || typeof r.review_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(r.review_digest)
    || !['app_label', 'token_label', 'subject_label'].every(k => typeof s[k] === 'string' && s[k].length <= 200)
    || !['expires_at', 'review_expires_at'].every(k => typeof s[k] === 'string' && Date.parse(s[k]) > Date.now())
    || JSON.stringify(s.field_keys) !== JSON.stringify(fields) || JSON.stringify(s.operations) !== JSON.stringify(operations)
    || Object.keys(data).length !== fields.length || fields.some(k => !Object.hasOwn(data, k))
    || !Object.values(data).every(v => typeof v === 'string' && v.length <= 4096 || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v))) throw new Error('MCP review changed or expired. Review again.');
  return r as unknown as Review;
}
export function PrivateResourceMcpReview(identity: Identity) {
  const { user, sessionCacheScope } = useAuth();
  if (!user || !sessionCacheScope) return null;
  return <McpReviewView key={`${sessionCacheScope}/${identity.registrationId}/${identity.resourceType}/${identity.projectionId}`} {...identity} />;
}
function McpReviewView(identity: Identity) {
  const [fields, setFields] = useState<string[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]), [kind, setKind] = useState<'personal_mcp' | 'employee_mcp'>('personal_mcp');
  const [tokenId, setTokenId] = useState(''), [minutes, setMinutes] = useState(15);
  const [review, setReview] = useState<Review | null>(null), [grant, setGrant] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(true);
  const generation = useRef(0), disposed = useRef(false), expiry = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useCallback(() => { inflight.current?.abort(); inflight.current = null; clearTimeout(requestTimer.current); }, []);
  const begin = useCallback(() => {
    abort(); const controller = new AbortController(); inflight.current = controller;
    requestTimer.current = setTimeout(() => controller.abort(), 15000);
    return { request: ++generation.current, session: api.getAccessToken(), signal: controller.signal };
  }, [abort]);
  const send = useCallback((path: string, signal: AbortSignal, method = 'GET', body?: unknown) => api.fetch(path, {
    method, signal, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }), []);
  const current = useCallback((request: number, session: string | null) => !disposed.current && request === generation.current
    && !document.hidden && expiry.current > Date.now() && isSameWebSession(session, api.getAccessToken()), []);
  useLayoutEffect(() => {
    disposed.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { abort(); generation.current++; expiry.current = 0; setFields([]); setSelected([]); setReview(null); setGrant(null); setBusy(false); };
    const load = async () => {
      const { request, session, signal } = begin();
      setBusy(true); setError(null); setReview(null); setGrant(null); setFields([]);
      try {
        const response = await send(`/api/app-resource-private/references/${identity.registrationId}/${identity.resourceType}/${identity.projectionId}`, signal);
        if (!response.ok) throw new Error('Owner private access unavailable.');
        const body = object(await response.json()), data = object(body.data), ref = object(body.ref), provider = object(ref.provider);
        if (provider.provider_instance_id !== identity.registrationId || ref.resource_type !== identity.resourceType || ref.resource_id !== identity.projectionId
          || typeof body.consent_expires_at !== 'string' || !Number.isFinite(Date.parse(body.consent_expires_at))) throw new Error('Owner private access unavailable.');
        // A superseded load must not mutate the current authority deadline.
        if (disposed.current || request !== generation.current || signal.aborted || document.hidden || !isSameWebSession(session, api.getAccessToken())) return;
        const deadline = Date.parse(body.consent_expires_at);
        if (deadline <= Date.now()) throw new Error('Owner consent expired.');
        expiry.current = deadline;
        setFields(Object.keys(data).filter(k => /^[a-z][a-z0-9_]{0,47}$/u.test(k)).sort());
        clearTimeout(timer); timer = setTimeout(() => { clear(); setError('Owner consent expired.'); }, Math.min(expiry.current - Date.now(), 2147483647));
      } catch (reason) { if (!disposed.current && request === generation.current) setError(reason instanceof Error ? reason.message : 'Private MCP access unavailable.'); }
      finally { if (!disposed.current && request === generation.current) setBusy(false); }
    };
    const visibility = () => { if (document.hidden) clear(); else void load(); };
    document.addEventListener('visibilitychange', visibility); addEventListener('pagehide', clear);
    if (!document.hidden) void load(); else setBusy(false);
    return () => { disposed.current = true; abort(); generation.current++; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); removeEventListener('pagehide', clear); };
  }, [identity.registrationId, identity.resourceType, identity.projectionId, abort, begin, current, send]);
  useLayoutEffect(() => {
    if (!review) return;
    const deadline = Math.min(expiry.current, Date.parse(review.snapshot.review_expires_at), Date.parse(review.snapshot.expires_at));
    const clear = () => { abort(); generation.current++; setReview(null); setGrant(null); setBusy(false); setError('MCP review or access expired. Review again.'); };
    if (deadline <= Date.now()) { clear(); return; }
    const timer = setTimeout(clear, Math.min(deadline - Date.now(), 2147483647));
    return () => clearTimeout(timer);
  }, [review, abort]);
  const change = () => { abort(); generation.current++; setReview(null); setGrant(null); setError(null); setBusy(false); };
  const prepare = async () => {
    const { request, session, signal } = begin(); setBusy(true); setError(null); setReview(null);
    try {
      const orderedFields = [...selected].sort(), orderedOperations = [...operations].sort();
      const response = await send('/api/app-private-mcp/reviews', signal, 'POST', { schema_version: 'deft.app_private_mcp_review.v1',
        ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'app_runtime', provider_instance_id: identity.registrationId }, resource_type: identity.resourceType, resource_id: identity.projectionId },
        destination: { kind, token_id: tokenId }, field_keys: orderedFields, operations: orderedOperations, expires_at: new Date(Date.now() + minutes * 60000).toISOString() });
      if (!response.ok) throw new Error('Private MCP review unavailable.');
      const value = normalize(await response.json(), tokenId, kind, orderedFields, orderedOperations, identity);
      if (current(request, session)) setReview(value);
    } catch (reason) { if (current(request, session)) setError(reason instanceof Error ? reason.message : 'Private MCP review unavailable.'); }
    finally { if (current(request, session)) setBusy(false); }
  };
  const accept = async () => {
    if (!review) return;
    const { request, session, signal } = begin(); setBusy(true); setError(null);
    try {
      if (Date.parse(review.snapshot.review_expires_at) <= Date.now()) throw new Error('Review expired. Review again.');
      const response = await send('/api/app-private-mcp/grants', signal, 'POST', { review_token: review.review_token, review_digest: review.review_digest, accept_access: true });
      if (!response.ok) throw new Error('Private MCP access was not accepted.');
      const value = object(await response.json());
      if (typeof value.grant_id !== 'string' || !uuid.test(value.grant_id)) throw new Error('MCP access status unavailable.');
      if (current(request, session) && Date.parse(review.snapshot.review_expires_at) > Date.now() && Date.parse(review.snapshot.expires_at) > Date.now()) setGrant(value.grant_id);
    } catch (reason) { if (current(request, session)) setError(reason instanceof TypeError ? 'Status unavailable. Retry acceptance to recover the same grant.' : reason instanceof Error ? reason.message : 'MCP access unavailable.'); }
    finally { if (current(request, session)) setBusy(false); }
  };
  const revoke = async () => {
    if (!grant) return;
    const { request, session, signal } = begin(); setBusy(true); setError(null);
    try {
      const response = await send(`/api/app-private-mcp/grants/${grant}`, signal, 'DELETE');
      if (!response.ok) throw new Error('Revocation unavailable. Retry revocation.');
      if (current(request, session)) { setGrant(null); setReview(null); }
    } catch (reason) { if (current(request, session)) setError(reason instanceof Error ? reason.message : 'Revocation unavailable.'); }
    finally { if (current(request, session)) setBusy(false); }
  };
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"><PageHeader title="Private MCP access" />
    <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><div className="max-w-2xl space-y-4">
      <p>Review one saved record for one exact personal or employee MCP credential. Human sharing, Worker access and action authority remain separate.</p>
      {busy && <p role="status">Checking private access...</p>}{error && <p role="alert">{error}</p>}
      {!!fields.length && <><label className="block">Credential destination<select className={`${control} mt-1 block w-full`} value={kind} onChange={e => { change(); setKind(e.target.value as typeof kind); }}><option value="personal_mcp">Personal MCP credential</option><option value="employee_mcp">Employee MCP credential</option></select></label>
        <label className="block">Exact credential ID (not its secret)<input className={`${control} mt-1 block w-full`} value={tokenId} onChange={e => { change(); setTokenId(e.target.value.trim()); }} /></label>
        <p className="text-sm">Personal credential IDs appear in <Link className="underline" href="/settings/mcp-access">MCP access settings</Link>. Enter the credential ID, never the bearer secret.</p>
        {kind === 'employee_mcp' && <p className="text-sm">Use the mcp_token_id returned when the owner creates or regenerates this employee credential. Older credentials must be rotated to obtain this ID.</p>}
        <fieldset><legend>Selected fields</legend>{fields.map(field => <label className="flex min-h-11 items-center gap-2 break-all" key={field}><input type="checkbox" checked={selected.includes(field)} onChange={e => { change(); setSelected(value => e.target.checked ? [...value, field] : value.filter(v => v !== field)); }} />{field}</label>)}</fieldset>
        <fieldset><legend>Selected MCP operations</legend>{(['read', 'search', 'cite'] as Operation[]).map(op => <label className="flex min-h-11 items-center gap-2" key={op}><input type="checkbox" checked={operations.includes(op)} onChange={e => { change(); setOperations(value => e.target.checked ? [...value, op] : value.filter(v => v !== op)); }} />{op}</label>)}</fieldset>
        <label className="block">Maximum minutes (owner consent may end sooner)<input className={`${control} mt-1 block w-full`} type="number" min={1} max={15} value={minutes} onChange={e => { change(); setMinutes(Math.max(1, Math.min(15, Number(e.target.value) || 1))); }} /></label>
        <button className={control} disabled={busy || !uuid.test(tokenId) || !selected.length || !operations.length} onClick={() => void prepare()}>Review exact MCP access</button></>}
      {review && expiry.current > Date.now() && Date.parse(review.snapshot.review_expires_at) > Date.now() && Date.parse(review.snapshot.expires_at) > Date.now() && <section className="space-y-3 rounded border border-border p-4" aria-label="Exact MCP access review"><h2 className="font-semibold">Review external MCP disclosure</h2>
        <p className="break-words">{review.snapshot.app_label}</p><p className="break-words">Credential: {review.snapshot.token_label} · {review.snapshot.subject_label}</p>
        <p className="break-all">Exact credential ID: {review.snapshot.destination.token_id}</p><p>Fields: {review.snapshot.field_keys.join(', ')}</p><p>Operations: {review.snapshot.operations.join(', ')}</p>
        <p>Access ends: {new Date(review.snapshot.expires_at).toLocaleString()}</p><p>Review ends: {new Date(review.snapshot.review_expires_at).toLocaleString()}</p><p>{review.custody_notice}</p><p>Changed saved content or lost current authority makes this grant unavailable. This does not authorize any action.</p>
        <dl className="space-y-3" aria-label="Exact selected values">{Object.entries(review.selected_data).map(([key, value]) => <div key={key}><dt className="font-semibold">{key}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(value)}</dd></div>)}</dl>
        <Link className="inline-flex min-h-11 items-center underline" href={`/private-app-resources/mcp/${review.snapshot.app_installation_id}`}>Manage this App’s MCP access</Link>
        {!grant ? <div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => void accept()}>Accept exact MCP access</button><button className={control} disabled={busy} onClick={() => { abort(); generation.current++; setReview(null); }}>Cancel review</button></div>
          : <><p className="break-all">Accepted grant ID: {grant}</p><button className={control} disabled={busy} onClick={() => void revoke()}>Revoke MCP access</button></>}
      </section>}
    </div></main></div>;
}

type InventoryItem = { grant_id: string; label: string; destination: { kind: string; token_id: string }; expires_at: string; state: string };
export function PrivateResourceMcpInventory({ appId }: { appId: string }) {
  const { user, sessionCacheScope } = useAuth();
  if (!user || !sessionCacheScope) return null;
  return <McpInventoryView key={`${sessionCacheScope}/${appId}`} appId={appId} />;
}
function McpInventoryView({ appId }: { appId: string }) {
  const [items, setItems] = useState<InventoryItem[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), disposed = useRef(false), inflight = useRef<AbortController | null>(null);
  const current = useCallback((request: number, session: string | null) => !disposed.current && !document.hidden && request === generation.current && isSameWebSession(session, api.getAccessToken()), []);
  const load = useCallback(async (continuation?: string) => {
    inflight.current?.abort(); const controller = new AbortController(); inflight.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000), request = ++generation.current, session = api.getAccessToken();
    setBusy(true); setError(null); setItems([]); setCursor(null);
    try {
      const response = await api.fetch('/api/app-private-mcp/inventory', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_installation_id: appId, ...(continuation ? { cursor: continuation } : {}) }) });
      if (!response.ok) throw new Error('Owned MCP access inventory unavailable.');
      const result = object(await response.json());
      if (result.schema_version !== 'deft.app_private_mcp_inventory.v1' || !Array.isArray(result.items) || result.items.length > 25
        || result.next_cursor !== null && (typeof result.next_cursor !== 'string' || result.next_cursor.length > 2048)
        || new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) throw new Error('Invalid owned MCP access inventory.');
      const page = result.items.map(value => {
        const item = object(value), destination = object(item.destination);
        if (typeof item.grant_id !== 'string' || !uuid.test(item.grant_id) || item.label !== 'Private App record'
          || typeof destination.token_id !== 'string' || !uuid.test(destination.token_id) || !['personal_mcp', 'employee_mcp'].includes(String(destination.kind))
          || typeof item.expires_at !== 'string' || !Number.isFinite(Date.parse(item.expires_at)) || !['active', 'expired', 'revoked'].includes(String(item.state))) throw new Error('Invalid owned MCP access inventory.');
        return item as unknown as InventoryItem;
      });
      if (current(request, session)) { setItems(page); setCursor(result.next_cursor as string | null); }
    } catch (reason) { if (current(request, session)) setError(reason instanceof Error ? reason.message : 'Owned MCP access inventory unavailable.'); }
    finally { clearTimeout(timer); if (current(request, session)) setBusy(false); }
  }, [appId, current]);
  useLayoutEffect(() => {
    disposed.current = false;
    const clear = () => { inflight.current?.abort(); generation.current++; setItems([]); setCursor(null); setBusy(false); };
    const visibility = () => { if (document.hidden) clear(); else void load(); };
    document.addEventListener('visibilitychange', visibility); addEventListener('pagehide', clear);
    if (!document.hidden) void load();
    return () => { disposed.current = true; clear(); document.removeEventListener('visibilitychange', visibility); removeEventListener('pagehide', clear); };
  }, [appId, load]);
  const revoke = async (id: string) => {
    inflight.current?.abort(); const controller = new AbortController(); inflight.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000), request = ++generation.current, session = api.getAccessToken();
    setBusy(true); setError(null);
    try {
      const response = await api.fetch(`/api/app-private-mcp/grants/${id}`, { method: 'DELETE', signal: controller.signal });
      if (!response.ok) throw new Error('Revocation unavailable. Retry revocation.');
      if (current(request, session)) await load();
    } catch (reason) { if (current(request, session)) setError(reason instanceof Error ? reason.message : 'Revocation unavailable.'); }
    finally { clearTimeout(timer); if (current(request, session)) setBusy(false); }
  };
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"><PageHeader title="Owned private MCP access" /><main className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><div className="max-w-2xl space-y-4">
    <p>Only generic grant metadata is shown. Revocation remains available after the App, saved content or credential becomes unavailable.</p>
    {busy && <p role="status">Checking owned MCP access...</p>}{error && <p role="alert">{error}</p>}
    <button className={control} disabled={busy} onClick={() => void load()}>Refresh owned MCP access</button>
    {items.map(item => <article className="space-y-2 rounded border border-border p-4" key={item.grant_id}><h2 className="font-semibold">{item.label}</h2><p>{item.destination.kind === 'employee_mcp' ? 'Employee MCP credential' : 'Personal MCP credential'}</p><p className="break-all">Credential ID: {item.destination.token_id}</p><p>State: {item.state}. Ends: {new Date(item.expires_at).toLocaleString()}</p>
      {item.state !== 'revoked' && <button className={control} disabled={busy} onClick={() => void revoke(item.grant_id)}>Revoke MCP access</button>}</article>)}
    {cursor && <button className={control} disabled={busy} onClick={() => void load(cursor)}>Next 25 grants</button>}
  </div></main></div>;
}
