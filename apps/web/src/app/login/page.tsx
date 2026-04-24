'use client';

import { useState, useEffect, Suspense } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Handle OAuth callback tokens from URL
  useEffect(() => {
    const accessToken = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');
    const oauthError = searchParams.get('error');

    if (oauthError === 'single_org_limit') {
      setError(
        'This Deft instance already has a workspace. Ask your ' +
          'administrator for an invite — self-hosted Deft hosts a single ' +
          'workspace per deployment (see LICENSE).',
      );
      window.history.replaceState({}, '', '/login');
    } else if (oauthError) {
      setError('Google sign-in failed. Please try again.');
      window.history.replaceState({}, '', '/login');
    } else if (accessToken && refreshToken) {
      api.setTokens(accessToken, refreshToken);
      window.history.replaceState({}, '', '/login');
      router.push('/chat');
    }
  }, [searchParams, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
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
          {/* Deft stacked stones icon */}
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
              Sign in to your workspace
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
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="px-4 py-3 text-[0.8125rem] rounded-lg"
                style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label className="text-[0.6875rem] font-semibold uppercase"
                style={{ color: 'var(--on-surface-variant)', letterSpacing: '0.05em' }}>
                Email Address
              </label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
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
                <label className="text-[0.6875rem] font-semibold uppercase"
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
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
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

          {/* Divider */}
          <div className="flex items-center gap-4 py-2">
            <div className="h-px flex-1" style={{ background: 'var(--ghost-border)' }} />
            <span className="text-[0.625rem] font-semibold uppercase"
              style={{ color: 'var(--outline)', letterSpacing: '0.1em' }}>
              or continue with
            </span>
            <div className="h-px flex-1" style={{ background: 'var(--ghost-border)' }} />
          </div>

          {/* Google SSO */}
          <button type="button"
            onClick={() => { window.location.href = `${API_URL}/api/auth/google`; }}
            className="w-full h-11 text-[0.875rem] flex items-center justify-center gap-3 active:scale-[0.98]"
            style={{
              background: 'var(--surface-container-low)',
              color: 'var(--on-surface)',
              border: '1px solid var(--ghost-border)',
              borderRadius: '0.5rem',
              transition: 'all 150ms',
              cursor: 'pointer',
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
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="underline underline-offset-4"
            style={{ color: 'var(--primary)' }}>
            Sign up
          </Link>
        </p>
      </main>
    </div>
  );
}
