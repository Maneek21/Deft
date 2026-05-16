'use client';

import { Loader2 } from 'lucide-react';

export function AILoadingOverlay({ message }: { message: string }) {
  return (
    <div
      className="fixed bottom-6 right-6 z-[200] flex items-center gap-3 px-4 py-3 rounded-lg"
      style={{
        background: 'var(--surface-container-low)',
        border: '1px solid var(--outline-variant)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      }}
    >
      <Loader2 size={16} className="animate-spin" style={{ color: 'var(--accent)' }} />
      <span className="text-[13px]" style={{ color: 'var(--on-surface)' }}>{message}</span>
    </div>
  );
}
