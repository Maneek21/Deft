'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { TwoStepEnrolment } from '@/components/two-step-enrolment';
import { safePostLoginDestination } from '@/lib/auth-context';
import { takeEnrolToken } from '@/lib/two-step';

/**
 * Where an owner or admin who must have two-step verification lands after
 * their password: the enrol-only token from sign-in can do nothing else.
 */
export default function TwoStepSetupPage() {
  const [enrolToken, setEnrolToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setEnrolToken(takeEnrolToken());
  }, []);

  const finish = () => {
    const destination = safePostLoginDestination(sessionStorage.getItem('deft-redirect-after-login'));
    sessionStorage.removeItem('deft-redirect-after-login');
    // A full load, so the app starts on the session issued by enrolment.
    window.location.assign(destination ?? '/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--surface-lowest)' }}>
      <main className="w-full max-w-[440px] flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo variant="wordmark" className="h-12 w-auto" priority />
          <h1 className="text-[1.125rem] font-semibold" style={{ color: 'var(--foreground)' }}>Set up two-step verification</h1>
          <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
            Owners and admins of this workspace need it before they can sign in.
          </p>
        </div>
        <div className="w-full p-8 flex flex-col gap-6"
          style={{ background: 'var(--surface-dim)', borderRadius: '0.75rem', outline: '1px solid var(--ghost-border)' }}>
          {enrolToken === undefined ? null : enrolToken ? (
            <TwoStepEnrolment enrolToken={enrolToken} onFinished={finish} />
          ) : (
            <p className="text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
              This page opens after you sign in.{' '}
              <Link href="/login" className="underline underline-offset-4" style={{ color: 'var(--primary)' }}>Sign in</Link>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
