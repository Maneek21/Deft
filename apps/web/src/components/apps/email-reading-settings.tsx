'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { emailReadingPreferenceRequest, type EmailReadingPreference } from '@/lib/email-reading-preferences';

export function EmailReadingSettings({ accountId, setupState, disabled, onBusy, onSaved }: {
  accountId: string; setupState: string; disabled: boolean; onBusy: (busy: boolean) => void; onSaved?: () => void;
}) {
  const id = useId(), [saved, setSaved] = useState<EmailReadingPreference | null>(null), [choice, setChoice] = useState<'ask' | 'always'>('ask');
  const [notice, setNotice] = useState('Checking saved reading choices…'), [working, setWorking] = useState(false), [reload, setReload] = useState(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  useEffect(() => {
    const controller = new AbortController(), anchor = api.getAccessToken();
    const current = () => !!anchor && !controller.signal.aborted && !document.hidden && isSameWebSession(anchor, api.getAccessToken());
    setSaved(null); setNotice('Checking saved reading choices…');
    void emailReadingPreferenceRequest(accountId, { fetch: (path, init) => api.fetch(path, init), current }, undefined, controller.signal)
      .then(value => { if (current()) { setSaved(value); setChoice(value.external_images); setNotice(''); } })
      .catch(error => { if (current()) setNotice(error instanceof Error ? error.message : 'Reading choices are unavailable.'); });
    return () => controller.abort();
  }, [accountId, setupState, reload]);
  async function save() {
    if (disabled || working || pending.current || !saved || choice === saved.external_images || document.hidden) return;
    const anchor = api.getAccessToken(), controller = new AbortController();
    pending.current=controller;
    const current = () => !!anchor && !controller.signal.aborted && !document.hidden && isSameWebSession(anchor, api.getAccessToken());
    setWorking(true); onBusy(true); setNotice('Saving reading choice…');
    try {
      const value = await emailReadingPreferenceRequest(accountId, { fetch: (path, init) => api.fetch(path, init), current },
        { external_images: choice, expected_revision: saved.revision }, controller.signal);
      if (current()) { setSaved(value); setChoice(value.external_images); setNotice('Reading choice saved for this account.'); onSaved?.(); }
    } catch (error) { if (current()) setNotice(error instanceof Error ? error.message : 'Reading choice was not saved.'); }
    finally { if (!controller.signal.aborted) setWorking(false); if(pending.current===controller)pending.current=null; onBusy(false); }
  }
  return <section aria-labelledby={`${id}-title`} className="space-y-3 pt-4 text-sm">
    <h4 id={`${id}-title`} className="font-medium">Reading &amp; images</h4>
    {saved && <>
      <label htmlFor={`${id}-external`} className="block">External images for this account</label>
      <select id={`${id}-external`} value={choice} disabled={disabled || working} onChange={event => setChoice(event.target.value as 'ask' | 'always')}
        className="min-h-11 w-full rounded-xl bg-[var(--surface-container-high)] px-3 focus-visible:ring-2 focus-visible:ring-[var(--primary)]">
        <option value="ask">Ask before loading (default)</option><option value="always">Always load</option>
      </select>
      <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>Embedded images load with the message. External images may tell the sender when you open it. You can load them for one message using the control above its body.</p>
      <button type="button" className="deft-pill min-h-11" disabled={disabled || working || choice === saved.external_images} onClick={() => void save()}>{working ? 'Saving…' : 'Save reading choice'}</button>
    </>}
    {notice && <p role="status" className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{notice}</p>}
    {!working && <button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={() => setReload(value => value + 1)}>Reload saved choice</button>}
  </section>;
}
