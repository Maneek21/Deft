'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { clearEnrolToken, twoStepApi } from '@/lib/two-step';

const inputStyle = {
  background: 'var(--surface-container)',
  border: '1px solid var(--outline-variant)',
  borderRadius: '0.5rem',
  color: 'var(--foreground)',
} as const;
const primaryButton = {
  background: 'var(--primary-container)',
  color: '#FFFFFF',
  borderRadius: '0.5rem',
  border: 'none',
} as const;
const mutedText = { color: 'var(--on-surface-variant)' } as const;

/** Recovery codes, shown once, with the "I have saved these" confirmation. */
export function RecoveryCodesOnce({ codes, onSaved, doneLabel = 'Continue' }: { codes: string[]; onSaved: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[1rem] font-semibold" style={{ color: 'var(--foreground)' }}>Save your recovery codes</h2>
      <p className="text-[0.8125rem]" style={mutedText}>
        Each code signs you in once if you do not have your authenticator. They are shown only now.
        If you lose both your authenticator and these codes, there is no way back into this account.
      </p>
      <pre className="p-4 text-[0.875rem] leading-6 select-all overflow-x-auto" data-testid="two-step-recovery-codes"
        style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}>{codes.join('\n')}</pre>
      <button type="button" onClick={copy} className="self-start text-[0.8125rem] underline underline-offset-4" style={{ color: 'var(--primary)' }}>
        {copied ? 'Copied' : 'Copy codes'}
      </button>
      <label className="flex items-start gap-2 text-[0.875rem]" style={{ color: 'var(--foreground)' }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1" />
        I have saved these
      </label>
      <button type="button" disabled={!saved} onClick={onSaved} className="w-full h-11 font-semibold text-[0.875rem] disabled:opacity-50" style={primaryButton}>
        {doneLabel}
      </button>
    </div>
  );
}

type Props = {
  /** The enrol-only token from sign-in; omit to enrol with the current session. */
  enrolToken?: string | null;
  /** The person already has two-step verification and is replacing the authenticator. */
  replacing?: boolean;
  onFinished: () => void;
  doneLabel?: string;
};

/**
 * Sets up two-step verification: shows the secret as text and as an
 * otpauth:// link, checks one code, then shows the recovery codes once.
 */
export function TwoStepEnrolment({ enrolToken = null, replacing = false, onFinished, doneLabel }: Props) {
  const [step, setStep] = useState<'intro' | 'secret' | 'codes'>('intro');
  const { sessionTicket, adoptSession } = useAuth();
  // Taken when setup begins: a sign-out or a sign-in as someone else in any
  // tab after this point means the session setup hands back is not installed.
  const [ticket] = useState(sessionTicket);
  const [proof, setProof] = useState('');
  // Signed in normally and turning it on for the first time: the server asks
  // for the password, so a stolen session alone cannot add an authenticator.
  const needsPassword = !enrolToken && !replacing;
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      const typed = proof.trim();
      const body = needsPassword ? { current_password: password }
        : !replacing ? {} : /^\d{6}$/.test(typed.replace(/\s/g, '')) ? { code: typed } : { recovery_code: typed };
      const started = await twoStepApi.startEnrolment(body, enrolToken);
      setSecret(started.secret);
      setOtpauthUrl(started.otpauth_url);
      setStep('secret');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const confirmed = await twoStepApi.confirmEnrolment(code.trim(), enrolToken);
      // A signed-in person keeps their session. Someone finishing setup with
      // the enrol-only token gets a new one, installed only if nobody signed
      // out or in meanwhile. The recovery codes are shown either way.
      // An enrol-only setup is for someone who is not signed in: if anyone was
      // (another tab, a reload after signing in), their session is kept.
      if (confirmed.accessToken && confirmed.refreshToken && ticket.identity === null) {
        adoptSession(ticket, confirmed.accessToken, confirmed.refreshToken);
      }
      clearEnrolToken();
      setSecret('');
      setOtpauthUrl('');
      setRecoveryCodes(confirmed.recovery_codes);
      setStep('codes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'codes') return <RecoveryCodesOnce codes={recoveryCodes} onSaved={onFinished} doneLabel={doneLabel} />;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="px-4 py-3 text-[0.8125rem] rounded-lg" role="alert" style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>
          {error}
        </div>
      )}
      {step === 'intro' && (
        <>
          <p className="text-[0.875rem]" style={mutedText}>
            Two-step verification asks for a 6-digit code from an authenticator app each time you sign in.
            You will also get recovery codes. If you lose both your authenticator and your recovery codes,
            there is no way back into this account: nobody, including Deft, can restore access.
          </p>
          {needsPassword && (
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Current password"
              autoComplete="current-password" aria-label="Current password"
              className="w-full h-11 px-4 text-[0.875rem] outline-none" style={inputStyle} />
          )}
          {replacing && (
            <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Current code or a recovery code"
              autoComplete="one-time-code" aria-label="Current code or a recovery code"
              className="w-full h-11 px-4 text-[0.875rem] outline-none" style={inputStyle} />
          )}
          <button type="button" onClick={start} disabled={busy || (replacing && !proof.trim()) || (needsPassword && !password)}
            className="w-full h-11 font-semibold text-[0.875rem] disabled:opacity-50 inline-flex items-center justify-center gap-2" style={primaryButton}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            {replacing ? 'Replace authenticator' : 'Set up two-step verification'}
          </button>
        </>
      )}
      {step === 'secret' && (
        <form onSubmit={confirm} className="flex flex-col gap-4">
          <p className="text-[0.875rem]" style={mutedText}>
            Add this key to your authenticator app (time-based, 6 digits), then enter the code it shows.
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-[0.6875rem] font-semibold uppercase" style={{ ...mutedText, letterSpacing: '0.05em' }}>Setup key</span>
            <code className="p-3 text-[0.875rem] break-all select-all" data-testid="two-step-secret"
              style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}>{secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            <a href={otpauthUrl} className="text-[0.8125rem] underline underline-offset-4 break-all" style={{ color: 'var(--primary)' }}>
              Open in an authenticator app on this device
            </a>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="two-step-enrol-code" className="text-[0.6875rem] font-semibold uppercase" style={{ ...mutedText, letterSpacing: '0.05em' }}>
              Code from the app
            </label>
            <input id="two-step-enrol-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456"
              inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus required
              className="w-full h-11 px-4 text-[0.875rem] outline-none" style={inputStyle} />
          </div>
          <button type="submit" disabled={busy || code.trim().length < 6}
            className="w-full h-11 font-semibold text-[0.875rem] disabled:opacity-50 inline-flex items-center justify-center gap-2" style={primaryButton}>
            {busy && <Loader2 size={15} className="animate-spin" />}
            Turn on two-step verification
          </button>
        </form>
      )}
    </div>
  );
}
