'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Logo } from '@/components/brand/logo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

type Preview = {
  org_name: string;
  org_slug: string;
  inviter_name: string;
  email: string;
  role: 'admin' | 'member' | 'guest';
  already_accepted: boolean;
  expires_at: string | null;
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'invalid' }
  | { status: 'ok'; preview: Preview };

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const { refreshUser } = useAuth();

  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/invites/preview/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          if (data?.code === 'INVITE_EXPIRED') setPreviewState({ status: 'expired' });
          else setPreviewState({ status: 'invalid' });
          return;
        }
        setPreviewState({ status: 'ok', preview: data });
        if (data?.email && !name) setName(data.email.split('@')[0] ?? '');
      })
      .catch(() => {
        if (!cancelled) setPreviewState({ status: 'invalid' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/invites/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error === 'expired' ? 'This invite link has expired. Ask your admin for a new one.' : 'This invite link is invalid or was revoked.');
        setSubmitting(false);
        return;
      }
      api.setTokens(data.accessToken, data.refreshToken);
      await refreshUser();
      router.push('/welcome');
    } catch {
      setError('Could not reach the server. Try again in a moment.');
      setSubmitting(false);
    }
  };

  const inputStyle = {
    background: 'var(--surface-container-low)',
    border: '1px solid var(--outline-variant)',
    borderRadius: '0.5rem',
    color: 'var(--on-surface)',
  };

  const labelStyle = {
    color: 'var(--on-surface-variant)',
    letterSpacing: '0.05em',
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'var(--surface-lowest)' }}
    >
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }} />
      <div className="fixed bottom-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(140px)', opacity: 0.2 }} />

      <main className="w-full max-w-[420px] flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo variant="wordmark" className="h-12 w-auto" priority />
        </div>

        <div className="w-full p-8 flex flex-col gap-6"
          style={{
            background: 'var(--surface-dim)',
            borderRadius: '0.75rem',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
            outline: '1px solid var(--ghost-border)',
          }}>

          {previewState.status === 'loading' && (
            <p className="text-center text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
              Checking your invite…
            </p>
          )}

          {previewState.status === 'expired' && (
            <div className="flex flex-col gap-3">
              <h1 className="text-[1.25rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Invite expired</h1>
              <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                This invitation link has expired. Ask the admin who invited you to generate a new link from <strong>Settings → Members</strong>.
              </p>
            </div>
          )}

          {previewState.status === 'invalid' && (
            <div className="flex flex-col gap-3">
              <h1 className="text-[1.25rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Invite not valid</h1>
              <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                This link couldn't be verified. It may have been revoked, or the URL was copied incorrectly. Ask the admin who invited you for a fresh link.
              </p>
            </div>
          )}

          {previewState.status === 'ok' && previewState.preview.already_accepted && (
            <div className="flex flex-col gap-3">
              <h1 className="text-[1.25rem] font-semibold" style={{ color: 'var(--on-surface)' }}>You've already joined</h1>
              <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                This invite was already accepted. Sign in below with the password you set.
              </p>
              <button
                onClick={() => router.push('/login')}
                className="w-full h-11 font-semibold text-[0.875rem] mt-2 active:scale-[0.98]"
                style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem', border: 'none' }}
              >
                Go to sign-in
              </button>
            </div>
          )}

          {previewState.status === 'ok' && !previewState.preview.already_accepted && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <h1 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>
                  Join {previewState.preview.org_name}
                </h1>
                <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                  <strong style={{ color: 'var(--on-surface)' }}>{previewState.preview.inviter_name}</strong> invited{' '}
                  <span style={{ color: 'var(--on-surface)' }}>{previewState.preview.email}</span> to the workspace as{' '}
                  <span style={{ color: 'var(--on-surface)' }}>{previewState.preview.role}</span>.
                </p>
              </div>

              {error && (
                <div className="px-4 py-3 text-[0.8125rem] rounded-lg"
                  style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>
                  {error}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>Your name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                  autoComplete="name"
                  autoFocus
                  className="w-full h-11 px-4 text-[0.875rem] outline-none"
                  style={inputStyle}
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>Choose a password</label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    minLength={8}
                    className="w-full h-11 px-4 pr-10 text-[0.875rem] outline-none"
                    style={inputStyle}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    style={{ color: 'var(--on-surface-variant)' }}
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full h-11 font-semibold text-[0.875rem] mt-2 disabled:opacity-50 active:scale-[0.98]"
                style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem', border: 'none', cursor: submitting ? 'not-allowed' : 'pointer' }}
              >
                {submitting ? 'Joining…' : `Join ${previewState.preview.org_name}`}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
