'use client';

/**
 * Help from the user menu (telemetry contract, section 2).
 *
 * - Hosted: "Report a problem" — the person's text, a category and "Email me
 *   about this report", sent through this workspace's own server to the Deft
 *   team. The person sees a short reference.
 * - Self-hosted with DEFT_SUPPORT_EMAIL set: "Get help" shows that address.
 * - Otherwise there is no help item.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { AppDialog } from './overlay-primitives';
import { api } from '@/lib/api';
import { currentPageTemplate, recentErrorReferences } from '@/lib/error-telemetry';

export type SupportConfig = { report: boolean; contact_email: string | null };

/** What the help item offers here; null until known, or for no one signed in. */
export function useSupportConfig(enabled: boolean): SupportConfig | null {
  const [config, setConfig] = useState<SupportConfig | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.get('/api/support/config')
      .then(async (res) => {
        if (!res.ok) return;
        const body = await res.json() as Partial<SupportConfig>;
        if (live) setConfig({ report: body.report === true, contact_email: typeof body.contact_email === 'string' ? body.contact_email : null });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [enabled]);
  return config;
}

const TEXT_MAX = 4000;
const CATEGORIES = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'confusing', label: 'Something is confusing' },
  { value: 'other', label: 'Something else' },
] as const;
type Category = (typeof CATEGORIES)[number]['value'];

type SendState =
  | { kind: 'editing'; error?: string }
  | { kind: 'sending' }
  | { kind: 'sent'; reference: string; emailMe: boolean };

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="Close" onClick={onClose}
      className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
      <X size={16} strokeWidth={1.5} />
    </button>
  );
}

export function ReportProblemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [category, setCategory] = useState<Category>('bug');
  const [text, setText] = useState('');
  const [emailMe, setEmailMe] = useState(true);
  const [state, setState] = useState<SendState>({ kind: 'editing' });

  useEffect(() => {
    if (!open) return;
    setCategory('bug');
    setText('');
    setEmailMe(true);
    setState({ kind: 'editing' });
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    try {
      const res = await api.post('/api/support/report', {
        category,
        text,
        email_me: emailMe,
        // The route template ("/tasks/:id"), never the address.
        ...(currentPageTemplate() ? { page: currentPageTemplate() } : {}),
        request_ids: recentErrorReferences(),
      });
      const body = await res.json().catch(() => ({})) as { reference?: string; error?: string };
      if (res.ok && typeof body.reference === 'string') {
        setState({ kind: 'sent', reference: body.reference, emailMe });
        return;
      }
      setState({ kind: 'editing', error: body.error || 'Your report could not be sent. Try again in a few minutes.' });
    } catch {
      setState({ kind: 'editing', error: 'Your report could not be sent. Check your connection and try again.' });
    }
  };

  if (state.kind === 'sent') {
    return (
      <AppDialog open={open} onClose={onClose} title="Thanks for the report" width={460} headerActions={<CloseButton onClose={onClose} />}>
        <div className="space-y-3 text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>
          <p>The Deft team has your report.</p>
          <p>
            Your reference is <strong className="font-mono" style={{ color: 'var(--on-surface)' }}>{state.reference}</strong>.
            {state.emailMe ? ' We will email you at your account address if we need to know more.' : ''}
          </p>
          <div className="flex justify-end pt-2">
            <button type="button" onClick={onClose} className="h-9 rounded-lg px-4 text-[0.8125rem] font-medium"
              style={{ background: 'var(--primary-container)', color: '#FFFFFF' }}>Done</button>
          </div>
        </div>
      </AppDialog>
    );
  }

  const sending = state.kind === 'sending';
  return (
    <AppDialog open={open} onClose={onClose} title="Report a problem" width={520} headerActions={<CloseButton onClose={onClose} />}>
      <form onSubmit={submit} className="space-y-4 text-[0.875rem]">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface-variant)' }}>What kind of problem?</legend>
          {CATEGORIES.map((option) => (
            <label key={option.value} className="flex min-h-9 items-center gap-2">
              <input type="radio" name="report-category" value={option.value} checked={category === option.value}
                onChange={() => setCategory(option.value)} disabled={sending} />
              <span style={{ color: 'var(--on-surface)' }}>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="block">
          <span className="mb-1 block text-[0.75rem] font-semibold" style={{ color: 'var(--on-surface-variant)' }}>What happened?</span>
          <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, TEXT_MAX))} maxLength={TEXT_MAX} rows={6}
            required disabled={sending} aria-describedby="report-problem-note"
            className="w-full resize-y rounded-lg p-3 outline-none"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)', color: 'var(--on-surface)' }} />
          <span className="mt-1 block text-right text-[0.6875rem]" style={{ color: 'var(--outline)' }}>{text.length} / {TEXT_MAX}</span>
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input type="checkbox" checked={emailMe} onChange={(e) => setEmailMe(e.target.checked)} disabled={sending} />
          <span style={{ color: 'var(--on-surface)' }}>Email me about this report</span>
        </label>
        <p id="report-problem-note" className="text-[0.75rem] leading-5" style={{ color: 'var(--on-surface-variant)' }}>
          What you write is sent to the Deft team with technical details (release, browser, recent request IDs). Don&apos;t include passwords or private content.
        </p>
        {state.kind === 'editing' && state.error && (
          <p role="alert" className="rounded-lg px-3 py-2 text-[0.8125rem]" style={{ background: 'rgba(147,0,10,0.3)', color: 'var(--error)' }}>{state.error}</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg px-4 text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>Cancel</button>
          <button type="submit" disabled={sending || !text.trim()} className="h-9 rounded-lg px-4 text-[0.8125rem] font-medium disabled:opacity-50"
            style={{ background: 'var(--primary-container)', color: '#FFFFFF' }}>{sending ? 'Sending…' : 'Send report'}</button>
        </div>
      </form>
    </AppDialog>
  );
}

export function GetHelpDialog({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  return (
    <AppDialog open={open} onClose={onClose} title="Get help" width={440} headerActions={<CloseButton onClose={onClose} />}>
      <p className="text-[0.875rem] leading-6" style={{ color: 'var(--on-surface-variant)' }}>
        For help with this Deft workspace, contact your administrator at{' '}
        <a href={`mailto:${email}`} className="underline underline-offset-4" style={{ color: 'var(--primary)' }}>{email}</a>.
      </p>
    </AppDialog>
  );
}
