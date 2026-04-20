'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';

export default function SignupPage() {
  const { signup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [passwordError, setPasswordError] = useState('');

  // Pre-check: does a workspace already exist?
  const [workspaceCheck, setWorkspaceCheck] = useState<'loading' | 'exists' | 'free'>('loading');

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    fetch(`${apiUrl}/api/auth/has-workspace`)
      .then(r => r.json())
      .then((data: { hasWorkspace: boolean }) => {
        setWorkspaceCheck(data.hasWorkspace ? 'exists' : 'free');
      })
      .catch(() => {
        // On fetch error, fall through to free — the POST will catch it anyway
        setWorkspaceCheck('free');
      });
  }, []);

  const isDisabled = loading || workspaceCheck === 'loading' || workspaceCheck === 'exists';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPasswordError('');
    if (password.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      await signup(name, email, password, orgName);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    background: 'var(--surface-container-low)',
    border: '1px solid var(--outline-variant)',
    borderRadius: '0.5rem',
    color: 'var(--on-surface)',
  };

  const inputDisabledStyle = {
    ...inputStyle,
    opacity: 0.45,
    cursor: 'not-allowed',
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
      {/* Decorative backdrop gradients */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }} />
      <div className="fixed bottom-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(140px)', opacity: 0.2 }} />

      <main className="w-full max-w-[400px] flex flex-col items-center gap-8">
        {/* Brand identity */}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 flex items-center justify-center rounded-xl"
            style={{ background: 'var(--surface-container-low)' }}>
            <div className="flex flex-col items-center">
              <div className="w-4 h-2 rounded-full" style={{ background: 'var(--primary)', opacity: 0.6 }} />
              <div className="w-6 h-2 rounded-full -mt-0.5" style={{ background: 'var(--primary)', opacity: 0.8 }} />
              <div className="w-8 h-2.5 rounded-full -mt-0.5" style={{ background: 'var(--primary-container)' }} />
            </div>
          </div>
          <div className="space-y-1">
            <h1 className="text-[1.25rem] font-semibold" style={{ color: 'var(--on-surface)', letterSpacing: '-0.01em' }}>
              Deft AI
            </h1>
            <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
              Create your workspace
            </p>
          </div>
        </div>

        {/* Auth card */}
        <div className="w-full p-8 flex flex-col gap-6"
          style={{
            background: 'var(--surface-dim)',
            borderRadius: '0.75rem',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
            outline: '1px solid var(--ghost-border)',
          }}>

          {/* Workspace-exists banner */}
          {workspaceCheck === 'exists' && (
            <div className="px-4 py-3 text-[0.8125rem] rounded-lg leading-relaxed"
              style={{ background: 'rgba(80,80,120,0.25)', color: 'var(--on-surface-variant)', border: '1px solid var(--ghost-border)' }}>
              <strong style={{ color: 'var(--on-surface)' }}>This Deft workspace is already set up.</strong>
              {' '}Ask your administrator for an invite — self-hosted Deft hosts a single workspace per deployment.
              {' '}See LICENSE for the BSL 1.1 terms that make this a hard rule rather than a configuration knob.
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="px-4 py-3 text-[0.8125rem] rounded-lg"
                style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>
                Your Name
              </label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Full name"
                className="w-full h-11 px-4 text-[0.875rem] outline-none"
                style={isDisabled ? inputDisabledStyle : inputStyle}
                disabled={isDisabled}
                required />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>
                Email Address
              </label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full h-11 px-4 text-[0.875rem] outline-none"
                style={isDisabled ? inputDisabledStyle : inputStyle}
                disabled={isDisabled}
                required />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>
                Password
              </label>
              <input type="password" value={password} onChange={e => { setPassword(e.target.value); setPasswordError(''); }}
                placeholder="••••••••"
                className="w-full h-11 px-4 text-[0.875rem] outline-none"
                style={{
                  ...(isDisabled ? inputDisabledStyle : inputStyle),
                  ...(passwordError ? { borderColor: 'var(--error)' } : {}),
                }}
                disabled={isDisabled}
                minLength={8}
                required />
              {passwordError && (
                <span className="text-[0.75rem]" style={{ color: 'var(--error)' }}>{passwordError}</span>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>
                Workspace Name
              </label>
              <input type="text" value={orgName} onChange={e => setOrgName(e.target.value)}
                placeholder="Your team or company"
                className="w-full h-11 px-4 text-[0.875rem] outline-none"
                style={isDisabled ? inputDisabledStyle : inputStyle}
                disabled={isDisabled}
                required />
            </div>

            <button type="submit" disabled={isDisabled}
              className="w-full h-11 font-semibold text-[0.875rem] mt-2 disabled:opacity-50 active:scale-[0.98]"
              style={{
                background: 'var(--primary-container)',
                color: '#FFFFFF',
                borderRadius: '0.5rem',
                border: 'none',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
              }}>
              {workspaceCheck === 'loading' ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Checking...
                </span>
              ) : workspaceCheck === 'exists' ? (
                'Workspace already exists'
              ) : loading ? (
                'Creating workspace...'
              ) : (
                'Create workspace'
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-4 py-2">
            <div className="h-px flex-1" style={{ background: 'var(--ghost-border)' }} />
            <span className="text-[0.625rem] font-semibold uppercase"
              style={{ color: 'rgba(201,196,213,0.4)', letterSpacing: '0.1em' }}>
              or continue with
            </span>
            <div className="h-px flex-1" style={{ background: 'var(--ghost-border)' }} />
          </div>

          {/* Google SSO */}
          <button type="button"
            disabled={workspaceCheck === 'exists'}
            onClick={() => {
              if (workspaceCheck === 'exists') return;
              window.location.href = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/auth/google`;
            }}
            className="w-full h-11 text-[0.875rem] flex items-center justify-center gap-3 active:scale-[0.98] disabled:opacity-40"
            style={{
              background: 'var(--surface-container-low)',
              color: 'var(--on-surface)',
              border: '1px solid var(--ghost-border)',
              borderRadius: '0.5rem',
              transition: 'all 150ms',
              cursor: workspaceCheck === 'exists' ? 'not-allowed' : 'pointer',
            }}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </div>

        {/* Footer */}
        <p className="text-[0.875rem]" style={{ color: 'var(--outline)' }}>
          Already have an account?{' '}
          <Link href="/login" className="underline underline-offset-4"
            style={{ color: 'var(--primary)', textDecorationColor: 'rgba(200,191,255,0.4)' }}>
            Sign in
          </Link>
        </p>
      </main>
    </div>
  );
}
