'use client';

import { useEffect, useState } from 'react';
import { Share, X } from 'lucide-react';
import {
  readIosInstallHintDismissed,
  rememberIosInstallHintDismissed,
  shouldShowIosInstallHint,
} from '@/lib/ios-install-hint';

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Small dismissible instruction for iPhone Safari users who have not added Deft to the Home Screen. */
export function IosInstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setVisible(shouldShowIosInstallHint({
      userAgent: nav.userAgent,
      navigatorStandalone: nav.standalone,
      displayModeStandalone: typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: standalone)').matches
        : false,
      dismissed: readIosInstallHintDismissed(safeLocalStorage()),
    }));
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    rememberIosInstallHintDismissed(safeLocalStorage());
    setVisible(false);
  };

  return (
    <div
      className="fixed bottom-4 left-4 right-4 z-[70] rounded-xl p-3 sm:left-auto sm:w-[360px]"
      style={{
        background: 'var(--surface-container-highest)',
        border: '1px solid var(--border)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}
      role="status"
    >
      <div className="flex items-start gap-3">
        <Share size={18} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Add Deft to your Home Screen
          </p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <li>Tap Share in Safari.</li>
            <li>Choose Add to Home Screen.</li>
          </ol>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Notifications on iPhone work only from the Home Screen app.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded-full p-1"
          style={{ color: 'var(--muted)' }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
