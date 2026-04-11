'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, FileText, Check, AlertTriangle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';

type ClipSummary = {
  tldr: string;
  decisions: string[];
  actions: string[];
  blockers: string[];
};

type ClipData = {
  id: string;
  status: string;
  duration_s: number | null;
  transcript: string | null;
  summary: ClipSummary | null;
  segments: { start: number; end: number; text: string }[] | null;
  created_by: string;
  mode: string;
  whisper_model: string | null;
  error: string | null;
  created_at: string;
};

type ClipCardProps = {
  clipId: string;
  clipStatus?: string; // from message metadata for initial render
  clipSummary?: ClipSummary;
  clipDuration?: number;
  clipUserName?: string;
  clipHasTranscript?: boolean;
};

export function ClipCard({ clipId, clipStatus, clipSummary, clipDuration, clipUserName, clipHasTranscript }: ClipCardProps) {
  const [clip, setClip] = useState<ClipData | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval>>(undefined);

  // Status from metadata or fetched clip
  const status = clip?.status || clipStatus || 'processing';
  const summary = clip?.summary || clipSummary;
  const durationS = clip?.duration_s || clipDuration || 0;

  // Fetch full clip data when needed (transcript view or if no metadata)
  const fetchClip = useCallback(async () => {
    if (clip) return;
    setLoading(true);
    try {
      const res = await api.get(`/api/clips/${clipId}`);
      if (res.ok) {
        setClip(await res.json());
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [clipId, clip]);

  // Auto-fetch if we don't have summary data from metadata
  useEffect(() => {
    if (status === 'ready' && !summary) {
      fetchClip();
    }
  }, [status, summary, fetchClip]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const togglePlay = useCallback(() => {
    if (!audioRef.current) {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const audio = new Audio(`${apiUrl}/api/clips/${clipId}/audio`);
      audioRef.current = audio;

      audio.onended = () => {
        setPlaying(false);
        setProgress(0);
        setCurrentTime(0);
        if (progressInterval.current) clearInterval(progressInterval.current);
      };

      audio.onplay = () => {
        progressInterval.current = setInterval(() => {
          if (audio.duration) {
            setProgress((audio.currentTime / audio.duration) * 100);
            setCurrentTime(audio.currentTime);
          }
        }, 100);
      };

      audio.onpause = () => {
        if (progressInterval.current) clearInterval(progressInterval.current);
      };
    }

    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play();
      setPlaying(true);
    }
  }, [clipId, playing]);

  const seekTo = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !audioRef.current.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = ratio * audioRef.current.duration;
    setProgress(ratio * 100);
    setCurrentTime(audioRef.current.currentTime);
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (progressInterval.current) clearInterval(progressInterval.current);
    };
  }, []);

  // ─── Processing state ───
  if (status === 'processing' || status === 'transcribing' || status === 'summarizing' || status === 'uploading') {
    return (
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-container)', maxWidth: '420px' }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(var(--primary-rgb, 124,107,79), 0.12)' }}>
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>
              Audio clip
            </p>
            <p className="text-[11px]" style={{ color: 'var(--outline)' }}>
              {status === 'transcribing' ? 'Transcribing...' :
               status === 'summarizing' ? 'Generating summary...' :
               'Processing...'}
            </p>
          </div>
        </div>
        <div className="h-1" style={{ background: 'var(--surface-container-high)' }}>
          <div className="h-full rounded-r-full animate-pulse"
            style={{ background: 'var(--primary-container)', width: status === 'summarizing' ? '75%' : '40%' }} />
        </div>
      </div>
    );
  }

  // ─── Failed state ───
  if (status === 'failed') {
    return (
      <div className="rounded-xl overflow-hidden px-4 py-3 flex items-center gap-3"
        style={{ background: 'var(--surface-container)', maxWidth: '420px' }}>
        <AlertTriangle size={16} style={{ color: 'var(--status-amber)' }} />
        <div>
          <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>Clip processing failed</p>
          <p className="text-[11px]" style={{ color: 'var(--outline)' }}>{clip?.error || 'An error occurred'}</p>
        </div>
      </div>
    );
  }

  // ─── Ready state — full clip card ───
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--surface-container)', maxWidth: '420px' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <div className="w-2 h-2 rounded-full" style={{ background: 'var(--status-green)' }} />
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--outline)' }}>
          Audio clip
        </span>
        {clipUserName && (
          <span className="text-[11px]" style={{ color: 'var(--outline)' }}>
            · {clipUserName}
          </span>
        )}
        {durationS > 0 && (
          <span className="text-[11px] font-mono" style={{ color: 'var(--outline)' }}>
            · {formatTime(durationS)}
          </span>
        )}
      </div>

      {/* Summary */}
      {summary?.tldr && (
        <div className="px-4 py-2">
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--on-surface)' }}>
            {summary.tldr}
          </p>
        </div>
      )}

      {/* Decisions, Actions, Blockers */}
      {summary && (summary.decisions.length > 0 || summary.actions.length > 0 || summary.blockers.length > 0) && (
        <div className="px-4 pb-2 space-y-1.5">
          {summary.decisions.map((d, i) => (
            <div key={`d-${i}`} className="flex items-start gap-2 text-[12px]"
              style={{ color: 'var(--on-surface-variant)' }}>
              <Check size={13} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--status-green)' }} />
              <span>{d}</span>
            </div>
          ))}
          {summary.actions.map((a, i) => (
            <div key={`a-${i}`} className="flex items-start gap-2 text-[12px]"
              style={{ color: 'var(--on-surface-variant)' }}>
              <span className="flex-shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>→</span>
              <span>{a}</span>
            </div>
          ))}
          {summary.blockers.map((b, i) => (
            <div key={`b-${i}`} className="flex items-start gap-2 text-[12px]"
              style={{ color: 'var(--on-surface-variant)' }}>
              <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--status-amber)' }} />
              <span>{b}</span>
            </div>
          ))}
        </div>
      )}

      {/* Player */}
      <div className="px-4 py-2">
        <div className="flex items-center gap-2.5">
          <button onClick={togglePlay}
            className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--primary-container)' }}>
            {playing
              ? <Pause size={14} fill="white" stroke="white" />
              : <Play size={14} fill="white" stroke="white" style={{ marginLeft: '1px' }} />
            }
          </button>

          {/* Waveform / progress bar */}
          <div className="flex-1 h-8 flex items-center cursor-pointer" onClick={seekTo}>
            <div className="w-full h-1.5 rounded-full relative" style={{ background: 'var(--surface-container-high)' }}>
              <div className="h-full rounded-full transition-all duration-100"
                style={{ background: 'var(--primary-container)', width: `${progress}%` }} />
            </div>
          </div>

          {/* Time */}
          <span className="text-[11px] font-mono tabular-nums flex-shrink-0" style={{ color: 'var(--outline)' }}>
            {playing ? formatTime(currentTime) : formatTime(durationS)}
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 px-3 pb-2.5">
        <button
          onClick={() => {
            if (!clip) fetchClip();
            setShowTranscript(!showTranscript);
          }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
          style={{
            color: showTranscript ? 'var(--primary)' : 'var(--outline)',
            background: showTranscript ? 'var(--bg-active)' : 'transparent',
          }}
        >
          <FileText size={12} />
          Transcript
          {showTranscript ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
      </div>

      {/* Transcript panel */}
      {showTranscript && (
        <div className="border-t px-4 py-3 max-h-[200px] overflow-y-auto"
          style={{ borderColor: 'var(--ghost-border)' }}>
          {loading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 size={12} className="animate-spin" style={{ color: 'var(--outline)' }} />
              <span className="text-[12px]" style={{ color: 'var(--outline)' }}>Loading transcript...</span>
            </div>
          ) : clip?.segments && clip.segments.length > 0 ? (
            <div className="space-y-2">
              {(clip.segments as { start: number; end: number; text: string }[]).map((seg, i) => (
                <div key={i} className="flex gap-2">
                  <button
                    className="text-[10px] font-mono flex-shrink-0 mt-0.5 tabular-nums"
                    style={{ color: 'var(--primary)', minWidth: '32px' }}
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.currentTime = seg.start;
                        if (!playing) { audioRef.current.play(); setPlaying(true); }
                      }
                    }}
                  >
                    {formatTime(seg.start)}
                  </button>
                  <span className="text-[12px] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                    {seg.text}
                  </span>
                </div>
              ))}
            </div>
          ) : clip?.transcript ? (
            <p className="text-[12px] leading-relaxed whitespace-pre-wrap"
              style={{ color: 'var(--on-surface-variant)' }}>
              {clip.transcript}
            </p>
          ) : (
            <p className="text-[12px]" style={{ color: 'var(--outline)' }}>
              No transcript available.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
