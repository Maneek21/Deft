'use client';

import { useEffect, useState } from 'react';
import { AILoadingOverlay } from './ai-loading-overlay';

/**
 * Self-mounting listener for AI loading/toast events from the slash-action
 * runtime. Mount once per page that hosts AI-capable editor surfaces.
 */
export function AILoadingListener() {
  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'error' | 'info'; message: string } | null>(null);

  useEffect(() => {
    const onLoading = (e: Event) => setMessage((e as CustomEvent).detail?.message ?? 'Working…');
    const onDone = () => setMessage(null);
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setToast({ kind: detail.kind ?? 'info', message: detail.message ?? '' });
      setTimeout(() => setToast(null), 4000);
    };
    window.addEventListener('deft:ai-loading', onLoading);
    window.addEventListener('deft:ai-loading-done', onDone);
    window.addEventListener('deft:ai-toast', onToast);
    return () => {
      window.removeEventListener('deft:ai-loading', onLoading);
      window.removeEventListener('deft:ai-loading-done', onDone);
      window.removeEventListener('deft:ai-toast', onToast);
    };
  }, []);

  return (
    <>
      {message && <AILoadingOverlay message={message} />}
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-[200] px-4 py-3 rounded-lg text-[13px]"
          style={{
            background: toast.kind === 'error' ? 'var(--error-container, #5a2a2a)' : 'var(--surface-container-low)',
            color: toast.kind === 'error' ? 'var(--on-error-container, #fff)' : 'var(--on-surface)',
            border: '1px solid var(--outline-variant)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          }}
        >
          {toast.message}
        </div>
      )}
    </>
  );
}
