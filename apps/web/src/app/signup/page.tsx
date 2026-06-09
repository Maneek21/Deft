'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { Logo } from '@/components/brand/logo';

export default function SignupPage() {
  const { signup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
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
          <Logo variant="wordmark" className="h-12 w-auto" priority />
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            Create your workspace
          </p>
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
                autoComplete="name"
                autoFocus
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
                autoComplete="email"
                inputMode="email"
                className="w-full h-11 px-4 text-[0.875rem] outline-none"
                style={isDisabled ? inputDisabledStyle : inputStyle}
                disabled={isDisabled}
                required />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[0.6875rem] font-semibold uppercase" style={labelStyle}>
                Password
              </label>
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => { setPassword(e.target.value); setPasswordError(''); }}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  className="w-full h-11 px-4 pr-10 text-[0.875rem] outline-none"
                  style={{
                    ...(isDisabled ? inputDisabledStyle : inputStyle),
                    ...(passwordError ? { borderColor: 'var(--error)' } : {}),
                  }}
                  disabled={isDisabled}
                  minLength={8}
                  required />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{ color: 'var(--on-surface-variant)' }}>
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
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
                autoComplete="organization"
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
