'use client';

import { useId } from 'react';
import { validateComposePlainContent, type ComposePlainContent } from '@/lib/app-experience-compose-controls';

const secondary = 'text-xs text-[var(--on-surface-variant)]';

export function ExperienceComposePlainEditor({ label, value, maxBytes, maxCharacters, onChange, disabled = false, placeholder }: {
  label: string; value: ComposePlainContent; maxBytes: number; maxCharacters?: number;
  onChange: (value: ComposePlainContent) => void; disabled?: boolean; placeholder?: string;
}) {
  const id = useId(), error = validateComposePlainContent(value, maxBytes, maxCharacters), bytes = new TextEncoder().encode(value.text).byteLength;
  return <div className="min-w-0 flex-1 pt-5">
    <div className="flex items-baseline justify-between gap-2"><label htmlFor={id} className="sr-only">{label}</label><span className={`${secondary} ml-auto`}>Plain text</span></div>
    <textarea data-compose-writing-control="true" id={id} value={value.text} disabled={disabled} placeholder={placeholder}
      className="w-full min-h-[clamp(12rem,35dvh,24rem)] resize-y rounded-lg bg-transparent px-1 py-3 text-[0.9375rem] leading-7 outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-60" aria-invalid={Boolean(error)} aria-describedby={`${id}-detail`}
      onChange={event => onChange({ format: 'plain', text: event.target.value })} />
    <div id={`${id}-detail`} className="flex flex-wrap justify-between gap-1">
      <p role="status" className={error ? 'text-xs text-[var(--error)]' : secondary}>{error?.error || ''}</p>
      <span className={secondary}>{maxCharacters === undefined ? `${bytes.toLocaleString()} / ${maxBytes.toLocaleString()} bytes`
        : `${value.text.length.toLocaleString()} / ${maxCharacters.toLocaleString()} characters`}</span>
    </div>
  </div>;
}
