/**
 * Block 1.10 — reasoning trace hook.
 *
 * Subscribes to the `agent:trace` Socket.io event fanned out by the API's
 * gateway-trace-forwarder. Buffers events per sessionId so a chat message
 * component can render the full tool → result tree for its reply.
 *
 * Usage:
 *   const trace = useReasoningTrace(sessionId);
 *   if (trace.length > 0) renderShowTraceButton();
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';

export type TraceEvent = {
  sessionId: string;
  employee_id: string;
  kind: 'session.tool' | 'session.message';
  payload: Record<string, unknown>;
  at: string;
};

export function useReasoningTrace(sessionId: string | null | undefined): TraceEvent[] {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!sessionId) return undefined;
    const token = typeof window !== 'undefined'
      ? window.localStorage.getItem('deft-access-token') ?? ''
      : '';
    if (!token) return undefined;
    const socket = getSocket(token);

    const onTrace = (evt: TraceEvent) => {
      if (!mountedRef.current) return;
      if (evt.sessionId !== sessionId) return;
      setEvents((prev) => [...prev, evt]);
    };
    socket.on('agent:trace', onTrace);
    return () => {
      socket.off('agent:trace', onTrace);
    };
  }, [sessionId]);

  return events;
}
