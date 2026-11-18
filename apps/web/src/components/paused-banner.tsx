'use client';

import { useEffect, useRef, useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  PAUSED_BANNER_TEXT,
  PAUSED_REFUSED_EVENT,
  PAUSED_WRITE_MESSAGE,
  type PausedNotice,
  type PausedRefusedDetail,
} from '@/lib/paused-notice';

/**
 * The persistent notice shown at the top of the app while the workspace is
 * paused. `refused` adds one calm line after a change was refused, announced
 * politely to screen readers. Renders nothing when not paused.
 */
export function PausedBanner({ notice, refused = false }: { notice: PausedNotice | null; refused?: boolean }) {
  if (!notice) return null;
  return (
    <section
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
      <div className="min-w-0 flex-1">
        <p>{PAUSED_BANNER_TEXT[notice.reason]}</p>
        <p role="status" className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {refused ? PAUSED_WRITE_MESSAGE : ''}
        </p>
      </div>
    </section>
  );
}

const REFUSED_LINE_MS = 6000;
const RECHECK_MS = 30_000;

/** Reads the paused state from the session and reacts to refused requests. */
export function PausedBannerHost() {
  const { paused, refreshUser } = useAuth();
  const [refused, setRefused] = useState(false);
  const pausedRef = useRef(paused);
  const lastRecheck = useRef(0);
  pausedRef.current = paused;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onRefused = (event: Event) => {
      const detail = (event as CustomEvent<PausedRefusedDetail>).detail;
      // The install was paused after this page loaded: ask the session why.
      if (!pausedRef.current && Date.now() - lastRecheck.current > RECHECK_MS) {
        lastRecheck.current = Date.now();
        void refreshUser();
      }
      if (!detail?.write) return;
      setRefused(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRefused(false), REFUSED_LINE_MS);
    };
    window.addEventListener(PAUSED_REFUSED_EVENT, onRefused);
    return () => {
      window.removeEventListener(PAUSED_REFUSED_EVENT, onRefused);
      if (timer) clearTimeout(timer);
    };
  }, [refreshUser]);

  return <PausedBanner notice={paused} refused={refused} />;
}
