'use client';

import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onCancel}>
      <div
        className="w-full max-w-[360px] rounded-xl p-5 flex flex-col gap-4"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--glass-shadow)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{title}</div>
        <div className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>{message}</div>
        <div className="flex justify-end gap-2 mt-1">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-[0.8125rem] rounded-lg font-medium"
            style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-[0.8125rem] rounded-lg font-medium"
            style={{
              background: danger ? 'var(--danger)' : 'var(--accent)',
              color: '#fff',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
