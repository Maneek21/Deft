'use client';

import { useEffect, useRef } from 'react';
import { PauseCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PAUSED_BANNER_TEXT, PAUSED_REFUSED_EVENT, type PausedNotice } from '@/lib/paused-notice';

/**
 * The persistent notice shown at the top of the app while the workspace is
 * paused. Renders nothing when not paused. A refused change is explained
 * where it was made (the API client swaps in a calm message that points
 * here); the banner itself does not react, because the app also makes
 * background writes (marking a channel read) that are refused while paused.
 */
export function PausedBanner({ notice }: { notice: PausedNotice | null }) {
  if (!notice) return null;
  return (
    <section
      role="region"
      aria-label="Workspace paused"
      data-paused-reason={notice.reason}
      className="flex flex-shrink-0 items-start gap-2.5 px-4 py-2.5 text-[13px]"
      style={{
        background: 'var(--surface-container-high)',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-primary)',
      }}
    >
      <PauseCircle size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0" style={{ color: 'var(--accent)' }} />
      <p className="min-w-0 flex-1">{PAUSED_BANNER_TEXT[notice.reason]}</p>
    </section>
  );
}

const RECHECK_MS = 30_000;

/** Reads the paused state from the session; rechecks it when a request is refused as paused. */
export function PausedBannerHost() {
  const { paused, refreshUser } = useAuth();
  const pausedRef = useRef(paused);
  const lastRecheck = useRef(0);
  pausedRef.current = paused;

  useEffect(() => {
    const onRefused = () => {
      // The install was paused after this page loaded: ask the session why.
      if (pausedRef.current || Date.now() - lastRecheck.current < RECHECK_MS) return;
      lastRecheck.current = Date.now();
      void refreshUser();
    };
    window.addEventListener(PAUSED_REFUSED_EVENT, onRefused);
    return () => window.removeEventListener(PAUSED_REFUSED_EVENT, onRefused);
  }, [refreshUser]);

  return <PausedBanner notice={paused} />;
}
