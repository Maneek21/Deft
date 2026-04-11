'use client';

import { useEffect, useRef, useState } from 'react';
import type SimplePeer from 'simple-peer';

/**
 * Tracks audio levels for local + remote streams.
 * Returns a Map<userId, boolean> indicating who is currently speaking.
 */
export function useAudioLevels(
  localStream: MediaStream | null,
  localUserId: string | null,
  peers: Map<string, SimplePeer.Instance>,
) {
  const [speakingMap, setSpeakingMap] = useState<Map<string, boolean>>(new Map());
  const ctxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>>(new Map());
  const frameRef = useRef<number>(0);
  const frameCountRef = useRef(0);
  const consecutiveRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Only create AudioContext when we have streams
    if (!localStream && peers.size === 0) return;

    if (!ctxRef.current) {
      try {
        ctxRef.current = new AudioContext();
      } catch {
        return;
      }
    }
    const ctx = ctxRef.current;

    // Setup analysers for each stream
    const setupAnalyser = (userId: string, stream: MediaStream) => {
      if (analysersRef.current.has(userId)) return;
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        // Don't connect to destination (we don't want to hear ourselves)
        analysersRef.current.set(userId, { analyser, source });
      } catch {}
    };

    // Local stream
    if (localStream && localUserId) {
      setupAnalyser(localUserId, localStream);
    }

    // Remote streams from peers
    for (const [userId, peer] of peers) {
      const audioEl = (peer as any)._audioEl as HTMLAudioElement | undefined;
      if (audioEl?.srcObject instanceof MediaStream) {
        setupAnalyser(userId, audioEl.srcObject);
      }
    }

    // Animation loop (throttled to ~15fps)
    const dataArray = new Uint8Array(128);
    let running = true;

    const tick = () => {
      if (!running) return;
      frameCountRef.current++;

      // Only process every 4th frame (~15fps at 60fps)
      if (frameCountRef.current % 4 === 0) {
        let changed = false;
        const newMap = new Map(speakingMap);

        for (const [userId, { analyser }] of analysersRef.current) {
          analyser.getByteTimeDomainData(dataArray);

          // Compute RMS
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const val = (dataArray[i]! - 128) / 128;
            sum += val * val;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          const isSpeaking = rms > 0.05;

          // Debounce: need 3 consecutive frames above threshold
          const count = consecutiveRef.current.get(userId) || 0;
          if (isSpeaking) {
            consecutiveRef.current.set(userId, Math.min(count + 1, 5));
          } else {
            consecutiveRef.current.set(userId, Math.max(count - 1, 0));
          }

          const wasSpeaking = newMap.get(userId) || false;
          const nowSpeaking = (consecutiveRef.current.get(userId) || 0) >= 3;

          if (wasSpeaking !== nowSpeaking) {
            newMap.set(userId, nowSpeaking);
            changed = true;
          }
        }

        if (changed) {
          setSpeakingMap(newMap);
        }
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(frameRef.current);
    };
  }, [localStream, localUserId, peers.size]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const { source } of analysersRef.current.values()) {
        try { source.disconnect(); } catch {}
      }
      analysersRef.current.clear();
      if (ctxRef.current?.state !== 'closed') {
        ctxRef.current?.close().catch(() => {});
      }
    };
  }, []);

  return speakingMap;
}
