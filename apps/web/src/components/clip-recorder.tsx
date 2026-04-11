'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type ClipRecorderProps = {
  spaceId: string;
  contextType: 'space' | 'task' | 'thread' | 'project';
  contextId: string;
  parentId?: string; // for thread replies
  onComplete?: (clipId: string, messageId: string) => void;
  onCancel?: () => void;
};

export function ClipRecorder({ spaceId, contextType, contextId, parentId, onComplete, onCancel }: ClipRecorderProps) {
  const [state, setState] = useState<'idle' | 'countdown' | 'recording' | 'uploading'>('idle');
  const [countdown, setCountdown] = useState(3);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(undefined);

  const MAX_DURATION = 300; // 5 minutes

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    analyserRef.current = null;
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const startRecording = useCallback(async () => {
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Set up audio analysis for level meter
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Countdown
      setState('countdown');
      setCountdown(3);

      let count = 3;
      const countdownInterval = setInterval(() => {
        count--;
        setCountdown(count);
        if (count <= 0) {
          clearInterval(countdownInterval);
          beginCapture(stream);
        }
      }, 1000);
    } catch (err) {
      setError('Microphone access denied. Please allow microphone access in your browser settings.');
      setState('idle');
    }
  }, []);

  const beginCapture = useCallback((stream: MediaStream) => {
    chunksRef.current = [];
    setState('recording');
    setDuration(0);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      uploadClip(blob);
    };

    recorder.start(1000); // collect data every 1s

    // Duration timer
    timerRef.current = setInterval(() => {
      setDuration(prev => {
        if (prev >= MAX_DURATION - 1) {
          stopRecording();
          return prev;
        }
        return prev + 1;
      });
    }, 1000);

    // Audio level visualization
    const updateLevel = () => {
      if (!analyserRef.current) return;
      const data = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      setAudioLevel(avg / 255);
      animFrameRef.current = requestAnimationFrame(updateLevel);
    };
    updateLevel();
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }

    setState('uploading');
  }, []);

  const uploadClip = useCallback(async (blob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('file', blob, 'clip.webm');
      formData.append('context_type', contextType);
      formData.append('context_id', contextId);
      formData.append('space_id', spaceId);
      formData.append('duration', String(duration));
      if (parentId) formData.append('parent_id', parentId);

      const token = localStorage.getItem('deft-access-token');
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

      const res = await fetch(`${apiUrl}/api/clips`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || 'Upload failed');
      }

      const data = await res.json();
      cleanup();
      setState('idle');
      onComplete?.(data.id, data.message_id);
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
      cleanup();
    }
  }, [contextType, contextId, spaceId, parentId, duration, cleanup, onComplete]);

  const cancel = useCallback(() => {
    cleanup();
    setState('idle');
    setDuration(0);
    onCancel?.();
  }, [cleanup, onCancel]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Idle — show mic button
  if (state === 'idle' && !error) {
    return (
      <button
        onClick={startRecording}
        className="p-1.5 rounded-md transition-colors"
        style={{ color: 'var(--muted)' }}
        title="Record audio clip (⌘H)"
      >
        <Mic size={15} strokeWidth={1.5} />
      </button>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px]"
        style={{ background: 'rgba(220,50,50,0.1)', color: 'var(--status-red)' }}>
        <span className="flex-1 truncate">{error}</span>
        <button onClick={() => { setError(null); setState('idle'); }} className="p-0.5">
          <X size={12} />
        </button>
      </div>
    );
  }

  // Countdown
  if (state === 'countdown') {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-xl"
        style={{ background: 'var(--surface-container-high)' }}>
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-[20px] font-bold"
          style={{ background: 'rgba(220,50,50,0.1)', color: 'var(--status-red)' }}>
          {countdown}
        </div>
        <span className="text-[13px] font-medium" style={{ color: 'var(--on-surface-variant)' }}>
          Recording starts in...
        </span>
        <button onClick={cancel} className="ml-auto p-1.5 rounded-md" style={{ color: 'var(--outline)' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  // Recording
  if (state === 'recording') {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-xl"
        style={{ background: 'var(--surface-container-high)' }}>
        {/* Pulsing red dot */}
        <div className="relative flex items-center justify-center w-8 h-8">
          <div className="absolute w-8 h-8 rounded-full animate-ping"
            style={{ background: 'rgba(220,50,50,0.2)' }} />
          <div className="w-3 h-3 rounded-full" style={{ background: 'var(--status-red)' }} />
        </div>

        {/* Audio level bars */}
        <div className="flex items-end gap-[2px] h-5">
          {Array.from({ length: 5 }).map((_, i) => {
            const threshold = (i + 1) / 6;
            const active = audioLevel > threshold;
            return (
              <div key={i} className="w-[3px] rounded-full transition-all duration-75"
                style={{
                  height: active ? `${8 + (i * 2.5)}px` : '4px',
                  background: active ? 'var(--status-red)' : 'var(--outline-variant)',
                }} />
            );
          })}
        </div>

        {/* Timer */}
        <span className="text-[13px] font-mono font-medium tabular-nums"
          style={{ color: 'var(--on-surface)' }}>
          {formatTime(duration)}
        </span>

        {/* Max duration warning */}
        {duration >= MAX_DURATION - 30 && (
          <span className="text-[11px]" style={{ color: 'var(--status-amber)' }}>
            {formatTime(MAX_DURATION - duration)} left
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={cancel} className="p-1.5 rounded-md" style={{ color: 'var(--outline)' }} title="Cancel">
            <X size={14} />
          </button>
          <button onClick={stopRecording}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white"
            style={{ background: 'var(--status-red)' }}>
            <Square size={10} fill="white" />
            Stop
          </button>
        </div>
      </div>
    );
  }

  // Uploading
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl"
      style={{ background: 'var(--surface-container-high)' }}>
      <Loader2 size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
      <span className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>
        Processing clip...
      </span>
    </div>
  );
}

// Standalone mic button for the composer toolbar
export function ClipRecorderButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-md transition-colors"
      style={{ color: 'var(--muted)' }}
      title="Record audio clip"
    >
      <Mic size={15} strokeWidth={1.5} />
    </button>
  );
}
