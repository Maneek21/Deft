'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/brand/logo';

type Preview = {
  client: {
    client_id: string;
    client_name: string;
    client_uri: string | null;
    logo_uri: string | null;
  };
  resource: string;
  scopes: string[];
  profile: string;
};

const SCOPE_LABELS: Record<string, string> = {
  'read:workspace': 'Workspace map, people, projects, receipts, and activity',
  'read:wiki': 'Company, channel, and personal knowledge',
  'read:tasks': 'Tasks, comments, progress, and workload',
  'read:messages': 'Visible spaces, threads, unread work, and search',
  'read:calendar': 'Native and subscribed calendar context',
  'write:tasks': 'Create, update, transition, and comment on tasks',
  'write:messages': 'Post messages into spaces and DMs you can access',
  'write:wiki': 'Create and update wiki knowledge',
  'write:calendar': 'Create, update, and cancel native calendar events',
  'write:workspace': 'Manage notes, inbox, approvals, projects, and agent operations',
  offline_access: 'Keep this connector signed in by allowing secure refresh-token rotation',
};

export default function OAuthAuthorizePage() {
  return (
    <Suspense>
      <OAuthAuthorizeContent />
    </Suspense>
  );
}

function OAuthAuthorizeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authorizeParams = useMemo(() => {
    const params: Record<string, string> = {};
    for (const key of ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']) {
      const value = searchParams.get(key);
      if (value) params[key] = value;
    }
    return params;
  }, [searchParams]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      sessionStorage.setItem('deft-redirect-after-login', `${window.location.pathname}${window.location.search}`);
      router.replace('/login');
    }
  }, [loading, router, user]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setError(null);
      const query = new URLSearchParams(authorizeParams).toString();
      const res = await api.get(`/api/oauth/authorize/preview?${query}`);
      if (cancelled) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error_description ?? body.error ?? `Authorization preview failed: ${res.status}`);
        return;
      }
      const nextPreview = await res.json() as Preview;
      setPreview(nextPreview);
      setSelectedScopes(nextPreview.scopes);
    })().catch((err) => {
      if (!cancelled) setError((err as Error).message);
    });
    return () => { cancelled = true; };
  }, [authorizeParams, user]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/oauth/authorize', {
        ...authorizeParams,
        scope: selectedScopes.join(' '),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error_description ?? body.error ?? `Authorization failed: ${res.status}`);
      }
      const body = await res.json();
      if (!body.redirect_to) throw new Error('Authorization did not return a redirect');
      window.location.href = body.redirect_to;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function deny() {
    const redirectUri = authorizeParams.redirect_uri;
    if (!redirectUri) {
      router.replace('/settings/mcp-access');
      return;
    }
    const url = new URL(redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The user denied Deft access');
    if (authorizeParams.state) url.searchParams.set('state', authorizeParams.state);
    window.location.href = url.toString();
  }

  function toggleScope(scope: string) {
    setSelectedScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  }

  const requestedReadScopes = preview?.scopes.filter((scope) => scope.startsWith('read:')) ?? [];
  const requestedWriteScopes = preview?.scopes.filter((scope) => scope.startsWith('write:')) ?? [];
  const requestedSessionScopes = preview?.scopes.filter((scope) => scope === 'offline_access') ?? [];
  const canWriteTasks = selectedScopes.includes('write:tasks');
  const canWriteMessages = selectedScopes.includes('write:messages');
  const canWriteWiki = selectedScopes.includes('write:wiki');
  const canWriteCalendar = selectedScopes.includes('write:calendar');
  const canWriteWorkspace = selectedScopes.includes('write:workspace');
  const hasResourceScope = selectedScopes.some((scope) => scope !== 'offline_access');
  const hasWriteAccess = canWriteTasks || canWriteMessages || canWriteWiki || canWriteCalendar || canWriteWorkspace;
  const accessLabel = hasWriteAccess ? 'Workspace helper access' : 'Knowledge access';

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: 'var(--surface-lowest)' }}>
      <div className="w-full max-w-[560px] rounded-xl p-6 md:p-8" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between gap-4">
          <Logo variant="wordmark" className="h-9 w-auto" priority />
          <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}>
            <ShieldCheck size={14} /> {accessLabel}
          </div>
        </div>

        <div className="mt-8">
          <h1 className="text-[24px] md:text-[28px] font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
            Connect Deft to {preview?.client.client_name ?? 'this AI app'}?
          </h1>
          <p className="mt-2 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
            {hasWriteAccess
              ? `This connector acts as ${user?.email ?? 'your Deft user'} and can read your accessible workspace context plus perform the approved write actions shown below.`
              : `This read-only connector acts as ${user?.email ?? 'your Deft user'} and can only see Deft data your account can access.`}
          </p>
        </div>

        {error && (
          <div className="mt-5 rounded-lg p-3 text-[13px]" style={{ color: 'var(--danger)', border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, transparent)' }}>
            {error}
          </div>
        )}

        {!preview && !error && (
          <div className="mt-8 flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 size={16} className="animate-spin" /> Checking connector request...
          </div>
        )}

        {preview && (
          <>
            <section className="mt-6 rounded-lg p-4" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Choose access</h2>
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>Turn off anything this connection does not need. You can revoke it later from Settings → Connections.</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setSelectedScopes([...requestedReadScopes, ...requestedSessionScopes])} className="rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>Read only</button>
                  <button type="button" onClick={() => setSelectedScopes(preview.scopes)} className="rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ color: 'white', background: 'var(--accent)' }}>Requested access</button>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Read</div>
                  <div className="mt-2 space-y-2">
                    {requestedReadScopes.map((scope) => (
                      <label key={scope} className="flex cursor-pointer items-start gap-2 rounded-md p-2.5" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                        <input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggleScope(scope)} className="mt-0.5" />
                        <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>{scope}</strong><br />{SCOPE_LABELS[scope] ?? scope}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Write</div>
                  {requestedWriteScopes.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {requestedWriteScopes.map((scope) => (
                        <label key={scope} className="flex cursor-pointer items-start gap-2 rounded-md p-2.5" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                          <input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggleScope(scope)} className="mt-0.5" />
                          <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>{scope}</strong><br />{SCOPE_LABELS[scope] ?? scope}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 rounded-md p-3 text-[11px]" style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>This app requested read-only access. No write permission will be granted.</p>
                  )}
                </div>
              </div>
              {requestedSessionScopes.map((scope) => (
                <label key={scope} className="mt-4 flex cursor-pointer items-start gap-2 rounded-md p-2.5" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                  <input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggleScope(scope)} className="mt-0.5" />
                  <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>Stay connected</strong><br />{SCOPE_LABELS[scope]}</span>
                </label>
              ))}
            </section>

            <section className="mt-3 rounded-lg p-4" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
              <h2 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                {hasWriteAccess ? 'This app can also' : 'This app cannot'}
              </h2>
              <ul className="mt-3 space-y-2 text-[14px]" style={{ color: 'var(--text-primary)' }}>
                {hasWriteAccess ? (
                  <>
                    {canWriteTasks ? (
                      <>
                        <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Create tasks in projects you can access</li>
                        <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Comment on visible tasks</li>
                        <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Update visible task fields, including status</li>
                      </>
                    ) : (
                      <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Create or update tasks</li>
                    )}
                    {canWriteMessages ? (
                      <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Post messages in spaces you can access</li>
                    ) : (
                      <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Post chat messages</li>
                    )}
                    {canWriteWiki ? (
                      <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Create and update wiki knowledge pages</li>
                    ) : (
                      <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Edit wiki pages</li>
                    )}
                    {canWriteCalendar && (
                      <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Manage your native Deft calendar events</li>
                    )}
                    {canWriteWorkspace && (
                      <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Manage notes, inbox, approvals, projects, and agent operations</li>
                    )}
                  </>
                ) : (
                  <>
                    <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Create or update tasks</li>
                    <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Post messages</li>
                    <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Edit wiki pages</li>
                    <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Access private spaces you are not part of</li>
                  </>
                )}
              </ul>
            </section>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {selectedScopes.map((scope) => (
                <span key={scope} className="rounded-md px-2 py-1 text-[11px]" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                  {scope}
                </span>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button type="button" onClick={deny} className="h-11 rounded-md text-[14px] font-medium" style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                Cancel
              </button>
              <button type="button" disabled={busy || !hasResourceScope} onClick={approve} className="h-11 rounded-md text-[14px] font-medium text-white disabled:opacity-60 inline-flex items-center justify-center gap-2" style={{ background: 'var(--accent)' }}>
                {busy && <Loader2 size={16} className="animate-spin" />}
                Allow access
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
