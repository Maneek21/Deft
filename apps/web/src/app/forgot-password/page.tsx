'use client';

import Link from 'next/link';
import { Logo } from '@/components/brand/logo';

export default function ForgotPasswordPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'var(--surface-lowest)' }}
    >
      <div className="fixed top-0 left-1/4 w-[500px] h-[500px] rounded-full pointer-events-none -z-10"
        style={{ background: 'var(--accent-muted)', filter: 'blur(120px)', opacity: 0.3 }} />

      <main className="w-full max-w-[420px] flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo variant="wordmark" className="h-12 w-auto" priority />
        </div>

        <div className="w-full p-8 flex flex-col gap-5"
          style={{
            background: 'var(--surface-dim)',
            borderRadius: '0.75rem',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
            outline: '1px solid var(--ghost-border)',
          }}>

          <h1 className="text-[1.25rem] font-semibold leading-tight" style={{ color: 'var(--on-surface)' }}>
            Ask your admin for a recovery link
          </h1>

          <p className="text-[0.875rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
            Self-hosted Deft doesn't send password emails. To reset your password, ask any owner or admin in your workspace to open <strong style={{ color: 'var(--on-surface)' }}>Settings → Members</strong>, click the key icon next to your name, and share the recovery link they generate.
          </p>

          <p className="text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
            Recovery links expire after 24 hours and work once. You'll be asked to set a new password before signing in.
          </p>

          <Link
            href="/login"
            className="w-full h-11 font-semibold text-[0.875rem] mt-2 active:scale-[0.98] flex items-center justify-center"
            style={{ background: 'var(--primary-container)', color: '#FFFFFF', borderRadius: '0.5rem' }}
          >
            Back to sign in
          </Link>
        </div>
      </main>
    </div>
  );
}
