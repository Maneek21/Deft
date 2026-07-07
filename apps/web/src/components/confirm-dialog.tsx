'use client';

import { useRef } from 'react';
import { AppDialog } from './overlay-primitives';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <AppDialog
      open
      onClose={onCancel}
      title={title}
      description={message}
      danger={danger}
      width={380}
      initialFocusRef={cancelRef}
      footer={
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-[0.8125rem] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-container)]"
            style={{
              color: 'var(--on-surface-variant)',
              background: 'var(--surface-container-low)',
              border: '1px solid var(--outline-variant)',
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg px-4 py-2 text-[0.8125rem] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-container)]"
            style={{ background: danger ? 'var(--danger)' : 'var(--accent)' }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <span className="sr-only">{message}</span>
    </AppDialog>
  );
}
