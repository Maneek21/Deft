'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Headphones, X } from 'lucide-react';
import type { HuddleRing } from '@/hooks/use-huddle';
import type { HuddleClientError } from '@/lib/huddle-types';

const AUTO_DISMISS_MS = 15000;

/** Play a short two-tone chime using Web Audio API */
function playRingSound() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);

    // First tone: 440Hz for 120ms
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 440;
    osc1.connect(gain);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.12);

    // Second tone: 554Hz for 120ms (after 80ms gap)
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 554;
    osc2.connect(gain);
    osc2.start(ctx.currentTime + 0.2);
    osc2.stop(ctx.currentTime + 0.32);

    // Fade out
    gain.gain.setValueAtTime(0.15, ctx.currentTime + 0.3);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);

    // Close context after sound finishes
    setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    // AudioContext not available or blocked
  }
}

/** Send a browser notification if tab is not focused */
function sendBrowserNotification(ring: HuddleRing) {
  if (document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;

  // A background socket event is not a user gesture. Browsers may suppress or
  // penalize unsolicited permission prompts, so permission is requested only
  // from an explicit settings/user flow elsewhere.
  if (Notification.permission !== 'granted') return;

  const notif = new Notification(`Huddle in #${ring.space_name}`, {
    body: `${ring.created_by_name} started a huddle`,
    tag: `huddle-${ring.huddle_id}`,
  });
  notif.onclick = () => { window.focus(); notif.close(); };
}

export function HuddleRingToast({
  rings, busy, onJoin, onDismiss,
}: {
  rings: HuddleRing[];
  busy: boolean;
  onJoin: (spaceId: string) => void;
  onDismiss: (ringId: string) => void;
}) {
  return (
    <div
      className="fixed left-4 right-4 top-4 z-[70] flex flex-col gap-2 sm:left-auto sm:w-[360px]"
      role="region"
      aria-label="Huddle invitations"
      aria-live="polite"
    >
      {rings.map((ring) => (
        <RingCard key={ring.id} ring={ring} busy={busy} onJoin={onJoin} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function RingCard({
  ring, busy, onJoin, onDismiss,
}: {
  ring: HuddleRing;
  busy: boolean;
  onJoin: (spaceId: string) => void;
  onDismiss: (ringId: string) => void;
}) {
  const [progress, setProgress] = useState(100);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const pausedRef = useRef(false);
  const soundPlayedRef = useRef(false);

  // Play sound + browser notification on mount
  useEffect(() => {
    if (!soundPlayedRef.current) {
      soundPlayedRef.current = true;
      playRingSound();
      sendBrowserNotification(ring);
    }
  }, [ring]);

  // Auto-dismiss timer + progress bar
  useEffect(() => {
    const startTime = Date.now();

    intervalRef.current = setInterval(() => {
      if (pausedRef.current) return;
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 100 - (elapsed / AUTO_DISMISS_MS) * 100);
      setProgress(remaining);
    }, 50);

    timerRef.current = setTimeout(() => {
      onDismiss(ring.id);
    }, AUTO_DISMISS_MS);

    return () => {
      clearTimeout(timerRef.current);
      clearInterval(intervalRef.current);
    };
  }, [ring.id, onDismiss]);

  const handleJoin = () => {
    if (busy) return;
    onJoin(ring.space_id);
    onDismiss(ring.id);
  };

  return (
    <div
      role="status"
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--surface-container-highest, #1e1e2e)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        animation: 'ringSlideIn 200ms ease-out',
      }}
      onMouseEnter={() => { pausedRef.current = true; }}
      onMouseLeave={() => { pausedRef.current = false; }}
    >
      <div className="px-4 py-3 flex items-start gap-3">
        {/* Icon */}
        <div className="relative flex-shrink-0 mt-0.5">
          <div className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(34,197,94,0.15)' }}>
            <Headphones size={18} style={{ color: '#22c55e' }} />
          </div>
          <div className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2"
            style={{ background: '#22c55e', borderColor: 'var(--surface-container-highest, #1e1e2e)' }}>
            <div className="w-full h-full rounded-full animate-ping opacity-40" style={{ background: '#22c55e' }} />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[12px]" style={{ color: 'var(--text-primary)' }}>
            <strong>{ring.created_by_name}</strong>
            {' started a huddle in '}
            <strong>#{ring.space_name}</strong>
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {ring.participants.length} {ring.participants.length === 1 ? 'person' : 'people'} in huddle
          </p>

          {/* Actions */}
          <div className="flex items-center gap-2 mt-2.5">
            <button onClick={handleJoin}
              disabled={busy}
              aria-busy={busy}
              className="min-h-[44px] px-3.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              style={{ background: '#22c55e', color: 'white' }}>
              {busy ? 'Connecting…' : 'Join'}
            </button>
            <button onClick={() => onDismiss(ring.id)}
              className="min-h-[44px] px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors hover:opacity-80"
              style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)' }}>
              Dismiss
            </button>
          </div>
        </div>

        {/* Close */}
        <button onClick={() => onDismiss(ring.id)}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded hover:opacity-70 flex-shrink-0"
          aria-label={`Dismiss huddle invitation from ${ring.created_by_name}`}
          style={{ color: 'var(--text-tertiary)' }}>
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-[2px] w-full" style={{ background: 'var(--border-default)' }}>
        <div className="h-full transition-all"
          style={{ width: `${progress}%`, background: '#22c55e', transitionDuration: '50ms' }} />
      </div>

      <style>{`
        @keyframes ringSlideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export function HuddleErrorToast({
  error,
  onDismiss,
}: {
  error: HuddleClientError;
  onDismiss: () => void;
}) {
  return (
    <div
      key={error.id}
      className="fixed bottom-4 left-4 right-4 z-[72] rounded-xl p-3 sm:left-auto sm:w-[360px]"
      style={{
        background: 'var(--surface-container-highest, #1e1e2e)',
        border: '1px solid var(--status-red, #ef4444)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-start gap-3">
        <AlertCircle size={20} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--status-red, #ef4444)' }} />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Huddle unavailable
          </p>
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {error.message}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center rounded hover:opacity-70"
          style={{ color: 'var(--text-tertiary)' }}
          aria-label="Dismiss huddle error"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
