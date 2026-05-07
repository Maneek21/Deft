'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Loader2, Send } from 'lucide-react';
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
  const [state, setState] = useState<'starting' | 'recording' | 'uploading' | 'error' | 'idle'>('starting');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(undefined);
  const startedRef = useRef(false);

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
    if (startedRef.current) return;
    startedRef.current = true;
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

      // Begin capturing immediately — no countdown.
      beginCapture(stream);
    } catch (err) {
      setError('Microphone access denied. Please allow microphone access in your browser settings.');
      setState('error');
      startedRef.current = false;
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
      setState('error');
      cleanup();
    }
  }, [contextType, contextId, spaceId, parentId, duration, cleanup, onComplete]);

  const cancel = useCallback(() => {
    cleanup();
    setDuration(0);
    onCancel?.();
  }, [cleanup, onCancel]);

  // Auto-start when this component mounts. WhatsApp/iMessage start recording
  // immediately on tap — no countdown delay. The pre-existing countdown was
  // disruptive friction every time a user wanted to send a voice message.
  useEffect(() => {
    startRecording();
  }, [startRecording]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Error state
  if (state === 'error' && error) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px]"
        style={{ background: 'rgba(220,50,50,0.1)', color: 'var(--status-red)' }}>
        <span className="flex-1 truncate">{error}</span>
        <button onClick={cancel} className="p-1.5" aria-label="Dismiss" style={{ color: 'var(--status-red)' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  // Recording — composer area becomes the recording bar.
  // Single Send action stops + uploads + posts (was previously Stop, then auto-upload).
  if (state === 'recording' || state === 'starting') {
    return (
      <div className="flex items-center gap-2 px-2 py-2 rounded-xl"
        style={{ background: 'var(--surface-container-high)' }}>
        {/* Cancel — leftmost, easy to reach */}
        <button onClick={cancel} aria-label="Cancel recording"
          className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md hover:opacity-70"
          style={{ color: 'var(--outline)' }}>
          <X size={18} />
        </button>

        {/* Pulsing red dot */}
        <div className="relative flex items-center justify-center w-6 h-6 flex-shrink-0">
          <div className="absolute w-6 h-6 rounded-full animate-ping"
            style={{ background: 'rgba(220,50,50,0.25)' }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--status-red)' }} />
        </div>

        {/* Timer + level meter, fills middle */}
        <span className="text-[14px] font-mono font-medium tabular-nums flex-shrink-0"
          style={{ color: 'var(--on-surface)' }}>
          {formatTime(duration)}
        </span>
        <div className="flex-1 flex items-end gap-[2px] h-5 min-w-0">
          {Array.from({ length: 12 }).map((_, i) => {
            const threshold = (i + 1) / 13;
            const active = audioLevel > threshold;
            return (
              <div key={i} className="w-[3px] rounded-full transition-all duration-75 flex-shrink-0"
                style={{
                  height: active ? `${6 + (i * 1.4)}px` : '3px',
                  background: active ? 'var(--status-red)' : 'var(--outline-variant)',
                }} />
            );
          })}
        </div>

        {/* Max duration warning */}
        {duration >= MAX_DURATION - 30 && (
          <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--status-amber)' }}>
            {formatTime(MAX_DURATION - duration)} left
          </span>
        )}

        {/* Send — rightmost, primary action. Single tap stops + uploads + posts. */}
        <button onClick={stopRecording} aria-label="Send voice message"
          disabled={state === 'starting'}
          className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
          style={{ background: 'var(--primary-container)', borderRadius: 'var(--radius-md)' }}>
          <Send size={18} strokeWidth={2} />
        </button>
      </div>
    );
  }

  // Uploading
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl"
      style={{ background: 'var(--surface-container-high)' }}>
      <Loader2 size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
      <span className="text-[13px]" style={{ color: 'var(--on-surface-variant)' }}>
        Sending voice message…
      </span>
    </div>
  );
}
