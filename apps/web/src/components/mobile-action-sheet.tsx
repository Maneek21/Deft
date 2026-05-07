'use client';
import { ReactNode, useEffect } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

/**
 * Bottom sheet for mobile (`< md`) — slides up from the bottom, dismisses on
 * Escape or backdrop tap. Use for formatting toolbars, action lists, or any
 * cluster of buttons too dense for a 48px row at narrow widths.
 */
export function MobileActionSheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl pb-[max(env(safe-area-inset-bottom),16px)] pt-3"
        style={{ background: 'var(--surface)' }}
      >
        {title && <div className="px-4 pb-2 text-[0.8125rem] font-semibold opacity-70">{title}</div>}
        <div className="px-2 pb-2">{children}</div>
      </div>
    </>
  );
}
