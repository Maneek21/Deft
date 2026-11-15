'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { RecoveryCodesOnce, TwoStepEnrolment } from '@/components/two-step-enrolment';
import { twoStepApi, type TwoStepStatus } from '@/lib/two-step';

const fieldStyle = { background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' } as const;
const buttonClass = 'inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium disabled:opacity-50';

/** Settings -> Profile -> Security: two-step verification and recovery codes. */
export function TwoStepSettings() {
  const [status, setStatus] = useState<TwoStepStatus | null>(null);
  const [mode, setMode] = useState<'idle' | 'enrol' | 'replace'>('idle');
  const [code, setCode] = useState('');
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'codes' | 'off' | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await twoStepApi.status());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load two-step verification.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const withCode = async (action: 'codes' | 'off') => {
    setError('');
    setMessage('');
    setBusy(action);
    try {
      if (action === 'codes') {
        setFreshCodes((await twoStepApi.regenerateRecoveryCodes(code.trim())).recovery_codes);
      } else {
        await twoStepApi.disable(code.trim());
        setMessage('Two-step verification is off.');
      }
      setCode('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  // Enrolment ends every earlier session and continues on a new one, so
  // reload to start the app on it.
  const afterEnrolment = () => window.location.reload();

  return (
    <div className="mt-5 rounded-xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}>
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
        <ShieldCheck size={16} />
        Two-step verification
      </h2>
      {!status && !error && <Loader2 size={15} className="animate-spin" />}
      {error && <div className="mb-3 text-[12px]" role="alert" style={{ color: 'var(--status-red)' }}>{error}</div>}
      {message && <div className="mb-3 text-[12px]" style={{ color: 'var(--status-green)' }}>{message}</div>}

      {freshCodes && (
        <RecoveryCodesOnce codes={freshCodes} onSaved={() => setFreshCodes(null)} doneLabel="Done" />
      )}

      {status && !freshCodes && mode !== 'idle' && (
        <TwoStepEnrolment replacing={mode === 'replace'} onFinished={afterEnrolment} doneLabel="Done" />
      )}

      {status && !freshCodes && mode === 'idle' && !status.enabled && (
        <div className="space-y-3">
          <p className="text-[13px]" style={{ color: 'var(--muted-foreground, var(--on-surface-variant))' }}>
            Off. When it is on, signing in needs your password and a 6-digit code from an authenticator app.
          </p>
          <button type="button" onClick={() => setMode('enrol')} className={buttonClass} style={fieldStyle}>
            Set up two-step verification
          </button>
        </div>
      )}

      {status && !freshCodes && mode === 'idle' && status.enabled && (
        <div className="space-y-3">
          <p className="text-[13px]" style={{ color: 'var(--muted-foreground, var(--on-surface-variant))' }}>
            On{status.confirmed_at ? ` since ${new Date(status.confirmed_at).toLocaleDateString()}` : ''}.{' '}
            {status.recovery_codes_remaining} recovery {status.recovery_codes_remaining === 1 ? 'code' : 'codes'} left.
            {status.required ? ' Owners and admins of this workspace must keep it on.' : ''}
          </p>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Current 6-digit code"
            inputMode="numeric" autoComplete="one-time-code" maxLength={7} aria-label="Current 6-digit code"
            className="w-full rounded-lg px-3 py-2 text-[14px] outline-none" style={fieldStyle} />
          <button type="button" onClick={() => withCode('codes')} disabled={busy !== null || code.trim().length < 6} className={buttonClass} style={fieldStyle}>
            {busy === 'codes' && <Loader2 size={13} className="animate-spin" />}
            Make new recovery codes
          </button>
          <button type="button" onClick={() => setMode('replace')} className={buttonClass} style={fieldStyle}>
            Replace authenticator
          </button>
          {status.can_disable && (
            <button type="button" onClick={() => withCode('off')} disabled={busy !== null || code.trim().length < 6} className={buttonClass} style={fieldStyle}>
              {busy === 'off' && <Loader2 size={13} className="animate-spin" />}
              Turn off two-step verification
            </button>
          )}
        </div>
      )}
    </div>
  );
}
