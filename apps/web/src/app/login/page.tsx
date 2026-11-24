'use client';

import { useEffect, useState, Suspense } from 'react';
import { dropUnbackedOAuthMarker } from '@/lib/oauth-popup-marker';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { TwoStepError, type TwoStepPending } from '@/lib/two-step';


export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const { login, verifyTwoStep } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Set once the password is accepted and the account needs its code.
  const [pending, setPending] = useState<TwoStepPending | null>(null);
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  // `from=oauth` (a page without COOP) only while this tab returns to /oauth/authorize.
  useEffect(() => { dropUnbackedOAuthMarker(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const next = await login(email, password);
      if (next) {
        setPassword('');
        setCode('');
        setUseRecoveryCode(false);
        setPending(next);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending) return;
    setError('');
    setLoading(true);
    try {
      await verifyTwoStep(pending.token, useRecoveryCode ? { recovery_code: code.trim() } : { code: code.trim() });
    } catch (err: any) {
      setError(err.message);
      setCode('');
      // The challenge is used up or dead: start again from the password.
      if (err instanceof TwoStepError && (err.code === 'TWO_STEP_CHALLENGE_DEAD' || err.code === 'TWO_STEP_CHALLENGE_INVALID')) {
        setPending(null);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'var(--surface-lowest)' }}
    >
      {/* Decorative backdrop gradients — soft atmospheric light */}
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }} />
      <div className="fixed bottom-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(140px)', opacity: 0.2 }} />

      <main className="w-full max-w-[400px] flex flex-col items-center gap-8">
        {/* Brand identity */}
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo variant="wordmark" className="h-12 w-auto" priority />
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            Sign in to your workspace
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
          {pending && (
            <form onSubmit={handleCode} className="flex flex-col gap-4">
              {error && (
                <div className="px-4 py-3 text-[0.8125rem] rounded-lg" role="alert"
                  style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>
                  {error}
                </div>
              )}
              <div className="flex flex-col gap-2">
                <label htmlFor="login-two-step-code" className="text-[0.6875rem] font-semibold uppercase"
                  style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>
                  {useRecoveryCode ? 'Recovery code' : 'Code from your authenticator app'}
                </label>
                <input id="login-two-step-code" value={code} onChange={e => setCode(e.target.value)}
                  placeholder={useRecoveryCode ? 'XXXX-XXXX-XXXX-XXXX' : '123456'}
                  inputMode={useRecoveryCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  autoFocus
                  className="w-full h-11 px-4 text-[0.875rem] outline-none"
                  style={{
                    background: 'var(--surface-container)',
                    border: '1px solid var(--outline-variant)',
                    borderRadius: '0.5rem',
                    color: 'var(--foreground)',
                  }}
                  required />
                {useRecoveryCode && (
                  <p className="text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>
                    A recovery code works once, and using one signs you out everywhere else.
                    You will then set up a new authenticator before you can continue.
                  </p>
                )}
              </div>
              <button type="submit" disabled={loading || code.trim().length < 6}
                className="w-full h-11 font-semibold text-[0.875rem] mt-2 disabled:opacity-50 active:scale-[0.98]"
                style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem', border: 'none' }}>
                {loading ? 'Checking...' : 'Continue'}
              </button>
              <button type="button" onClick={() => { setUseRecoveryCode(v => !v); setCode(''); setError(''); }}
                className="min-h-[44px] text-[0.8125rem] underline underline-offset-4" style={{ color: 'var(--primary)' }}>
                {useRecoveryCode ? 'Use a code from your authenticator app' : 'Use a recovery code instead'}
              </button>
              <button type="button" onClick={() => { setPending(null); setCode(''); setError(''); }}
                className="min-h-[44px] text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
                Back to sign in
              </button>
            </form>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" hidden={pending !== null}>
            {error && (
              <div className="px-4 py-3 text-[0.8125rem] rounded-lg"
                style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label htmlFor="login-email" className="text-[0.6875rem] font-semibold uppercase"
                style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>
                Email Address
              </label>
              <input id="login-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="name@company.com"
                autoComplete="email"
                inputMode="email"
                autoFocus
                className="w-full h-11 px-4 text-[0.875rem] outline-none"
                style={{
                  background: 'var(--surface-container)',
                  border: '1px solid var(--outline-variant)',
                  borderRadius: '0.5rem',
                  color: 'var(--foreground)',
                }}
                required />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <label htmlFor="login-password" className="text-[0.6875rem] font-semibold uppercase"
                  style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>
                  Password
                </label>
                <Link href="/forgot-password"
                  className="inline-flex items-center min-h-[44px] px-2 -mx-2 text-[0.75rem]"
                  style={{ color: 'var(--primary)' }}>
                  Forgot?
                </Link>
              </div>
              <div className="relative">
                <input id="login-password" type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full h-11 px-4 pr-10 text-[0.875rem] outline-none"
                  style={{
                    background: 'var(--surface-container)',
                    border: '1px solid var(--outline-variant)',
                    borderRadius: '0.5rem',
                    color: 'var(--foreground)',
                  }}
                  required />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center"
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{ color: 'var(--on-surface-variant)' }}>
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full h-11 font-semibold text-[0.875rem] mt-2 disabled:opacity-50 active:scale-[0.98]"
              style={{
                background: 'var(--primary-container)',
                color: '#FFFFFF',
                borderRadius: '0.5rem',
                border: 'none',
              }}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

        </div>

        {/* Footer */}
        <div className="flex flex-col items-center gap-2 text-[0.875rem]" style={{ color: 'var(--outline)' }}>
          <p>
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="underline underline-offset-4"
              style={{ color: 'var(--primary)' }}>
              Sign up
            </Link>
          </p>
          <Link href="/license" className="text-[0.75rem] underline underline-offset-4">License &amp; source</Link>
        </div>
      </main>
    </div>
  );
}
