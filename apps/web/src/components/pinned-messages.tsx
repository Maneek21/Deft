'use client';
import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { formatShortDate } from '@/lib/time';
import { X, Pin, ChevronDown } from 'lucide-react';
import { stripHtml } from '@/lib/strip-html';

type PinnedMessage = {
  id: string;
  message_id: string;
  content: string;
  author_name: string;
  created_at: string;
  pinned_at: string;
};

type Props = { spaceId: string };

export function PinnedBar({ spaceId }: Props) {
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadPins = async () => {
    try {
      const res = await api.get(`/api/spaces/${spaceId}/pins`);
      if (res.ok) setPins(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadPins(); }, [spaceId]);

  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    const handler = () => loadPins();
    socket.on('pins:updated', handler);
    return () => { socket.off('pins:updated', handler); };
  }, [spaceId]);

  useLayoutEffect(() => {
    if (expanded && barRef.current) {
      const rect = barRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (
        barRef.current && !barRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) setExpanded(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expanded]);

  const handleUnpin = async (messageId: string) => {
    await api.delete(`/api/spaces/${spaceId}/pins/${messageId}`);
    setPins(prev => prev.filter(p => p.message_id !== messageId));
    if (pins.length <= 1) setExpanded(false);
  };

  if (loading || pins.length === 0) return null;

  const latest = pins[0]!;
  const plainContent = stripHtml(latest.content).replace(/\[\[file:[^\]]+\]\]/g, '').trim();

  return (
    <>
      {/* Pinned bar — one step up from chat bg, minimal and clean */}
      <div ref={barRef} className="flex-shrink-0 pinned-bar">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2.5 px-4 h-9 text-left"
        >
          <Pin size={11} strokeWidth={2} style={{ color: 'var(--primary)' }} />
          <span className="text-[0.75rem] truncate flex-1" style={{ color: 'var(--on-surface-variant)' }}>
            <span className="font-medium" style={{ color: 'var(--on-surface)' }}>{latest.author_name}</span>
            <span className="mx-1" style={{ color: 'var(--outline)' }}>·</span>
            {plainContent.slice(0, 80)}
          </span>
          {pins.length > 1 && (
            <span className="text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
              +{pins.length - 1}
            </span>
          )}
          <ChevronDown
            size={11} strokeWidth={2}
            style={{ color: 'var(--outline)', transform: expanded ? 'rotate(180deg)' : 'none', transition: '150ms' }}
          />
        </button>
      </div>

      {/* Dropdown — same tone as the bar, feels like it expands from it */}
      {expanded && dropdownPos && (
        <div
          ref={dropdownRef}
          className="fixed max-h-[320px] overflow-y-auto pinned-dropdown"
          style={{
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            boxShadow: '0px 8px 24px rgba(0, 0, 0, 0.5)',
            zIndex: 9999,
            borderRadius: '0 0 0.375rem 0.375rem',
          }}
        >
          {pins.map((pin, i) => {
            const text = stripHtml(pin.content).replace(/\[\[file:[^\]]+\]\]/g, '').trim();
            return (
              <div
                key={pin.id}
                className="px-4 py-3 flex gap-3 pinned-dropdown-item"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[0.75rem] font-medium" style={{ color: 'var(--on-surface)' }}>
                      {pin.author_name}
                    </span>
                    <span className="text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                      {formatShortDate(pin.created_at)}
                    </span>
                  </div>
                  <p className="text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
                    {text.slice(0, 200)}{text.length > 200 ? '…' : ''}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleUnpin(pin.message_id); }}
                  className="flex-shrink-0 px-2 py-1 rounded text-[0.6875rem] self-start"
                  style={{ color: 'var(--outline)' }}
                >
                  Unpin
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
