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
      setPreview(await res.json());
    })().catch((err) => {
      if (!cancelled) setError((err as Error).message);
    });
    return () => { cancelled = true; };
  }, [authorizeParams, user]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/oauth/authorize', authorizeParams);
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

  const canWriteTasks = preview?.scopes.includes('write:tasks') ?? false;
  const canWriteMessages = preview?.scopes.includes('write:messages') ?? false;
  const hasWriteAccess = canWriteTasks || canWriteMessages;
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
              <h2 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>This app can read</h2>
              <ul className="mt-3 space-y-2 text-[14px]" style={{ color: 'var(--text-primary)' }}>
                <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Company wiki and memory</li>
                <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Tasks and project context you can access</li>
                <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Messages in spaces you can access</li>
                <li className="flex gap-2"><Check size={16} style={{ color: 'var(--accent)' }} /> Calendar context available to your workspace</li>
              </ul>
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
                    <li className="flex gap-2"><X size={16} style={{ color: 'var(--danger)' }} /> Edit wiki pages</li>
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
              {preview.scopes.map((scope) => (
                <span key={scope} className="rounded-md px-2 py-1 text-[11px]" style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                  {scope}
                </span>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button type="button" onClick={deny} className="h-11 rounded-md text-[14px] font-medium" style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={approve} className="h-11 rounded-md text-[14px] font-medium text-white disabled:opacity-60 inline-flex items-center justify-center gap-2" style={{ background: 'var(--accent)' }}>
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
