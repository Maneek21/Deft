'use client';

import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { composeAddressLabel, parseComposeAddresses, selectedComposeIdentity, type ComposeAddress, type ComposeIdentityOption } from '@/lib/app-experience-compose-controls';
import { formatMailboxList, parseMailboxList, type MailboxAddress } from '../../../../../packages/app-kit/src/mailbox-list';

const control = 'w-full min-h-11 rounded-lg border border-[var(--outline-variant)] px-3 py-2 bg-transparent outline-none focus:border-[var(--primary)] disabled:opacity-60';
const secondary = 'text-xs text-[var(--on-surface-variant)]';

type MailboxEdit = { value: string; addresses: readonly MailboxAddress[]; pending: string };
function mailboxEdit(value: string, maxItems: number): MailboxEdit {
  try { return { value, addresses: parseMailboxList(value, { maxItems, allowEmpty: true }), pending: '' }; }
  catch { return { value, addresses: [], pending: value }; }
}

/** Scalar contract text stays in the parent on every keystroke. An incomplete
 * recipient therefore invalidates the saved preview, even before chip commit.
 * Explicit commits use the same parser as the host and retain order/duplicates. */
export function ExperienceComposeMailboxControl({ label, value, maxItems = 32, maxLength = 2048, disabled = false, onChange }: {
  label: string; value: string; maxItems?: number; maxLength?: number; disabled?: boolean; onChange: (value: string) => void;
}) {
  const id = useId();
  const [edit, setEdit] = useState(() => mailboxEdit(value, maxItems));
  const [notice, setNotice] = useState('');
  // External recovery replacement is displayed immediately; it cannot retain
  // chip state from a previous saved version or overwrite that replacement.
  const current = edit.value === value ? edit : mailboxEdit(value, maxItems);
  const visibleNotice = edit.value === value ? notice : '';
  const write = (addresses: readonly MailboxAddress[], pending: string) => {
    const committed = formatMailboxList(addresses);
    const next = committed && pending ? `${committed}, ${pending}` : committed || pending;
    setEdit({ value: next, addresses, pending });
    if (next !== value) onChange(next);
  };
  const commit = () => {
    if (disabled || !current.pending.trim()) return;
    try {
      if (current.value.length > maxLength) throw Error('Limit');
      const addresses = parseMailboxList(current.value, { maxItems, allowEmpty: true });
      write(addresses, ''); setNotice('');
    } catch { setNotice(`Check ${label.toLowerCase()}. Your input is kept for correction.`); }
  };
  let invalid = current.value.length > maxLength;
  try { parseMailboxList(current.value, { maxItems, allowEmpty: true }); } catch { invalid = true; }
  return <div className="min-w-0">
    <div className="flex min-w-0 items-start gap-3">
      <label htmlFor={id} className="w-14 shrink-0 py-3.5 text-xs text-[var(--on-surface-variant)]">{label}</label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {current.addresses.map((address, index) => <span key={`${address.address}-${index}`} className="inline-flex min-w-0 max-w-full items-center rounded-full bg-[var(--surface-container-high)] pl-3 text-xs">
          <span className="min-w-0 truncate" title={composeAddressLabel(address)}>{composeAddressLabel(address)}</span>
          <button type="button" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50"
            aria-label={`Remove ${address.address} from ${label}`} disabled={disabled} onClick={() => { write(current.addresses.filter((_, item) => item !== index), current.pending); setNotice(''); }}><X size={13} aria-hidden="true" /></button>
        </span>)}
        <input id={id} data-compose-writing-control="true" data-compose-has-value={current.addresses.length > 0 || Boolean(current.pending.trim())} type="text" inputMode="email" autoComplete="off" spellCheck={false}
          value={current.pending} disabled={disabled} placeholder={current.addresses.length ? 'Add recipient' : 'Add an email address'}
          aria-invalid={invalid} aria-describedby={`${id}-detail`}
          className="min-h-11 min-w-20 flex-1 rounded-full bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-60"
          onChange={event => { write(current.addresses, event.target.value); setNotice(''); }} onBlur={commit}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            if (event.key === ',' || event.key === ';') {
              // Invalid/incomplete quoted names keep their punctuation as text.
              try { parseMailboxList(current.pending, { maxItems }); } catch { return; }
              event.preventDefault(); commit();
            }
          }} />
      </div>
    </div>
    <p id={`${id}-detail`} role="status" className={visibleNotice ? 'pb-2 pl-[4.25rem] text-xs text-[var(--error)]' : 'sr-only'}>
      {visibleNotice || 'Separate addresses with a comma or semicolon. Press Enter to add recipients.'}
    </p>
  </div>;
}

