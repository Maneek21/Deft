'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ResourceRefV2 } from '@deft/shared/resources-v2';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { PageHeader } from '@/components/page-header';
import Link from 'next/link';
import { APP_PRIVATE_SHARING_ENABLED } from '@/lib/feature-flags';

type Identity = { registrationId: string; resourceType: string; projectionId: string };
type Result = { ref: ResourceRefV2; label: string;
  data: Record<string, string | number | boolean>; freshness: 'unknown'; consent_expires_at: string; search_href: string };
const unavailable = () => new Error('This private resource is unavailable.');
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const row = value as Record<string, unknown>;
  if (keys && Object.keys(row).some(key => !keys.includes(key))) throw unavailable();
  return row;
}
function normalizeResult(value: unknown): Result {
  const row = object(value, ['ref', 'label', 'data', 'freshness', 'consent_expires_at', 'search_href']);
  const ref = object(row.ref, ['schema_version', 'provider', 'resource_type', 'resource_id']);
  const provider = object(ref.provider, ['kind', 'provider_instance_id']);
  const data = object(row.data);
  if (ref.schema_version !== 'deft.resource_ref.v2' || provider.kind !== 'app_runtime'
    || typeof provider.provider_instance_id !== 'string' || typeof ref.resource_type !== 'string'
    || typeof ref.resource_id !== 'string' || typeof row.label !== 'string' || row.label.length > 200
    || row.freshness !== 'unknown' || typeof row.consent_expires_at !== 'string'
    || typeof row.search_href !== 'string' || !/^\/app-resources\/search\/[a-f0-9-]{36}$/u.test(row.search_href)
    || !Number.isFinite(Date.parse(row.consent_expires_at))
    || !Object.values(data).every(value => typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)))
    || new TextEncoder().encode(JSON.stringify(row)).byteLength > 1_048_576) throw unavailable();
  return { ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'app_runtime',
    provider_instance_id: provider.provider_instance_id }, resource_type: ref.resource_type,
    resource_id: ref.resource_id }, label: row.label,
    data: data as Result['data'], freshness: 'unknown', consent_expires_at: row.consent_expires_at, search_href: row.search_href };
}

/** Decrypted content remains local to this authenticated human page. */
export function PrivateResourceReference(identity: Identity) {
  const { user, sessionCacheScope } = useAuth();
  if (!user || !sessionCacheScope) return null;
  return <PrivateResourceReferenceView key={`${sessionCacheScope}/${user.role}/${identity.registrationId}/${identity.resourceType}/${identity.projectionId}`} {...identity} />;
}

function PrivateResourceReferenceView({ registrationId, resourceType, projectionId }: Identity) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const generation = useRef(0);
  useLayoutEffect(() => {
    let disposed = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { generation.current += 1; setResult(null); setBusy(false); };
    const load = async () => {
      const request = ++generation.current;
      const requestSession = api.getAccessToken();
      setResult(null); setError(null); setBusy(true);
      try {
        const response = await api.get(`/api/app-resource-private/references/${encodeURIComponent(registrationId)}/${encodeURIComponent(resourceType)}/${encodeURIComponent(projectionId)}`);
        if (!response.ok) throw new Error(await appApiError(response, 'This private resource is unavailable.'));
        const current = normalizeResult(await response.json());
        const deadline = Date.parse(current.consent_expires_at);
        if (current.ref.provider.provider_instance_id !== registrationId.toLowerCase()
          || current.ref.resource_type !== resourceType || current.ref.resource_id !== projectionId.toLowerCase()) {
          throw new Error('This private resource is unavailable.');
        }
        if (disposed || request !== generation.current || document.hidden || !isSameWebSession(requestSession, localStorage.getItem('deft-access-token'))) return;
        if (deadline <= Date.now()) throw new Error('Private resource consent expired.');
        setResult(current);
        clearTimeout(expiry);
        expiry = setTimeout(() => { clear(); setError('Private resource consent expired.'); }, Math.min(deadline - Date.now(), 2_147_483_647));
      } catch (reason) {
        if (!disposed && request === generation.current) setError(reason instanceof Error ? reason.message : 'This private resource is unavailable.');
      } finally { if (!disposed && request === generation.current) setBusy(false); }
    };
    const visibility = () => { if (document.hidden) clear(); else void load(); };
    const pageHide = () => { clear(); };
    document.addEventListener('visibilitychange', visibility);
    addEventListener('pagehide', pageHide);
    if (!document.hidden) void load();
    else setBusy(false);
    return () => {
      disposed = true; generation.current += 1; clearTimeout(expiry);
      document.removeEventListener('visibilitychange', visibility); removeEventListener('pagehide', pageHide);
    };
  }, [registrationId, resourceType, projectionId]);
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
    <PageHeader title="Private App resource" />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6">
      {busy && <p role="status">Checking private access...</p>}
      {error && <p role="alert" className="break-words">{error}</p>}
      {result && <><h2 className="mb-2 break-words text-lg font-semibold [overflow-wrap:anywhere]">{result.label}</h2><p className="mb-4 text-sm">Owner-only saved provider data. Provider freshness is unknown.</p><Link className="mb-4 inline-flex min-h-11 items-center underline" href={result.search_href}>Search saved App data</Link>{APP_PRIVATE_SHARING_ENABLED && <Link className="mb-4 ml-4 inline-flex min-h-11 items-center underline" href={`/app-resources/share/${registrationId}/${resourceType}/${projectionId}`}>Review human sharing</Link>}<dl className="space-y-4">{Object.entries(result.data).map(([key, value]) => <div key={key}>
        <dt className="break-words text-sm font-semibold">{key}</dt>
        <dd className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{String(value)}</dd>
      </div>)}</dl></>}
    </div>
  </div>;
}
