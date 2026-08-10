'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import {
  applyHuddleUpdate,
  HUDDLE_RESPONSE_TIMEOUT_MS,
  huddleResponseTimeoutMessage,
  huddlesFromSnapshot,
  removeEndedHuddle,
  shouldCleanupEndedHuddle,
} from '@/lib/huddle-state';
import type {
  ActiveHuddleInfo,
  HuddleClientError,
  HuddleParticipant,
  HuddleSocketError,
  HuddleSummary,
} from '@/lib/huddle-types';
import SimplePeer from 'simple-peer';

type HuddleState = {
  active: boolean;
  huddleId: string | null;
  spaceId: string | null;
  participants: HuddleParticipant[];
  muted: boolean;
  duration: number;
  expanded: boolean;
};

export type HuddleRing = {
  id: string;
  huddle_id: string;
  space_id: string;
  space_name: string;
  created_by_name: string;
  participants: HuddleParticipant[];
  received_at: number;
};

export function useHuddle(enabled: boolean) {
  const [state, setState] = useState<HuddleState>({
    active: false,
    huddleId: null,
    spaceId: null,
    participants: [],
    muted: false,
    duration: 0,
    expanded: false,
  });

  const [activeHuddles, setActiveHuddles] = useState<Map<string, ActiveHuddleInfo>>(new Map());
  const [pendingRings, setPendingRings] = useState<HuddleRing[]>([]);
  const [error, setError] = useState<HuddleClientError | null>(null);
  const [busy, setBusy] = useState(false);

  // ═══ REFS — always-current values for use inside closures ═══
  const activeRef = useRef(false);
  const huddleIdRef = useRef<string | null>(null);
  const spaceIdRef = useRef<string | null>(null);
  const peersRef = useRef<Map<string, SimplePeer.Instance>>(new Map());
  const streamRef = useRef<MediaStream | null>(null);
  const durationRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const responseTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const pendingRef = useRef<{ event: 'huddle:create' | 'huddle:join'; spaceId: string; huddleId?: string } | null>(null);
  const errorIdRef = useRef(0);

  // Keep refs in sync with state
  useEffect(() => { activeRef.current = state.active; }, [state.active]);
  useEffect(() => { huddleIdRef.current = state.huddleId; }, [state.huddleId]);
  useEffect(() => { spaceIdRef.current = state.spaceId; }, [state.spaceId]);

  // ═══ Duration timer ═══
  useEffect(() => {
    if (state.active) {
      durationRef.current = setInterval(() => {
        setState(prev => ({ ...prev, duration: prev.duration + 1 }));
      }, 1000);
    } else {
      if (durationRef.current) clearInterval(durationRef.current);
    }
    return () => { if (durationRef.current) clearInterval(durationRef.current); };
  }, [state.active]);

  // ═══ Create peer — uses refs to avoid stale closures ═══
  const createPeer = useCallback((targetUserId: string, initiator: boolean): SimplePeer.Instance => {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: streamRef.current || undefined,
    });

    peer.on('signal', (signalData) => {
      // Use ref for always-current huddleId
      const hid = huddleIdRef.current;
      if (!hid) return;
      socketRef.current?.emit('huddle:signal', {
        huddle_id: hid,
        target_user_id: targetUserId,
        signal_data: signalData,
      });
    });

    peer.on('stream', (remoteStream) => {
      const audio = new Audio();
      audio.srcObject = remoteStream;
      audio.autoplay = true;
      audio.play().catch((err) => console.warn('Audio autoplay blocked:', err));
      (peer as any)._audioEl = audio;
    });

    peer.on('error', (err) => {
      console.warn('Peer error:', err);
      peersRef.current.delete(targetUserId);
    });

    peer.on('close', () => {
      const audioEl = (peer as any)._audioEl;
      if (audioEl) { audioEl.pause(); audioEl.srcObject = null; }
      peersRef.current.delete(targetUserId);
    });

    peersRef.current.set(targetUserId, peer);
    return peer;
  }, []); // No deps — uses refs for all mutable values

  const cleanup = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      const audioEl = (peer as any)._audioEl;
      if (audioEl) { audioEl.pause(); audioEl.srcObject = null; }
      peer.destroy();
    }
    peersRef.current.clear();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const reportError = useCallback((
    source: HuddleClientError['source'],
    message: string,
    code?: string,
  ) => {
    errorIdRef.current += 1;
    setError({ id: errorIdRef.current, source, message, code });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const clearResponseWatchdog = useCallback(() => {
    if (responseTimerRef.current) {
      clearTimeout(responseTimerRef.current);
      responseTimerRef.current = undefined;
    }
  }, []);

  const resetLocalSession = useCallback(() => {
    activeRef.current = false;
    huddleIdRef.current = null;
    spaceIdRef.current = null;
    pendingRef.current = null;
    clearResponseWatchdog();
    setBusy(false);
    cleanup();
    setState({
      active: false,
      huddleId: null,
      spaceId: null,
      participants: [],
      muted: false,
      duration: 0,
      expanded: false,
    });
  }, [cleanup, clearResponseWatchdog]);

  const armResponseWatchdog = useCallback((pending: NonNullable<typeof pendingRef.current>) => {
    clearResponseWatchdog();
    responseTimerRef.current = setTimeout(() => {
      if (pendingRef.current !== pending) return;
      resetLocalSession();
      reportError('connection', huddleResponseTimeoutMessage(pending.event), 'RESPONSE_TIMEOUT');
    }, HUDDLE_RESPONSE_TIMEOUT_MS);
  }, [clearResponseWatchdog, reportError, resetLocalSession]);

  const acquireMicrophone = useCallback(async (): Promise<MediaStream | null> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      reportError('microphone', 'Voice huddles are not supported by this browser.');
      return null;
    }

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      const message = name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone access is required to join a huddle. Allow access in your browser and try again.'
        : name === 'NotFoundError'
          ? 'No microphone was found. Connect one and try again.'
          : 'Deft could not access your microphone. Check your audio device and try again.';
      reportError('microphone', message, name || undefined);
      return null;
    }
  }, [reportError]);

  // ═══ Socket initialization + all event listeners ═══
  useEffect(() => {
    if (!enabled) return;
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    socketRef.current = getSocket(token);
    const socket = socketRef.current;

    const onJoined = (data: { huddle_id: string; space_id?: string; participants: HuddleParticipant[] }) => {
      const joinedSpaceId = data.space_id ?? pendingRef.current?.spaceId ?? spaceIdRef.current;
      if (!joinedSpaceId) {
        socket.emit('huddle:leave', { huddle_id: data.huddle_id });
        resetLocalSession();
        reportError('server', 'The huddle joined without a valid space. Please try again.', 'INVALID_STATE');
        return;
      }

      activeRef.current = true;
      huddleIdRef.current = data.huddle_id;
      spaceIdRef.current = joinedSpaceId;
      clearResponseWatchdog();
      pendingRef.current = null;
      setBusy(false);
      setError(null);
      setState(prev => ({
        ...prev,
        active: true,
        huddleId: data.huddle_id,
        spaceId: joinedSpaceId,
        participants: data.participants,
        duration: 0,
      }));
      setActiveHuddles(prev => applyHuddleUpdate(prev, {
        huddle_id: data.huddle_id,
        space_id: joinedSpaceId,
        participants: data.participants,
      }));
    };

    const onUserJoined = (data: { huddle_id: string; user_id: string; participants: HuddleParticipant[] }) => {
      if (huddleIdRef.current !== data.huddle_id) return;
      setState(prev => {
        if (prev.huddleId !== data.huddle_id) return prev;
        return { ...prev, participants: data.participants };
      });
      if (streamRef.current) {
        createPeer(data.user_id, true);
      }
    };

    const onUserLeft = (data: { huddle_id: string; user_id: string; participants: HuddleParticipant[] }) => {
      if (huddleIdRef.current !== data.huddle_id) return;
      setState(prev => {
        if (prev.huddleId !== data.huddle_id) return prev;
        return { ...prev, participants: data.participants };
      });
      const peer = peersRef.current.get(data.user_id);
      if (peer) { peer.destroy(); peersRef.current.delete(data.user_id); }
    };

    const onSignal = (data: { huddle_id: string; from_user_id: string; signal_data: any }) => {
      if (!activeRef.current || huddleIdRef.current !== data.huddle_id) return;
      let peer = peersRef.current.get(data.from_user_id);
      if (!peer) {
        peer = createPeer(data.from_user_id, false);
      }
      try { peer.signal(data.signal_data); } catch {}
    };

    const onMuteChanged = (data: { huddle_id?: string; user_id: string; muted: boolean }) => {
      if (data.huddle_id && data.huddle_id !== huddleIdRef.current) return;
      setState(prev => ({
        ...prev,
        participants: prev.participants.map(p =>
          p.user_id === data.user_id ? { ...p, muted: data.muted } : p
        ),
      }));
    };

    const onEnded = (data: { huddle_id: string; space_id?: string }) => {
      // Every client tracks room indicators, but only the matching active call owns our media.
      setActiveHuddles(prev => removeEndedHuddle(prev, data));
      setPendingRings(prev => prev.filter(r => r.huddle_id !== data.huddle_id));
      if (pendingRef.current?.huddleId === data.huddle_id) {
        resetLocalSession();
        reportError('state', 'The huddle ended before you could join it.');
        return;
      }
      if (shouldCleanupEndedHuddle(huddleIdRef.current, data.huddle_id)) {
        resetLocalSession();
      }
    };

    const onExists = (data: { huddle_id: string }) => {
      if (!pendingRef.current || activeRef.current) return;
      pendingRef.current = { ...pendingRef.current, event: 'huddle:join', huddleId: data.huddle_id };
      armResponseWatchdog(pendingRef.current);
      socket.emit('huddle:join', { huddle_id: data.huddle_id });
    };

    const onHuddleStarted = (data: { huddle_id: string; space_id: string; participants: HuddleParticipant[] }) => {
      setActiveHuddles(prev => applyHuddleUpdate(prev, data));
    };

    const onHuddleRing = (data: { huddle_id: string; space_id: string; space_name: string; created_by_name: string; participants: HuddleParticipant[] }) => {
      setActiveHuddles(prev => applyHuddleUpdate(prev, data));
      if (activeRef.current) return;
      setPendingRings(prev => prev.some(ring => ring.huddle_id === data.huddle_id)
        ? prev
        : [...prev, {
            id: `${data.huddle_id}-${Date.now()}`,
            ...data,
            received_at: Date.now(),
          }]);
    };

    const onHuddleUpdated = (data: { huddle_id: string; space_id?: string; participants: HuddleParticipant[] }) => {
      setActiveHuddles(prev => applyHuddleUpdate(prev, data));
    };

    const onHuddleSnapshot = (data: { huddles: HuddleSummary[] }) => {
      setActiveHuddles(previous => {
        const next = huddlesFromSnapshot(Array.isArray(data?.huddles) ? data.huddles : []);
        const activeSpaceId = spaceIdRef.current;
        const activeHuddleId = huddleIdRef.current;
        if (activeRef.current && activeSpaceId && activeHuddleId && !next.has(activeSpaceId)) {
          const current = previous.get(activeSpaceId);
          if (current?.huddle_id === activeHuddleId) next.set(activeSpaceId, current);
        }
        return next;
      });
    };

    const onHuddleError = (data: HuddleSocketError) => {
      reportError('server', data.message || 'The huddle request failed. Please try again.', data.code);
      if ((data.event === 'huddle:create' || data.event === 'huddle:join') && pendingRef.current) {
        resetLocalSession();
      }
      if (data.event === 'huddle:leave') {
        socket.emit('huddle:list', {});
      }
    };

    const requestHuddleSnapshot = () => socket.emit('huddle:list', {});

    const onSocketDisconnect = () => {
      if (!activeRef.current && !pendingRef.current) return;
      resetLocalSession();
      reportError('connection', 'The huddle disconnected. Reconnect and join again.');
    };

    socket.on('huddle:joined', onJoined);
    socket.on('huddle:user_joined', onUserJoined);
    socket.on('huddle:user_left', onUserLeft);
    socket.on('huddle:signal', onSignal);
    socket.on('huddle:mute_changed', onMuteChanged);
    socket.on('huddle:ended', onEnded);
    socket.on('huddle:exists', onExists);
    socket.on('huddle:started', onHuddleStarted);
    socket.on('huddle:updated', onHuddleUpdated);
    socket.on('huddle:ring', onHuddleRing);
    socket.on('huddle:snapshot', onHuddleSnapshot);
    socket.on('huddle:error', onHuddleError);
    socket.on('connect', requestHuddleSnapshot);
    socket.on('disconnect', onSocketDisconnect);

    if (socket.connected) requestHuddleSnapshot();

    return () => {
      socket.off('huddle:joined', onJoined);
      socket.off('huddle:user_joined', onUserJoined);
      socket.off('huddle:user_left', onUserLeft);
      socket.off('huddle:signal', onSignal);
      socket.off('huddle:mute_changed', onMuteChanged);
      socket.off('huddle:ended', onEnded);
      socket.off('huddle:exists', onExists);
      socket.off('huddle:started', onHuddleStarted);
      socket.off('huddle:updated', onHuddleUpdated);
      socket.off('huddle:ring', onHuddleRing);
      socket.off('huddle:snapshot', onHuddleSnapshot);
      socket.off('huddle:error', onHuddleError);
      socket.off('connect', requestHuddleSnapshot);
      socket.off('disconnect', onSocketDisconnect);
      clearResponseWatchdog();
      cleanup();
    };
  }, [armResponseWatchdog, clearResponseWatchdog, createPeer, cleanup, enabled, reportError, resetLocalSession]);

  // ═══ Actions ═══

  const startHuddle = useCallback(async (spaceId: string) => {
    if (!enabled) return;
    if (activeRef.current) {
      reportError(
        'state',
        spaceIdRef.current === spaceId
          ? 'You are already in this huddle.'
          : 'Leave your current huddle before starting another one.',
      );
      return;
    }
    if (pendingRef.current) {
      reportError('state', 'A huddle connection is already in progress.');
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) {
      reportError('connection', 'Chat is reconnecting. Try starting the huddle again in a moment.');
      return;
    }

    const pending = { event: 'huddle:create' as const, spaceId };
    pendingRef.current = pending;
    setBusy(true);
    setError(null);
    const stream = await acquireMicrophone();
    if (!stream) {
      if (pendingRef.current === pending) pendingRef.current = null;
      setBusy(false);
      return;
    }
    if (pendingRef.current !== pending || !socket.connected) {
      stream.getTracks().forEach(track => track.stop());
      if (pendingRef.current === pending) {
        pendingRef.current = null;
        setBusy(false);
        reportError('connection', 'Chat disconnected before the huddle could start. Try again.');
      }
      return;
    }

    streamRef.current = stream;
    spaceIdRef.current = spaceId;
    setState(prev => ({ ...prev, spaceId }));
    setPendingRings(prev => prev.filter(r => r.space_id !== spaceId));
    armResponseWatchdog(pending);
    socket.emit('huddle:create', { space_id: spaceId });
  }, [acquireMicrophone, armResponseWatchdog, enabled, reportError]);

  const joinHuddle = useCallback(async (huddleId: string, spaceId: string) => {
    if (!enabled) return;
    if (activeRef.current) {
      if (huddleIdRef.current === huddleId) return;
      reportError('state', 'Leave your current huddle before joining another one.');
      return;
    }
    if (pendingRef.current) {
      reportError('state', 'A huddle connection is already in progress.');
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) {
      reportError('connection', 'Chat is reconnecting. Try joining the huddle again in a moment.');
      return;
    }

    const pending = { event: 'huddle:join' as const, spaceId, huddleId };
    pendingRef.current = pending;
    setBusy(true);
    setError(null);
    const stream = await acquireMicrophone();
    if (!stream) {
      if (pendingRef.current === pending) pendingRef.current = null;
      setBusy(false);
      return;
    }
    if (pendingRef.current !== pending || !socket.connected) {
      stream.getTracks().forEach(track => track.stop());
      if (pendingRef.current === pending) {
        pendingRef.current = null;
        setBusy(false);
        reportError('connection', 'Chat disconnected before the huddle could join. Try again.');
      }
      return;
    }

    streamRef.current = stream;
    spaceIdRef.current = spaceId;
    setState(prev => ({ ...prev, spaceId }));
    setPendingRings(prev => prev.filter(r => r.space_id !== spaceId));
    armResponseWatchdog(pending);
    socket.emit('huddle:join', { huddle_id: huddleId });
  }, [acquireMicrophone, armResponseWatchdog, enabled, reportError]);

  const joinHuddleBySpace = useCallback(async (spaceId: string) => {
    if (!enabled) return;
    const info = activeHuddles.get(spaceId);
    let huddleId = info?.huddle_id;
    if (!huddleId) {
      const ring = pendingRings.find(r => r.space_id === spaceId);
      huddleId = ring?.huddle_id;
    }
    if (!huddleId) {
      reportError('state', 'This huddle is no longer available. Refreshing active huddles…');
      socketRef.current?.emit('huddle:list', {});
      return;
    }
    await joinHuddle(huddleId, spaceId);
  }, [activeHuddles, enabled, pendingRings, joinHuddle, reportError]);

  const leaveHuddle = useCallback(() => {
    const hid = huddleIdRef.current;
    if (hid) {
      socketRef.current?.emit('huddle:leave', { huddle_id: hid });
    }
    // Keep the room indicator. The server's space-aware update will preserve a
    // Join affordance when other participants remain, or remove an empty room.
    resetLocalSession();
  }, [resetLocalSession]);

  const toggleMute = useCallback(() => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        setState(prev => {
          const newMuted = !prev.muted;
          audioTrack.enabled = !newMuted;
          socketRef.current?.emit('huddle:mute', { huddle_id: huddleIdRef.current, muted: newMuted });
          return { ...prev, muted: newMuted };
        });
      }
    }
  }, []);

  const toggleExpanded = useCallback(() => {
    setState(prev => ({ ...prev, expanded: !prev.expanded }));
  }, []);

  const dismissRing = useCallback((ringId: string) => {
    setPendingRings(prev => prev.filter(r => r.id !== ringId));
  }, []);

  const getStreams = useCallback(() => ({
    localStream: streamRef.current,
    peers: peersRef.current,
  }), []);

  return {
    ...state,
    busy,
    error,
    activeHuddles,
    pendingRings,
    startHuddle,
    joinHuddle,
    joinHuddleBySpace,
    leaveHuddle,
    toggleMute,
    toggleExpanded,
    dismissRing,
    clearError,
    getStreams,
  };
}
