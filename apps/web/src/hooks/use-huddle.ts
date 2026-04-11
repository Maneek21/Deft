'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import SimplePeer from 'simple-peer';

type Participant = {
  user_id: string;
  user_name: string;
  muted: boolean;
  socket_id: string;
};

type ActiveHuddleInfo = {
  huddle_id: string;
  participants: Participant[];
};

type HuddleState = {
  active: boolean;
  huddleId: string | null;
  spaceId: string | null;
  participants: Participant[];
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
  participants: Participant[];
  received_at: number;
};

export function useHuddle() {
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

  // ═══ REFS — always-current values for use inside closures ═══
  const activeRef = useRef(false);
  const huddleIdRef = useRef<string | null>(null);
  const spaceIdRef = useRef<string | null>(null);
  const peersRef = useRef<Map<string, SimplePeer.Instance>>(new Map());
  const streamRef = useRef<MediaStream | null>(null);
  const durationRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);

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

  // ═══ Socket initialization + all event listeners ═══
  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    socketRef.current = getSocket(token);
    const socket = socketRef.current;

    const onJoined = (data: { huddle_id: string; participants: Participant[] }) => {
      setState(prev => ({
        ...prev,
        active: true,
        huddleId: data.huddle_id,
        participants: data.participants,
        duration: 0,
      }));
    };

    const onUserJoined = (data: { huddle_id: string; user_id: string; participants: Participant[] }) => {
      setState(prev => {
        if (prev.huddleId !== data.huddle_id) return prev;
        return { ...prev, participants: data.participants };
      });
      if (streamRef.current) {
        createPeer(data.user_id, true);
      }
    };

    const onUserLeft = (data: { huddle_id: string; user_id: string; participants: Participant[] }) => {
      setState(prev => {
        if (prev.huddleId !== data.huddle_id) return prev;
        return { ...prev, participants: data.participants };
      });
      const peer = peersRef.current.get(data.user_id);
      if (peer) { peer.destroy(); peersRef.current.delete(data.user_id); }
    };

    const onSignal = (data: { huddle_id: string; from_user_id: string; signal_data: any }) => {
      let peer = peersRef.current.get(data.from_user_id);
      if (!peer) {
        peer = createPeer(data.from_user_id, false);
      }
      try { peer.signal(data.signal_data); } catch {}
    };

    const onMuteChanged = (data: { user_id: string; muted: boolean }) => {
      setState(prev => ({
        ...prev,
        participants: prev.participants.map(p =>
          p.user_id === data.user_id ? { ...p, muted: data.muted } : p
        ),
      }));
    };

    const onEnded = (data: { huddle_id: string; space_id?: string }) => {
      // Always clean up activeHuddles — try by space_id first, then scan by huddle_id
      setActiveHuddles(prev => {
        const m = new Map(prev);
        if (data.space_id) {
          m.delete(data.space_id);
        } else {
          // Scan for the huddle_id and remove
          for (const [spaceId, info] of m) {
            if (info.huddle_id === data.huddle_id) { m.delete(spaceId); break; }
          }
        }
        return m;
      });
      setPendingRings(prev => prev.filter(r => r.huddle_id !== data.huddle_id));
      setState(prev => {
        if (prev.huddleId !== data.huddle_id) return prev;
        return { active: false, huddleId: null, spaceId: null, participants: [], muted: false, duration: 0, expanded: false };
      });
      cleanup();
    };

    const onExists = (data: { huddle_id: string }) => {
      socket.emit('huddle:join', { huddle_id: data.huddle_id });
    };

    const onHuddleStarted = (data: { huddle_id: string; space_id: string; participants: Participant[] }) => {
      setActiveHuddles(prev => new Map(prev).set(data.space_id, { huddle_id: data.huddle_id, participants: data.participants }));
    };

    const onHuddleRing = (data: { huddle_id: string; space_id: string; space_name: string; created_by_name: string; participants: Participant[] }) => {
      setActiveHuddles(prev => new Map(prev).set(data.space_id, { huddle_id: data.huddle_id, participants: data.participants }));
      if (activeRef.current) return;
      setPendingRings(prev => [...prev, {
        id: `${data.huddle_id}-${Date.now()}`,
        ...data,
        received_at: Date.now(),
      }]);
    };

    const onHuddleUpdated = (data: { huddle_id: string; participants: Participant[] }) => {
      setActiveHuddles(prev => {
        const m = new Map(prev);
        for (const [spaceId, info] of m) {
          if (info.huddle_id === data.huddle_id) {
            if (data.participants.length === 0) {
              // No participants left — remove indicator immediately
              m.delete(spaceId);
            } else {
              m.set(spaceId, { ...info, participants: data.participants });
            }
            break;
          }
        }
        return m;
      });
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
    };
  }, [createPeer, cleanup]);

  // ═══ Actions ═══

  const startHuddle = useCallback(async (spaceId: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      setState(prev => ({ ...prev, spaceId }));
      setPendingRings(prev => prev.filter(r => r.space_id !== spaceId));
      socketRef.current?.emit('huddle:create', { space_id: spaceId });
    } catch (err) {
      console.error('Failed to get audio:', err);
    }
  }, []);

  const joinHuddle = useCallback(async (huddleId: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      socketRef.current?.emit('huddle:join', { huddle_id: huddleId });
    } catch (err) {
      console.error('Failed to get audio:', err);
    }
  }, []);

  const joinHuddleBySpace = useCallback(async (spaceId: string) => {
    const info = activeHuddles.get(spaceId);
    let huddleId = info?.huddle_id;
    if (!huddleId) {
      const ring = pendingRings.find(r => r.space_id === spaceId);
      huddleId = ring?.huddle_id;
    }
    if (huddleId) {
      setState(prev => ({ ...prev, spaceId }));
      setPendingRings(prev => prev.filter(r => r.space_id !== spaceId));
      await joinHuddle(huddleId);
    }
  }, [activeHuddles, pendingRings, joinHuddle]);

  const leaveHuddle = useCallback(() => {
    const hid = huddleIdRef.current;
    const sid = spaceIdRef.current;
    if (hid) {
      socketRef.current?.emit('huddle:leave', { huddle_id: hid });
    }
    // Immediately clear local indicators (don't wait for server grace timer)
    if (sid) {
      setActiveHuddles(prev => { const m = new Map(prev); m.delete(sid); return m; });
    }
    cleanup();
    setState({ active: false, huddleId: null, spaceId: null, participants: [], muted: false, duration: 0, expanded: false });
  }, [cleanup]);

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
    activeHuddles,
    pendingRings,
    startHuddle,
    joinHuddle,
    joinHuddleBySpace,
    leaveHuddle,
    toggleMute,
    toggleExpanded,
    dismissRing,
    getStreams,
  };
}