/** Host must supply its current verified options; there is no free-text sender. */
export function ExperienceComposeIdentityControl({ label, options, selectedKey, onChange, disabled = false }: {
  label: string; options: readonly ComposeIdentityOption[]; selectedKey: string; onChange: (key: string) => void; disabled?: boolean;
}) {
  const id = useId(), selected = selectedComposeIdentity(options, selectedKey);
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-sm font-medium">{label}</label>
    <select id={id} className={`${control} text-sm`} value={selected.ok ? selectedKey : ''} disabled={disabled || options.length === 0}
      aria-invalid={!selected.ok} aria-describedby={`${id}-detail`} onChange={event => {
        if (selectedComposeIdentity(options, event.target.value).ok) onChange(event.target.value);
      }}>
      {!selected.ok && <option value="" disabled>Select an available identity</option>}
      {options.map(option => <option key={option.key} value={option.key}>{option.label} · {option.address.address}</option>)}
    </select>
    <p id={`${id}-detail`} className={selected.ok ? secondary : 'text-xs text-[var(--error)]'} role={selected.ok ? undefined : 'status'}>
      {selected.ok ? composeAddressLabel(selected.value.address) : selected.error}
    </p>
  </div>;
}

/** Pending text is parent-controlled so confirmation can flush and validate it.
 * Invalid paste never commits a subset, and never disappears on blur. */
export function ExperienceComposeAddressControl({ label, value, pendingText, maxItems = 200, onChange, onPendingTextChange, disabled = false }: {
  label: string; value: readonly ComposeAddress[]; pendingText: string; maxItems?: number; disabled?: boolean;
  onChange: (value: readonly ComposeAddress[]) => void; onPendingTextChange: (value: string) => void;
}) {
  const id = useId(), [notice, setNotice] = useState('');
  const parsed = parseComposeAddresses(pendingText, value, maxItems);
  const error = !parsed.ok ? parsed.error : '';
  const commit = () => {
    if (disabled || !pendingText.trim() || !parsed.ok) return;
    onChange(parsed.value.addresses); onPendingTextChange('');
    setNotice(parsed.value.duplicates ? `${parsed.value.duplicates} duplicate ${parsed.value.duplicates === 1 ? 'address was' : 'addresses were'} removed.` : '');
  };
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-sm font-medium">{label}</label>
    <div className={`rounded-xl bg-[var(--surface-container-low)] p-2 focus-within:ring-2 focus-within:ring-[var(--primary)] ${error ? 'border-[var(--error)]' : 'border-[var(--outline-variant)]'}`}>
      {value.length > 0 && <ul className="mb-1 flex flex-wrap gap-1.5" aria-label={`${label} addresses`}>
        {value.map((address, index) => <li key={`${address.address.toLowerCase()}-${index}`} className="flex min-w-0 max-w-full items-center gap-1 rounded-full bg-[var(--surface-container-high)] pl-2.5 text-sm">
          <span className="min-w-0 break-all py-1" title={composeAddressLabel(address)}>{composeAddressLabel(address)}</span>
          <button type="button" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50"
            aria-label={`Remove ${address.address} from ${label}`} disabled={disabled} onClick={() => onChange(value.filter((_, item) => item !== index))}><X size={14} aria-hidden="true" /></button>
        </li>)}
      </ul>}
      <div className="flex min-w-0 gap-1">
        <textarea id={id} rows={1} inputMode="email" autoComplete="off" spellCheck={false} value={pendingText} disabled={disabled}
          placeholder="Add an email address" aria-invalid={Boolean(error)} aria-describedby={`${id}-detail`}
          className="min-h-11 w-full min-w-0 resize-none bg-transparent px-1 py-3 text-sm leading-normal outline-none disabled:opacity-60"
          onChange={event => { onPendingTextChange(event.target.value); setNotice(''); }} onBlur={commit}
          onKeyDown={event => {
            if (!event.nativeEvent.isComposing && (event.key === 'Enter' || event.key === ';' || event.key === ',')) {
              // A comma inside a quoted display name remains part of that name.
              if (event.key !== 'Enter' && (pendingText.match(/"/gu)?.length ?? 0) % 2 !== 0) return;
              event.preventDefault(); commit();
            }
          }} />
        <button type="button" className="min-h-11 shrink-0 rounded-lg px-2.5 text-sm text-[var(--primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-50"
          disabled={disabled || !pendingText.trim() || Boolean(error)} onClick={commit}>Add</button>
      </div>
    </div>
    <p id={`${id}-detail`} role="status" className={error ? 'text-xs text-[var(--error)]' : secondary}>
      {error || notice || 'Separate addresses with a comma, semicolon or new line.'}
    </p>
  </div>;
}
