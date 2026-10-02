'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NativeMentionKindSchema, ResourceOpaqueIdSchema, nativeMentionTokensToHtml, type NativeMentionKind } from '@deft/shared';
import { sanitizeHtml } from '@/lib/sanitize';
import { NativeReferenceChip } from './native-reference-chip';

export function NativeMentionContent({ html }: { html: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const [atoms, setAtoms] = useState<Array<{ element: HTMLElement; kind: NativeMentionKind; id: string }>>([]);
  const safe = useMemo(() => sanitizeHtml(nativeMentionTokensToHtml(html)), [html]);
  useEffect(() => {
    const next: typeof atoms = [];
    root.current?.querySelectorAll<HTMLElement>('span[data-deft-ref-kind][data-deft-ref-id]').forEach(element => {
      if (element.closest('pre, code, blockquote')) return;
      const kind = NativeMentionKindSchema.safeParse(element.dataset.deftRefKind);
      const id = ResourceOpaqueIdSchema.safeParse(element.dataset.deftRefId);
      if (kind.success && id.success) { element.textContent = ''; next.push({ element, kind: kind.data, id: id.data }); }
    });
    setAtoms(next);
  }, [safe]);
  return <><span ref={root} dangerouslySetInnerHTML={{ __html: safe }} />
    {atoms.map((atom, index) => createPortal(<NativeReferenceChip kind={atom.kind} id={atom.id} />, atom.element, index))}
  </>;
}
