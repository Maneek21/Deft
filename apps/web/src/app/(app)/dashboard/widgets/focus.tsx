'use client';
import { useEffect, useRef, useState } from 'react';
import { Timer, Play, Pause, RotateCcw, Flame } from 'lucide-react';
import type { WidgetDefinition, WidgetProps } from '../lib/widget-types';

const WORK_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

type Phase = 'work' | 'break';

function streakKey(instanceId: string) {
  return `dashboard4:focus-streak:${instanceId}`;
}

function loadStreak(instanceId: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(streakKey(instanceId));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function FocusWidget({ instanceId }: WidgetProps) {
  const [phase, setPhase] = useState<Phase>('work');
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState(WORK_SECONDS);
  const [streak, setStreak] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setStreak(loadStreak(instanceId)); }, [instanceId]);

  useEffect(() => {
    if (!running) { if (tickRef.current) clearInterval(tickRef.current); return; }
    tickRef.current = setInterval(() => {
      setRemaining(prev => {
        if (prev > 1) return prev - 1;
        // rollover
        if (phase === 'work') {
          const nextStreak = streak + 1;
          setStreak(nextStreak);
          try { localStorage.setItem(streakKey(instanceId), String(nextStreak)); } catch {}
          setPhase('break');
          return BREAK_SECONDS;
        } else {
          setPhase('work');
          return WORK_SECONDS;
        }
      });
    }, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [running, phase, streak, instanceId]);

  const total = phase === 'work' ? WORK_SECONDS : BREAK_SECONDS;
  const pct = 1 - remaining / total;
  const mm = Math.floor(remaining / 60).toString().padStart(2, '0');
  const ss = (remaining % 60).toString().padStart(2, '0');
  const phaseColor = phase === 'work' ? 'var(--accent)' : 'var(--status-green)';

  const reset = () => {
    setRunning(false);
    setPhase('work');
    setRemaining(WORK_SECONDS);
  };

  const btnStyle = {
    display: 'grid', placeItems: 'center', width: 32, height: 32,
    borderRadius: 8, border: '1px solid var(--border-default)',
    background: 'var(--bg-primary)', color: 'var(--text-secondary)',
    cursor: 'pointer', transition: 'background 140ms',
  } as const;

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column', gap: 12,
      alignItems: 'center', justifyContent: 'center', textAlign: 'center',
    }}>
      <div style={{
        position: 'relative', width: 110, height: 110, flexShrink: 0,
      }}>
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r="48" fill="none"
            stroke="var(--border-default)" strokeWidth="6" />
          <circle cx="55" cy="55" r="48" fill="none"
            stroke={phaseColor} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 48}`}
            strokeDashoffset={`${2 * Math.PI * 48 * (1 - pct)}`}
            transform="rotate(-90 55 55)"
            style={{ transition: 'stroke-dashoffset 600ms linear' }} />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em', color: 'var(--text-primary)',
          }}>{mm}:{ss}</div>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.15em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
            marginTop: 2,
          }}>{phase === 'work' ? 'Focus' : 'Break'}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => setRunning(r => !r)}
          onMouseDown={e => e.stopPropagation()}
          style={{ ...btnStyle, width: 38, height: 38, background: phaseColor, color: 'white', borderColor: phaseColor }}>
          {running ? <Pause size={14} strokeWidth={2} /> : <Play size={14} strokeWidth={2} />}
        </button>
        <button onClick={reset} onMouseDown={e => e.stopPropagation()} style={btnStyle}>
          <RotateCcw size={13} strokeWidth={1.8} />
        </button>
      </div>
      {streak > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, color: 'var(--text-tertiary)',
        }}>
          <Flame size={11} strokeWidth={1.8} style={{ color: 'var(--status-amber)' }} />
          {streak} session{streak === 1 ? '' : 's'} today
        </div>
      )}
    </div>
  );
}

export const focusDefinition: WidgetDefinition = {
  apiVersion: 1,
  id: 'cairn.focus',
  title: 'Focus',
  description: 'Pomodoro timer — 25 focus, 5 break.',
  icon: Timer,
  category: 'work',
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 3 },
  Component: FocusWidget,
};
