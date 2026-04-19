'use client';

import { useState } from 'react';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        let msg = 'Something went wrong';
        try { const data = await res.json(); msg = data.error || msg; } catch {}
        throw new Error(msg);
      }
      setSent(true);
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
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }} />

      <main className="w-full max-w-[400px] flex flex-col items-center gap-8">
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
              Reset your password
            </h1>
            <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
              Enter your email and we&apos;ll send you a reset link
            </p>
          </div>
        </div>

        <div className="w-full p-8 flex flex-col gap-6"
          style={{
            background: 'var(--surface-dim)',
            borderRadius: '0.75rem',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
            outline: '1px solid var(--ghost-border)',
          }}>

          {sent ? (
            <div className="flex flex-col gap-4 text-center">
              <div className="px-4 py-3 text-[0.8125rem] rounded-lg"
                style={{ background: 'rgba(0,120,80,0.2)', color: 'var(--primary)' }}>
                Check your email for a password reset link. It expires in 15 minutes.
              </div>
              <Link href="/login" className="text-[0.875rem] underline underline-offset-4"
                style={{ color: 'var(--primary)' }}>
                Back to sign in
              </Link>
            </div>
          ) : (
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
                  className="w-full h-11 px-4 text-[0.875rem] outline-none"
                  style={{
                    background: 'var(--surface-container-low)',
                    border: '1px solid var(--outline-variant)',
                    borderRadius: '0.5rem',
                    color: 'var(--on-surface)',
                  }}
                  required />
              </div>

              <button type="submit" disabled={loading}
                className="w-full h-11 font-semibold text-[0.875rem] mt-2 disabled:opacity-50 active:scale-[0.98]"
                style={{
                  background: 'var(--primary-container)',
                  color: '#FFFFFF',
                  borderRadius: '0.5rem',
                  border: 'none',
                }}>
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        <p className="text-[0.875rem]" style={{ color: 'var(--outline)' }}>
          Remember your password?{' '}
          <Link href="/login" className="underline underline-offset-4"
            style={{ color: 'var(--primary)' }}>
            Sign in
          </Link>
        </p>
      </main>
    </div>
  );
}
